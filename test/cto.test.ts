import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { mergePolicy, parsePolicy } from '../src/policies.js';
import { OrcoError, type Participant, Store } from '../src/store.js';

let store: Store;
let clock: number;
let cto: Participant;
let ana: Participant;
let ben: Participant;
let vic: Participant;
let anaBot: Participant;
let benBot: Participant;

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as OrcoError).code;
  }
  return 'ok';
};

beforeEach(() => {
  clock = Date.parse('2026-10-14T12:00:00Z');
  store = new Store(openDatabase(':memory:'), { now: () => clock, digest: { cron: '0 9 * * 1', tz: 'UTC' } });
  cto = store.createUser('cto').participant;
  ana = store.createUser('ana').participant;
  ben = store.createUser('ben').participant;
  vic = store.createUser('vic').participant;
  anaBot = store.createAgent('ana', 'ana-bot').participant;
  benBot = store.createAgent('ben', 'ben-bot').participant;
  store.createProject(ana, 'api');
  store.createProject(ben, 'web');
});

describe('roles and groups', () => {
  it('makes the first person an org admin and project creators project admins', () => {
    assert.ok(store.isOrgAdmin(cto));
    assert.ok(!store.isOrgAdmin(ana));
    assert.equal(store.roleIn(ana, store.visibleProject(ana, 'api').id), 'admin');
    assert.equal(store.roleIn(anaBot, store.visibleProject(ana, 'api').id), 'admin', 'an agent has its owner role');
    assert.equal(code(() => store.setOrgAdmin('cto', false)), 'conflict', 'keeps one org admin');
  });

  it('lets project admins manage members, keeps an admin, and makes viewers read-only', () => {
    store.addMember(ana, 'api', 'vic', 'viewer');
    store.addMember(ana, 'api', 'ben');
    assert.equal(code(() => store.addMember(ben, 'api', 'vic', 'member')), 'forbidden', 'members do not manage members');
    assert.equal(code(() => store.removeMember(ana, 'api', 'ana')), 'conflict', 'the last admin stays');
    assert.equal(code(() => store.addMember(anaBot, 'api', 'ben', 'admin')), 'forbidden', 'agents do not hand out admin');

    // Viewers read but do not write, and their agents cannot take tasks there.
    store.createAgent('vic', 'vic-bot');
    assert.ok(store.read(vic, 'api/general').length >= 0);
    assert.equal(code(() => store.post(vic, 'api/general', 'hello')), 'forbidden');
    assert.equal(code(() => store.tickets.create(vic, 'api', { title: 'nope' })), 'forbidden');
    assert.equal(code(() => store.tasks.create(ana, { agent: 'vic-bot', room: 'api/general', request: 'x' })), 'forbidden');
    store.addMember(ana, 'api', 'vic', 'member');
    store.post(vic, 'api/general', 'now I can talk');
    assert.deepEqual(store.access(ana, 'api').members.map((m) => `${m.name}:${m.role}`), ['ana:admin', 'ben:member', 'vic:member']);
  });

  it('gives groups roles in projects and pings their members on @mention', () => {
    assert.equal(code(() => store.groups.create(ana, 'backend')), 'forbidden', 'org admins manage groups');
    store.groups.create(cto, 'backend', ['ben', 'vic']);
    assert.equal(code(() => store.createUser('backend')), 'conflict');
    assert.equal(code(() => store.room(vic, 'api/general')), 'not_found');
    store.groups.setProjectRole(ana, 'api', 'backend', 'member');
    assert.equal(store.room(vic, 'api/general').ref, 'api/general');
    const message = store.post(ana, 'api/general', '@backend please look at the deploy');
    assert.deepEqual([...message.mentions].sort(), ['ben', 'vic']);
    store.groups.removeMember(cto, 'backend', 'vic');
    assert.equal(code(() => store.room(vic, 'api/general')), 'not_found');
  });

  it('keeps Orco itself out of lists and sign-ins', () => {
    assert.equal(code(() => store.createUser('orco')), 'invalid');
    const system = store.system()!;
    assert.ok(store.isSystem(system));
    assert.ok(!store.listParticipants().some((p) => p.name === 'orco'));
    assert.equal(code(() => store.rotateToken('orco')), 'not_found');
  });
});

describe('budgets and the kill switch', () => {
  it('warns at 80%, then holds new tasks for the budget holder', () => {
    store.controls.setBudget(ana, 'project', 'api', 1000);
    assert.equal(code(() => store.controls.setBudget(ben, 'project', 'api', 1000)), 'not_found');
    const first = store.tasks.create(ana, { agent: 'ana-bot', room: 'api/general', request: 'index' });
    store.tasks.update(anaBot, first.id, 'accepted');
    store.tasks.addUsage(first.id, 850, 1000);
    assert.ok(store.read(ana, 'api/general', { threadId: first.messageId }).some((m) => m.text.includes('85% of its monthly budget')));
    store.tasks.addUsage(first.id, 200, 0);
    assert.ok(store.read(ana, 'api/general', { threadId: first.messageId }).some((m) => m.text.includes('has used its monthly budget')));
    assert.equal(store.controls.budgets(ana)[0]!.percent, 105);

    // Ben's request now waits for Ana; Ana's own request goes through.
    store.addMember(ana, 'api', 'ben');
    const held = store.tasks.create(ben, { agent: 'ana-bot', room: 'api/general', request: 'more work' });
    assert.equal(held.state, 'awaiting_approval');
    const approval = store.approvals.list(ana).find((a) => a.messageId === held.messageId)!;
    assert.match(approval.summary, /^Over budget/);
    store.approvals.decide(ana, approval.id, 'approved', undefined, { alwaysAllow: true });
    assert.equal(store.tasks.get(ana, held.id).state, 'requested');
    assert.equal(store.tasks.create(ana, { agent: 'ana-bot', room: 'api/general', request: 'mine' }).state, 'requested');
  });

  it('pauses agents: no accepting, posting or new work, but they can let go of tasks', () => {
    const t = store.tasks.create(ana, { agent: 'ana-bot', room: 'api/general', request: 'go' });
    assert.equal(code(() => store.controls.pause(ana, 'all', null)), 'forbidden', 'org admins pause everything');
    store.controls.pause(ana, 'project', 'api', 'incident');
    assert.equal(code(() => store.tasks.update(anaBot, t.id, 'accepted')), 'forbidden');
    assert.equal(code(() => store.post(anaBot, 'api/general', 'still here')), 'forbidden');
    assert.equal(code(() => store.tickets.create(anaBot, 'api', { title: 'x' })), 'forbidden');
    assert.equal(store.controls.pausedFor(anaBot, store.visibleProject(ana, 'api').id)?.reason, 'incident');
    store.tasks.update(anaBot, t.id, 'declined', 'paused');
    store.controls.resume(ana, 'project', 'api');
    store.post(anaBot, 'api/general', 'back');

    store.controls.pause(cto, 'all', null, 'cost spike');
    assert.equal(code(() => store.post(benBot, 'web/general', 'hi')), 'forbidden');
    assert.equal(store.controls.pauses(ben).length, 1);
    store.controls.resume(cto, 'all', null);
    store.controls.pause(ana, 'agent', 'ana-bot');
    assert.equal(code(() => store.post(anaBot, 'api/general', 'hi')), 'forbidden');
    store.post(benBot, 'web/general', 'not me');
  });
});

describe('policies', () => {
  it('lets projects tighten the org policy but never loosen it', () => {
    assert.equal(code(() => store.policies.set(ana, null, parsePolicy({ rules: ['x'] }))), 'forbidden');
    store.policies.set(cto, null, parsePolicy({ rules: ['Never push to main'], approval_required: ['deploy to production'], max_task_cents: 500, allowed_agents: ['ana-bot', 'ben-bot'] }));
    assert.equal(code(() => store.policies.set(ana, 'api', parsePolicy({ max_task_cents: 900 }))), 'invalid');
    assert.equal(code(() => store.policies.set(ana, 'api', parsePolicy({ allowed_agents: ['ana-bot', 'nobody'] }))), 'invalid');
    store.policies.set(ana, 'api', parsePolicy({ rules: ['Run the tests'], default_task_cents: 200, allowed_agents: ['ana-bot'] }));
    const view = store.policies.view(ana, 'api');
    assert.deepEqual(view.effective.rules, ['Never push to main', 'Run the tests']);
    assert.deepEqual(view.effective.allowedAgents, ['ana-bot']);

    // Enforced on new tasks: who may take them, and their budget.
    store.addMember(ana, 'api', 'ben');
    assert.equal(code(() => store.tasks.create(ana, { agent: 'ben-bot', room: 'api/general', request: 'x' })), 'forbidden');
    assert.equal(store.tasks.create(ana, { agent: 'ana-bot', room: 'api/general', request: 'x' }).budget?.cents, 200);
    assert.equal(code(() => store.tasks.create(ana, { agent: 'ana-bot', room: 'api/general', request: 'x', budgetCents: 600 })), 'forbidden');
    const rules = store.policies.rulesFor(store.visibleProject(ana, 'api').id);
    assert.ok(rules.some((r) => r.includes('request_approval') && r.includes('deploy to production')));
    assert.deepEqual(mergePolicy(parsePolicy({ max_task_minutes: 60 }), parsePolicy({ max_task_minutes: 30, default_task_minutes: 90 })).defaultTaskMinutes, 30);
  });
});

describe('decision log', () => {
  it('records decisions people make, supersedes them, and serves them to agents', () => {
    assert.equal(code(() => store.decisions.record(anaBot, { project: 'api', title: 'x', decision: 'y' })), 'forbidden');
    assert.equal(code(() => store.decisions.record(ana, { project: null, title: 'x', decision: 'y' })), 'forbidden');
    const old = store.decisions.record(ana, { project: 'api', title: 'Database', decision: 'Use SQLite', options: ['SQLite', 'Postgres'], tags: ['Storage'] });
    store.decisions.record(cto, { project: null, title: 'Licenses', decision: 'Apache-2.0 for new repos' });
    const replaced = store.decisions.record(ana, { project: 'api', title: 'Database', decision: 'Use Postgres for multi-node' }, old.id);
    assert.equal(store.decisions.get(ana, old.id).supersededBy, replaced.id);
    assert.deepEqual(store.decisions.list(anaBot, { project: 'api' }).map((d) => d.title), ['Database', 'Licenses']);
    assert.equal(store.decisions.list(ana, { tag: 'storage', all: true }).length, 1);
    assert.equal(store.decisions.list(ana, { query: 'postgres' })[0]!.id, replaced.id);
    assert.equal(code(() => store.decisions.get(ben, old.id)), 'not_found');
    assert.equal(store.decisions.relevantFor(store.visibleProject(ana, 'api').id).length, 2);
  });
});

describe('portfolio, roadmap and digests', () => {
  it('flags red CI, late and at-risk milestones that wait on other projects', () => {
    store.addMember(ben, 'web', 'ana');
    store.tickets.createMilestone(ana, 'api', { name: 'v2', targetDate: '2026-10-20' });
    store.tickets.createMilestone(ben, 'web', { name: 'launch', targetDate: '2026-11-30' });
    store.tickets.createMilestone(ben, 'web', { name: 'old', targetDate: '2026-10-01' });
    const apiTicket = store.tickets.create(ana, 'api', { title: 'Endpoint', milestone: 'v2' }).ticket;
    const webTicket = store.tickets.create(ben, 'web', { title: 'Design', milestone: 'launch' }).ticket;
    store.tickets.create(ben, 'web', { title: 'Leftover', milestone: 'old' });
    store.tickets.update(ana, apiTicket.ref, { blockedByAdd: [webTicket.ref] });

    const roadmap = store.portfolios.roadmap(cto);
    const v2 = roadmap.find((m) => m.name === 'v2')!;
    assert.equal(v2.status, 'at_risk');
    assert.match(v2.why[0]!, /API-1 waits on WEB-1 in web, due 2026-11-30/);
    assert.equal(roadmap.find((m) => m.name === 'old')!.status, 'late');

    // CI from a webhook turns the project red; only the default branch counts.
    const { token } = store.hooks.create(ben, { room: 'web/general', name: 'CI' });
    const deliver = (branch: string, conclusion: string) =>
      store.hooks.deliver(
        token,
        Buffer.from(JSON.stringify({ action: 'completed', repository: { full_name: 'acme/web', default_branch: 'main' }, workflow_run: { name: 'test', head_branch: branch, conclusion, status: 'completed' } })),
        { 'x-github-event': 'workflow_run' },
      );
    deliver('feature-x', 'failure');
    let web = store.portfolios.overview(cto).projects.find((p) => p.project === 'web')!;
    assert.equal(web.ci.length, 0);
    deliver('main', 'failure');
    const overview = store.portfolios.overview(cto);
    web = overview.projects.find((p) => p.project === 'web')!;
    assert.equal(web.health, 'red');
    assert.ok(web.reasons.some((r) => r.startsWith('CI failing: acme/web test')));
    assert.ok(web.reasons.some((r) => r.includes('milestone old is past its date')));
    assert.equal(overview.projects[0]!.project, 'web', 'red first');
    assert.equal(web.role, null, 'the org admin sees it without being a member');
    assert.equal(store.portfolios.overview(ben).projects.length, 1, 'members see their own projects');
    deliver('main', 'success');
    assert.ok(!store.portfolios.overview(cto).projects.find((p) => p.project === 'web')!.reasons.some((r) => r.startsWith('CI')));
  });

  it('writes the weekly digest once, posts it as Orco, and keeps the roll-up for org admins', () => {
    const t = store.tickets.create(ana, 'api', { title: 'Ship the thing' }).ticket;
    store.tickets.update(ana, t.ref, { status: 'Done' });
    store.decisions.record(ana, { project: 'api', title: 'Retries', decision: 'Three retries with backoff' });
    clock = Date.parse('2026-10-19T09:05:00Z'); // a Monday, just after 9
    assert.equal(store.portfolios.runDue(store.digestSchedule), 2);
    assert.equal(store.portfolios.runDue(store.digestSchedule), 0, 'once per scheduled time');
    const posted = store.read(ana, 'api/general').at(-1)!;
    assert.equal(posted.author, 'orco');
    assert.match(posted.text, /\*\*Shipped \(1\)\*\*\n- API-1 Ship the thing/);
    assert.match(posted.text, /#\d+ Retries: Three retries with backoff/);
    const digests = store.portfolios.digests(cto);
    assert.ok(digests.some((d) => d.project === null && d.body.includes('2 projects')));
    assert.ok(!store.portfolios.digests(ana).some((d) => d.project === null), 'the roll-up is for org admins');
    clock = Date.parse('2026-10-21T09:05:00Z'); // Wednesday: no late digest
    assert.equal(store.portfolios.runDue(store.digestSchedule), 0);
  });
});
