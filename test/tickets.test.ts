import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { OrcoError, type Participant, Store } from '../src/store.js';

let store: Store;
let ana: Participant;
let ben: Participant;
let cara: Participant;
let anaClaude: Participant;
let benCodex: Participant;
let clock: number;

beforeEach(() => {
  clock = Date.parse('2026-11-02T12:00:00Z');
  store = new Store(openDatabase(':memory:'), { now: () => clock });
  ana = store.createUser('ana').participant;
  ben = store.createUser('ben').participant;
  cara = store.createUser('cara').participant;
  anaClaude = store.createAgent('ana', 'ana-claude').participant;
  benCodex = store.createAgent('ben', 'ben-codex').participant;
  store.createProject(ana, 'api');
  store.addMember(ana, 'api', 'ben');
});

const statusOf = (ref: string, who = ana) => store.tickets.get(who, ref).status.name;

describe('tickets', () => {
  it('numbers tickets per project with a key and starts them in the backlog', () => {
    const first = store.tickets.create(ana, 'api', { title: 'Rate limit the login', priority: 'high', estimate: 3 }).ticket;
    const second = store.tickets.create(benCodex, 'api', { title: '  Fix   flaky test ', status: 'todo' }).ticket;
    assert.equal(first.ref, 'API-1');
    assert.equal(first.status.name, 'Backlog');
    assert.equal(first.priority, 'high');
    assert.equal(second.ref, 'API-2');
    assert.equal(second.title, 'Fix flaky test');
    assert.equal(second.status.name, 'Todo');
    assert.equal(second.creator, 'ben-codex');
    store.createProject(ben, 'app-platform');
    assert.equal(store.tickets.create(ben, 'app-platform', { title: 'x' }).ticket.ref, 'AP-1');
  });

  it('gives projects with clashing names different keys', () => {
    store.createProject(ana, 'apis');
    assert.equal(store.tickets.plan(ana, 'apis').key, 'API2');
  });

  it('lists each project with its ticket key', () => {
    store.createProject(ana, 'apis');
    assert.deepEqual(store.listProjects(ana).map((p) => [p.name, p.ticketKey]), [['api', 'API'], ['apis', 'API2']]);
  });

  it('hides tickets from people outside the project', () => {
    store.tickets.create(ana, 'api', { title: 'secret' });
    assert.throws(() => store.tickets.get(cara, 'API-1'), (e: OrcoError) => e.code === 'not_found');
    assert.deepEqual(store.tickets.list(cara), []);
    assert.throws(() => store.tickets.create(cara, 'api', { title: 'x' }), (e: OrcoError) => e.code === 'not_found');
  });

  it('records each change in the activity feed and the audit log', () => {
    store.tickets.createLabel(ana, 'api', 'bug');
    store.tickets.create(ana, 'api', { title: 'Login breaks' });
    store.tickets.update(ben, 'API-1', { status: 'In Progress', labels: ['Bug'], assignee: 'ben', dueDate: '2026-11-20' });
    store.tickets.comment(ben, 'API-1', 'Looking now');
    const ticket = store.tickets.get(ana, 'API-1');
    assert.equal(ticket.status.name, 'In Progress');
    assert.ok(ticket.startedAt);
    assert.deepEqual(ticket.labels.map((l) => l.name), ['bug']);
    assert.deepEqual(
      ticket.activity.map((a) => a.kind),
      ['created', 'change', 'comment'],
    );
    const fields = (ticket.activity[1]!.detail as { changes: { field: string }[] }).changes.map((c) => c.field).sort();
    assert.deepEqual(fields, ['assignee', 'dueDate', 'labels', 'status']);
    assert.ok(store.audit.list(ana, { project: 'api' }).some((e) => e.action === 'ticket.update'));
  });

  it('validates fields', () => {
    store.tickets.create(ana, 'api', { title: 'one' });
    assert.throws(() => store.tickets.create(ana, 'api', { title: ' ' }), /empty/);
    assert.throws(() => store.tickets.update(ana, 'API-1', { status: 'Shipped' }), /use one of Backlog/);
    assert.throws(() => store.tickets.update(ana, 'API-1', { labels: ['nope'] }), /No label/);
    assert.throws(() => store.tickets.update(ana, 'API-1', { dueDate: '2026-02-30' }), /date/);
    assert.throws(() => store.tickets.update(ana, 'API-1', { estimate: 1.5 }), /whole number/);
    assert.throws(() => store.tickets.update(ana, 'API-1', { assignee: 'cara' }), (e: OrcoError) => e.code === 'forbidden');
    assert.throws(() => store.tickets.update(ana, 'API-1', { parent: 'API-1' }), /ancestor/);
  });

  it('links parents and children without cycles', () => {
    store.tickets.create(ana, 'api', { title: 'epic' });
    store.tickets.create(ana, 'api', { title: 'child', parent: 'API-1' });
    assert.deepEqual(store.tickets.get(ana, 'API-1').children.map((c) => c.ref), ['API-2']);
    assert.throws(() => store.tickets.update(ana, 'API-1', { parent: 'API-2' }), /ancestor/);
  });

  it('filters and searches', () => {
    store.tickets.createLabel(ana, 'api', 'bug');
    store.tickets.create(ana, 'api', { title: 'Login breaks', labels: ['bug'], assignee: 'ana' });
    store.tickets.create(ana, 'api', { title: 'Add dark mode', status: 'Done' });
    store.tickets.create(ana, 'api', { title: 'Docs', priority: 'urgent' });
    const titles = (filter: Parameters<typeof store.tickets.list>[1]) => store.tickets.list(ana, filter).map((t) => t.title).sort();
    assert.deepEqual(titles({ open: true }), ['Docs', 'Login breaks']);
    assert.deepEqual(titles({ label: 'bug' }), ['Login breaks']);
    assert.deepEqual(titles({ assignee: 'me' }), ['Login breaks']);
    assert.deepEqual(titles({ assignee: 'none', open: true }), ['Docs']);
    assert.deepEqual(titles({ priority: 'urgent' }), ['Docs']);
    assert.deepEqual(titles({ query: 'dark' }), ['Add dark mode']);
    assert.deepEqual(titles({ query: 'api-3' }), ['Docs']);
  });
});

describe('workflow', () => {
  it('lets people rename, add, reorder and remove statuses', () => {
    store.tickets.create(ana, 'api', { title: 'one', status: 'In Review' });
    store.tickets.addStatus(ana, 'api', { name: 'QA', category: 'started', position: 4 });
    const review = store.tickets.plan(ana, 'api').statuses.find((s) => s.name === 'In Review')!;
    store.tickets.updateStatus(ana, 'api', review.id, { name: 'Code Review' });
    assert.deepEqual(
      store.tickets.plan(ana, 'api').statuses.map((s) => s.name),
      ['Backlog', 'Todo', 'In Progress', 'Code Review', 'QA', 'Done', 'Canceled'],
    );
    const qa = store.tickets.plan(ana, 'api').statuses.find((s) => s.name === 'QA')!;
    store.tickets.removeStatus(ana, 'api', review.id, qa.id);
    assert.equal(statusOf('API-1'), 'QA');
  });

  it('keeps the categories agents rely on', () => {
    const done = store.tickets.plan(ana, 'api').statuses.find((s) => s.name === 'Done')!;
    const canceled = store.tickets.plan(ana, 'api').statuses.find((s) => s.name === 'Canceled')!;
    assert.throws(() => store.tickets.removeStatus(ana, 'api', done.id, canceled.id), /completed/);
    assert.throws(() => store.tickets.updateStatus(ana, 'api', done.id, { category: 'started' }), /completed/);
  });

  it('lets agents plan milestones and cycles, but keeps statuses and deletions to people', () => {
    assert.throws(() => store.tickets.addStatus(anaClaude, 'api', { name: 'QA', category: 'started' }), (e: OrcoError) => e.code === 'forbidden');
    const bug = store.tickets.createLabel(anaClaude, 'api', 'bug');
    assert.throws(() => store.tickets.deleteLabel(anaClaude, 'api', bug.id), (e: OrcoError) => e.code === 'forbidden');
    const cycle = store.tickets.createCycle(anaClaude, 'api');
    const beta = store.tickets.createMilestone(anaClaude, 'api', { name: 'Beta' });
    assert.equal(store.tickets.updateMilestone(anaClaude, 'api', beta.id, { targetDate: '2026-12-01' }).targetDate, '2026-12-01');
    assert.throws(() => store.tickets.deleteMilestone(anaClaude, 'api', beta.id), (e: OrcoError) => e.code === 'forbidden');
    assert.equal(store.tickets.completeCycle(anaClaude, 'api', cycle.id).cycle.number, 1);
  });
});

describe('milestones and cycles', () => {
  it('reports milestone progress, ignoring canceled tickets', () => {
    store.tickets.createMilestone(ana, 'api', { name: 'Beta', targetDate: '2026-12-01' });
    store.tickets.create(ana, 'api', { title: 'a', milestone: 'beta', estimate: 3, status: 'Done' });
    store.tickets.create(ana, 'api', { title: 'b', milestone: 'Beta', estimate: 5 });
    store.tickets.create(ana, 'api', { title: 'c', milestone: 'Beta', estimate: 8, status: 'Canceled' });
    const [beta] = store.tickets.plan(ana, 'api').milestones;
    assert.deepEqual(beta!.progress, { tickets: 2, completed: 1, points: 8, completedPoints: 3 });
  });

  it('runs back-to-back cycles and rolls unfinished work over', () => {
    const one = store.tickets.createCycle(ana, 'api');
    const two = store.tickets.createCycle(ana, 'api');
    assert.equal(one.startsOn, '2026-11-02');
    assert.equal(one.endsOn, '2026-11-15');
    assert.equal(two.startsOn, '2026-11-16');
    assert.ok(one.current);
    assert.throws(() => store.tickets.createCycle(ana, 'api', { startsOn: '2026-11-10' }), /overlaps/);
    store.tickets.create(ana, 'api', { title: 'finished', cycle: 'current', status: 'Done' });
    store.tickets.create(ana, 'api', { title: 'carried', cycle: 1 });
    const result = store.tickets.completeCycle(ana, 'api', one.id);
    assert.deepEqual([result.moved, result.movedTo], [1, 2]);
    assert.deepEqual(store.tickets.list(ana, { cycle: 2 }).map((t) => t.title), ['carried']);
    assert.deepEqual(store.tickets.list(ana, { cycle: 1 }).map((t) => t.title), ['finished']);
    assert.throws(() => store.tickets.update(ana, 'API-2', { cycle: 1 }), /complete/);
  });
});

describe('agents on tickets', () => {
  it('starts a task when a ticket is assigned to an agent, and moves the ticket with it', () => {
    store.tickets.create(ana, 'api', { title: 'Fix login', status: 'Todo' });
    const { ticket, warning } = store.tickets.update(ana, 'API-1', { assignee: 'ana-claude' });
    assert.equal(warning, undefined);
    assert.equal(ticket.task?.state, 'requested');
    const task = store.tasks.get(ana, ticket.task!.id);
    assert.equal(task.assignee, 'ana-claude');
    assert.equal(task.room, 'api/general');
    assert.match(task.request, /^Work on ticket API-1: Fix login$/);

    store.tasks.update(anaClaude, task.id, 'accepted');
    assert.equal(statusOf('API-1'), 'In Progress');
    store.tasks.update(anaClaude, task.id, 'done', 'PR is up');
    assert.equal(statusOf('API-1'), 'In Review');
    const last = store.tickets.get(ana, 'API-1').activity.filter((a) => a.kind === 'task').at(-1)!;
    assert.equal(last.body, 'PR is up');
  });

  it('goes through consent when the agent belongs to someone else', () => {
    store.tickets.create(ben, 'api', { title: 'Review docs', assignee: 'ana-claude' });
    assert.equal(store.tickets.get(ben, 'API-1').task?.state, 'awaiting_approval');
    store.setTaskPolicy(ana, 'ana-claude', 'owner_only');
    const { warning } = store.tickets.create(ben, 'api', { title: 'Another', assignee: 'ana-claude' });
    assert.match(warning ?? '', /only takes tasks from ana/);
    assert.equal(store.tickets.get(ben, 'API-2').assignee?.name, 'ana-claude');
    assert.equal(store.tickets.get(ben, 'API-2').task, null);
  });

  it('cancels the open task when the ticket is reassigned', () => {
    store.tickets.create(ana, 'api', { title: 'Fix login', assignee: 'ana-claude' });
    const taskId = store.tickets.get(ana, 'API-1').task!.id;
    store.tickets.update(ana, 'API-1', { assignee: 'ana' });
    assert.equal(store.tasks.get(ana, taskId).state, 'cancelled');
  });

  it('refuses a reassignment that would cancel someone else’s task', () => {
    store.setTaskPolicy(ben, 'ben-codex', 'open');
    store.tickets.create(ben, 'api', { title: 'Fix login', assignee: 'ben-codex' });
    store.addMember(ana, 'api', 'cara');
    assert.throws(() => store.tickets.update(cara, 'API-1', { assignee: 'cara' }), (e: OrcoError) => e.code === 'conflict');
  });

  it('can restart work after a task fails', () => {
    store.tickets.create(ana, 'api', { title: 'Fix login', assignee: 'ana-claude' });
    const first = store.tickets.get(ana, 'API-1').task!.id;
    assert.throws(() => store.tickets.startTask(ana, 'API-1'), (e: OrcoError) => e.code === 'conflict');
    store.tasks.update(anaClaude, first, 'failed', 'no access');
    const restarted = store.tickets.startTask(ana, 'API-1').ticket;
    assert.notEqual(restarted.task!.id, first);
  });

  it('lets agents work tickets but not plan them', () => {
    store.tickets.create(anaClaude, 'api', { title: 'Found a bug', priority: 'high' });
    store.tickets.update(anaClaude, 'API-1', { status: 'In Progress' });
    store.tickets.comment(anaClaude, 'API-1', 'Reproduced');
    assert.equal(statusOf('API-1', ben), 'In Progress');
  });
});

describe('ticket edge cases', () => {
  it('lets an agent claim a ticket without trying to task itself', () => {
    store.tickets.create(anaClaude, 'api', { title: 'mine' });
    const { ticket, warning } = store.tickets.update(anaClaude, 'API-1', { assignee: 'ana-claude' });
    assert.equal(warning, undefined);
    assert.equal(ticket.task, null);
    assert.ok(!ticket.activity.some((a) => a.kind === 'task'));
  });

  it('starts a new cycle today when the last one ended long ago', () => {
    store.tickets.createCycle(ana, 'api');
    clock += 60 * 86_400_000;
    const next = store.tickets.createCycle(ana, 'api');
    assert.equal(next.startsOn, '2027-01-01');
    assert.ok(next.current);
  });

  it('does not ping people mentioned in a ticket when it goes to an agent', () => {
    store.tickets.create(ana, 'api', { title: 'ask @ben', description: 'loop in @ben and @cara', assignee: 'ana-claude' });
    assert.equal(store.unseenMentions(ben).length, 0);
    assert.equal(store.unseenMentions(anaClaude).length, 1);
  });

  it('stops the agent when its ticket is canceled', () => {
    store.tickets.create(ana, 'api', { title: 'x', assignee: 'ana-claude' });
    const id = store.tickets.get(ana, 'API-1').task!.id;
    store.tasks.update(anaClaude, id, 'accepted');
    store.tickets.update(ana, 'API-1', { status: 'Canceled' });
    assert.equal(store.tasks.get(ana, id).state, 'cancelled');
    assert.equal(statusOf('API-1'), 'Canceled');
  });

  it('cancels a ticket even when the person may not stop its task', () => {
    store.setTaskPolicy(ben, 'ben-codex', 'open');
    store.tickets.create(ben, 'api', { title: 'x', assignee: 'ben-codex' });
    const id = store.tickets.get(ana, 'API-1').task!.id;
    store.tickets.update(ana, 'API-1', { status: 'Canceled' });
    assert.equal(statusOf('API-1'), 'Canceled');
    assert.equal(store.tasks.get(ana, id).state, 'requested');
  });

  it('never fails a task update because ticket bookkeeping failed', (t) => {
    t.mock.method(console, 'error', () => {});
    store.tickets.create(ana, 'api', { title: 'x', assignee: 'ana-claude' });
    const id = store.tickets.get(ana, 'API-1').task!.id;
    store.db.exec('DROP TABLE ticket_activity');
    assert.equal(store.tasks.update(anaClaude, id, 'accepted').state, 'accepted');
  });
});


describe('working notes on tickets', () => {
  it('keeps a handoff note with who wrote it', () => {
    store.tickets.create(ana, 'api', { title: 'x', assignee: 'ana-claude' });
    store.tickets.update(anaClaude, 'API-1', { handoff: 'Done: repro. Next: patch spawn. Branch fix/cwd.' });
    const ticket = store.tickets.get(ana, 'API-1');
    assert.equal(ticket.handoff?.text, 'Done: repro. Next: patch spawn. Branch fix/cwd.');
    assert.equal(ticket.handoff?.by, 'ana-claude');
    assert.ok(ticket.activity.some((a) => a.kind === 'change' && JSON.stringify(a.detail).includes('handoff')));
  });

  it('tracks acceptance criteria; agents can tick them but not remove them', () => {
    store.tickets.create(ana, 'api', { title: 'x', criteriaAdd: ['Tests pass', 'Docs updated'] });
    const [tests, docs] = store.tickets.get(ana, 'API-1').criteriaItems;
    store.tickets.update(anaClaude, 'API-1', { criteriaDone: [tests!.id], criteriaAdd: ['Changelog line'] });
    assert.throws(() => store.tickets.update(anaClaude, 'API-1', { criteriaRemove: [docs!.id] }), (e: OrcoError) => e.code === 'forbidden');
    assert.deepEqual(store.tickets.list(ana, { project: 'api' })[0]!.criteria, { done: 1, total: 3 });
    store.tickets.update(ana, 'API-1', { criteriaRemove: [docs!.id] });
    assert.deepEqual(
      store.tickets.get(ana, 'API-1').criteriaItems.map((c) => [c.text, c.done]),
      [
        ['Tests pass', true],
        ['Changelog line', false],
      ],
    );
    assert.throws(() => store.tickets.update(ana, 'API-1', { criteriaDone: [999] }), /No criterion/);
  });

  it('links blockers, reports open ones, and refuses loops', () => {
    store.tickets.create(ana, 'api', { title: 'infra' });
    store.tickets.create(ana, 'api', { title: 'app', blockedByAdd: ['API-1'] });
    store.tickets.create(ana, 'api', { title: 'launch' });
    store.tickets.update(ana, 'API-3', { blockedByAdd: ['API-2'] });
    assert.deepEqual(store.tickets.get(ana, 'API-2').blockedBy, ['API-1']);
    assert.deepEqual(store.tickets.get(ana, 'API-1').blocking.map((b) => b.ref), ['API-2']);
    assert.throws(() => store.tickets.update(ana, 'API-1', { blockedByAdd: ['API-3'] }), /loop/);
    assert.throws(() => store.tickets.update(ana, 'API-1', { blockedByAdd: ['API-1'] }), /itself/);
    store.tickets.update(ana, 'API-1', { status: 'Done' });
    assert.deepEqual(store.tickets.get(ana, 'API-2').blockedBy, []);
    assert.equal(store.tickets.get(ana, 'API-2').blockers[0]!.category, 'completed');
    store.tickets.update(ana, 'API-3', { blockedByRemove: ['API-2'] });
    assert.deepEqual(store.tickets.get(ana, 'API-3').blockers, []);
  });

  it('reads only what changed since a given activity id', () => {
    store.tickets.create(ana, 'api', { title: 'x' });
    const first = store.tickets.get(ana, 'API-1');
    store.tickets.comment(ben, 'API-1', 'new info');
    const later = store.tickets.get(ana, 'API-1', first.lastActivityId);
    assert.deepEqual(later.activity.map((a) => a.body), ['new info']);
    assert.ok(later.lastActivityId > first.lastActivityId);
  });

  it('shows needs input on the ticket while its agent waits on a question', () => {
    store.tickets.create(ana, 'api', { title: 'x', assignee: 'ana-claude' });
    const taskId = store.tickets.get(ana, 'API-1').task!.id;
    store.tasks.update(anaClaude, taskId, 'accepted');
    store.questions.ask(anaClaude, taskId, 'Which region?');
    const ticket = store.tickets.get(ana, 'API-1');
    assert.equal(ticket.task?.state, 'needs_input');
    assert.equal(ticket.activity.filter((a) => a.kind === 'task').at(-1)!.body, 'Which region?');
    const q = store.tickets.get(ana, 'API-1').task!;
    store.questions.answer(ana, store.tasks.get(ana, q.id).question!.id, 'eu-west');
    const last = store.tickets.get(ana, 'API-1').activity.filter((a) => a.kind === 'task').at(-1)!;
    assert.deepEqual([last.body, (last.detail as { state: string }).state, (last.detail as { by: string }).by], ['eu-west', 'answered', 'ana']);
  });
});

describe('blocked on something outside the project', () => {
  it('marks a ticket blocked with a reason, filters on it, and clears it', () => {
    store.tickets.create(ana, 'api', { title: 'Ship SSO', blockedReason: 'waiting on the vendor' });
    store.tickets.create(ana, 'api', { title: 'infra' });
    store.tickets.create(ana, 'api', { title: 'app', blockedByAdd: ['API-2'] });
    store.tickets.create(ana, 'api', { title: 'free' });
    const sso = store.tickets.get(ana, 'API-1');
    assert.deepEqual([sso.blocked, sso.blockedReason, sso.blockedBy], [true, 'waiting on the vendor', []]);
    assert.deepEqual(store.tickets.list(ana, { project: 'api', blocked: true }).map((t) => t.ref).sort(), ['API-1', 'API-3']);
    assert.deepEqual(store.tickets.list(ana, { project: 'api', blocked: false }).map((t) => t.ref).sort(), ['API-2', 'API-4']);
    store.tickets.update(anaClaude, 'API-1', { blockedReason: '' });
    const cleared = store.tickets.get(ana, 'API-1');
    assert.equal(cleared.blocked, false);
    assert.ok(cleared.activity.some((a) => JSON.stringify(a.detail ?? '').includes('blockedReason')));
  });
});

