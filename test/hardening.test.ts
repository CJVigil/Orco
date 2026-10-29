import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';

// Regression tests for issues #16-#22: who may administer, what spend counts, what people see.
let store: Store;
let cto: Participant;
let ana: Participant;
let ben: Participant;
let anaBot: Participant;
let anaHelper: Participant;

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as OrcoError).code;
  }
  return 'ok';
};

beforeEach(() => {
  store = new Store(openDatabase(':memory:'));
  cto = store.createUser('cto').participant;
  ana = store.createUser('ana').participant;
  ben = store.createUser('ben').participant;
  anaBot = store.createAgent('ana', 'ana-bot').participant;
  anaHelper = store.createAgent('ana', 'ana-helper').participant;
  store.createProject(ana, 'api');
  store.createProject(ben, 'web');
});

describe('agents never administer (#16)', () => {
  it('refuses an admin owner’s agent on groups, members, budgets and pauses', () => {
    store.groups.create(cto, 'backend', ['ben']);
    assert.equal(code(() => store.groups.setProjectRole(anaBot, 'api', 'backend', 'admin')), 'forbidden');
    assert.equal(code(() => store.addMember(anaBot, 'api', 'ben')), 'forbidden');
    assert.equal(code(() => store.adminProject(anaBot, 'api')), 'forbidden');
    assert.equal(store.adminProject(ana, 'api').name, 'api', 'its owner still can');
  });
});

describe('spend (#17)', () => {
  it('never lets an agent lower what the bridge measured', () => {
    const task = store.tasks.create(ana, { agent: 'ana-bot', room: 'api/general', request: 'Do the thing' });
    store.tasks.update(anaBot, task.id, 'accepted');
    store.tasks.addUsage(task.id, 500, 1000);
    let t = store.tasks.reportProgress(anaBot, task.id, 'cheap so far', null, { costCents: 0, tokens: 0 });
    assert.equal(t.budget?.spentCents, 500, 'reporting 0 does not erase measured cost');
    t = store.tasks.reportProgress(anaBot, task.id, 'more', null, { costCents: 900 });
    assert.equal(t.budget?.spentCents, 900, 'a higher reported total counts');
    store.tasks.addUsage(task.id, 100, 0);
    assert.equal(store.tasks.get(ana, task.id).budget?.spentCents, 900, 'the larger of measured (600) and reported (900)');
    store.tasks.addUsage(task.id, 400, 0);
    assert.equal(store.tasks.get(ana, task.id).budget?.spentCents, 1000);
  });
});

describe('decisions (#18)', () => {
  it('are superseded only where they were made', () => {
    const org = store.decisions.record(cto, { project: null, title: 'Licenses', decision: 'Apache-2.0' });
    assert.equal(code(() => store.decisions.record(ana, { project: 'api', title: 'Licenses', decision: 'MIT' }, org.id)), 'forbidden');
    const local = store.decisions.record(ana, { project: 'api', title: 'DB', decision: 'SQLite' });
    store.addMember(ana, 'api', 'ben');
    assert.equal(code(() => store.decisions.record(ben, { project: 'web', title: 'DB', decision: 'Postgres' }, local.id)), 'forbidden', 'not from another project');
    assert.equal(store.decisions.record(cto, { project: null, title: 'Licenses', decision: 'Apache-2.0 or MIT' }, org.id).title, 'Licenses');
  });
});

describe('groups (#19)', () => {
  it('are for people, and show only projects they can see', () => {
    store.groups.create(cto, 'design', ['ben']);
    store.groups.setProjectRole(ben, 'web', 'design', 'member');
    assert.equal(code(() => store.groups.list(anaBot)), 'forbidden');
    assert.deepEqual(store.groups.list(ana).map((g) => [g.name, g.projects]), [['design', []]]);
    assert.deepEqual(store.groups.list(cto)[0]!.projects.map((p) => p.project), ['web']);
  });
});

describe('hand-overs (#21)', () => {
  it('cannot loop back to an agent that already had the work', () => {
    const task = store.tasks.create(ana, { agent: 'ana-bot', room: 'api/general', request: 'Do the thing' });
    store.tasks.update(anaBot, task.id, 'accepted');
    const { to } = store.tasks.reassign(anaBot, task.id, 'ana-helper', 'out of usage');
    store.tasks.update(anaHelper, to.id, 'accepted');
    assert.equal(code(() => store.tasks.reassign(anaHelper, to.id, 'ana-bot')), 'conflict');
    assert.deepEqual(store.tasks.get(ana, to.id).chain[0], 'ana', 'the person who asked stays at the head of the chain');
  });
});

describe('cross-project blockers (#22)', () => {
  it('stay anonymous to people who cannot see the other project', () => {
    store.addMember(ben, 'web', 'ana');
    const dan = store.createUser('dan').participant;
    store.addMember(ana, 'api', 'dan');
    store.tickets.createMilestone(ana, 'api', { name: 'v2', targetDate: '2099-10-20' });
    store.tickets.createMilestone(ben, 'web', { name: 'launch', targetDate: '2099-11-30' });
    const apiTicket = store.tickets.create(ana, 'api', { title: 'Endpoint', milestone: 'v2' }).ticket;
    const webTicket = store.tickets.create(ben, 'web', { title: 'Secret redesign', milestone: 'launch' }).ticket;
    store.tickets.update(ana, apiTicket.ref, { blockedByAdd: [webTicket.ref] });

    const forAna = store.portfolios.roadmap(ana).find((m) => m.name === 'v2')!;
    assert.equal(forAna.waitsOn[0]!.blockerTitle, 'Secret redesign', 'members of both see it');
    const forDan = store.portfolios.roadmap(dan).find((m) => m.name === 'v2')!;
    assert.equal(forDan.status, 'at_risk', 'it still counts');
    assert.ok(!JSON.stringify(forDan).includes('Secret redesign') && !JSON.stringify(forDan).includes('WEB-') && !JSON.stringify(forDan).includes('launch'), JSON.stringify(forDan));
    const digest = store.portfolios.projectDigest(store.visibleProject(ana, 'api').id);
    assert.ok(!digest.includes('WEB-'), digest);
  });
});

describe('ORCO_TRUST_PROXY (#24)', () => {
  it('takes hop counts and proxy addresses, never "true"', async () => {
    const { trustProxySetting } = await import('../src/commands.js');
    assert.equal(trustProxySetting(undefined), undefined);
    assert.equal(trustProxySetting('1'), 1);
    assert.equal(trustProxySetting('loopback'), 'loopback');
    assert.throws(() => trustProxySetting('true'), /any client's X-Forwarded-For/);
    assert.throws(() => trustProxySetting('*'));
    assert.throws(() => trustProxySetting('0.0.0.0/0'), /almost any client/);
    assert.throws(() => trustProxySetting('loopback, ::/0'), /almost any client/);
    assert.equal(trustProxySetting('10.0.0.0/8'), '10.0.0.0/8');
  });
});

describe('masking stays fast on hostile text (#33)', () => {
  it('scans private keys in linear time and still hides them', async () => {
    const { maskSecrets } = await import('../src/mask.js');
    for (const hostile of ['-----BEGIN RSA PRIVATE KEY-----\n'.repeat(30_000), `-----BEGIN RSA PRIVATE KEY-----${'-----END x'.repeat(90_000)}`, 'token '.repeat(150_000)]) {
      const started = performance.now();
      maskSecrets(hostile.slice(0, 1_000_000));
      assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
    }
    assert.equal(maskSecrets('a -----BEGIN EC PRIVATE KEY-----\nxyz\n-----END EC PRIVATE KEY----- b'), 'a [hidden] b');
  });
});

describe('schedules across daylight saving (#37)', () => {
  it('runs once in the repeated hour when clocks go back', async () => {
    const { nextRun, parseCron } = await import('../src/cron.js');
    const cron = parseCron('30 1 * * *');
    const first = nextRun(cron, Date.parse('2026-10-31T12:00:00Z'), 'America/Chicago');
    assert.equal(new Date(first).toISOString(), '2026-11-01T06:30:00.000Z');
    const second = nextRun(cron, first, 'America/Chicago');
    assert.equal(new Date(second).toISOString(), '2026-11-02T07:30:00.000Z', 'not again at 07:30Z the same night');
  });
});

describe('webhooks (#34)', () => {
  it('need write access, wake only willing agents, and are removed by their creator or an admin', () => {
    const vic = store.createUser('vic').participant;
    store.addMember(ana, 'api', 'vic', 'viewer');
    store.addMember(ana, 'api', 'ben');
    store.createAgent('ben', 'ben-bot');
    assert.equal(code(() => store.hooks.create(vic, { room: 'api/general', name: 'CI' })), 'forbidden', 'viewers cannot post through a hook');
    assert.equal(code(() => store.hooks.create(ana, { room: 'api/general', name: 'CI', wakeAgent: 'ben-bot' })), 'forbidden', 'not ben’s agent');
    const { hook, token } = store.hooks.create(ana, { room: 'api/general', name: 'CI', wakeAgent: 'ana-bot' });
    const benHook = store.hooks.create(ben, { room: 'api/general', name: 'Deploys' }).hook;
    assert.equal(code(() => store.hooks.delete(ben, hook.id)), 'forbidden', 'not ben’s hook');
    store.hooks.delete(ana, benHook.id); // ana administers api
    // Made a viewer later: the hook stops posting.
    store.addMember(cto, 'api', 'cto');
    const vicHook = store.hooks.create(ben, { room: 'api/general', name: 'Ben CI' });
    store.db.prepare("UPDATE project_members SET role = 'viewer' WHERE user_id = ?").run(ben.id);
    assert.equal(code(() => store.hooks.deliver(vicHook.token, Buffer.from('{}'), {})), 'forbidden');
    assert.ok(store.hooks.deliver(token, Buffer.from('{}'), {}));
  });
});

describe('audit log (#35)', () => {
  it('keeps org-level entries for org admins, and shows others only their own', () => {
    store.createUser('stranger');
    store.signins.createLink(null, 'ana');
    store.memory.save(anaBot, { title: 'Secret plan', body: 'x' });
    const stranger = store.participantByName('stranger')!;
    const seen = JSON.stringify(store.audit.list(stranger));
    assert.ok(!seen.includes('user:ana') && !seen.includes('Secret plan') && !seen.includes('ana-bot'), seen);
    const forAna = JSON.stringify(store.audit.list(ana));
    assert.ok(forAna.includes('signin_link.create'), 'about herself');
    assert.ok(JSON.stringify(store.audit.list(cto)).includes('user:stranger'), 'org admins see everything');
  });
});

describe('ticket import (#36)', () => {
  it('writes all or nothing and checks shapes', async () => {
    const { importTickets } = await import('../src/import.js');
    const count = () => (store.db.prepare('SELECT count(*) AS n FROM tickets').get() as { n: number }).n;
    assert.equal(code(() => importTickets(store, ana, 'api', [{ key: 'a', title: 'A', blockedBy: ['a'] }])), 'invalid');
    assert.equal(code(() => importTickets(store, ana, 'api', [{ title: 'A', criteria: 'x' as never }])), 'invalid');
    assert.equal(code(() => importTickets(store, ana, 'api', [{ title: 'A', labels: 'bug' as never }])), 'invalid');
    const done = importTickets(store, ana, 'api', [{ title: 'A', labels: ['Bug'] }, { title: 'B', labels: ['bug'] }], { createLabels: true });
    assert.deepEqual(done.labelsCreated, ['Bug']);
    const before = count();
    // A failure only the write phase finds (an assignee that is not a person) leaves nothing behind.
    const labels = () => (store.db.prepare('SELECT count(*) AS n FROM labels').get() as { n: number }).n;
    const labelsBefore = labels();
    const original = store.tickets.create.bind(store.tickets);
    let calls = 0;
    store.tickets.create = ((...args: Parameters<typeof original>) => {
      if (++calls === 2) throw new Error('disk full');
      return original(...args);
    }) as typeof original;
    try {
      assert.throws(() => importTickets(store, ana, 'api', [{ title: 'C', labels: ['new'] }, { title: 'D' }], { createLabels: true }), /disk full/);
    } finally {
      store.tickets.create = original;
    }
    assert.equal(count(), before, 'no ticket C');
    assert.equal(labels(), labelsBefore, 'no label "new"');
  });
});

describe('smaller findings (#37)', () => {
  it('holds an outlying reported cost to a ceiling', () => {
    const task = store.tasks.create(ana, { agent: 'ana-bot', room: 'api/general', request: 'x', budgetCents: 1000 });
    store.tasks.update(anaBot, task.id, 'accepted');
    const t = store.tasks.reportProgress(anaBot, task.id, 'oops', null, { costCents: 1e12 });
    assert.equal(t.budget?.spentCents, 3000);
    assert.ok(JSON.stringify(store.audit.list(ana)).includes('task.cost_outlier'));
  });

  it('keeps viewers from storing secrets', () => {
    const keyed = new Store(openDatabase(':memory:'), { secretsKey: Buffer.alloc(32, 1) });
    const owner = keyed.createUser('o').participant;
    const viewer = keyed.createUser('v').participant;
    keyed.createProject(owner, 'p');
    keyed.addMember(owner, 'p', 'v', 'viewer');
    assert.equal(code(() => keyed.secrets.set(viewer, 'p', 'KEY', 'value123')), 'forbidden');
  });

  it('lets a task token wait on its own mentions without losing the agent’s others', () => {
    store.createProject(ana, 'ops');
    const task = store.tasks.create(ana, { agent: 'ana-bot', room: 'api/general', request: 'x' });
    store.tasks.update(anaBot, task.id, 'accepted');
    const scoped = store.authenticate(store.tasks.issueToken(anaBot, task.id).token)!;
    const elsewhere = store.post(ana, 'ops/general', '@ana-bot over here');
    const here = store.post(ana, 'api/general', '@ana-bot and here');
    const forTask = store.unseenMentions(scoped).map((m) => m.id);
    assert.ok(forTask.includes(here.id) && !forTask.includes(elsewhere.id));
    store.markMentionsSeen(scoped, here.id);
    assert.ok(store.unseenMentions(anaBot).some((m) => m.id === elsewhere.id), 'the agent still gets the other one');
    assert.ok(!store.unseenMentions(scoped).some((m) => m.id === here.id), 'the task token moved on');
  });
});

describe('round five (#40 notes)', () => {
  it('stops a hook waking an agent whose owner no longer lets its creator give it work', () => {
    store.addMember(ana, 'api', 'ben');
    store.setTaskPolicy(ana, 'ana-bot', 'open');
    const { token } = store.hooks.create(ben, { room: 'api/general', name: 'CI', wakeAgent: 'ana-bot' });
    assert.ok(store.hooks.deliver(token, Buffer.from('{}'), {})!.taskId, 'wakes it while open');
    store.setTaskPolicy(ana, 'ana-bot', 'owner_only');
    assert.equal(store.hooks.deliver(token, Buffer.from('{}'), {})!.taskId, null);
  });
});
