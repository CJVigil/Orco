import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { catchUp } from '../src/catchup.js';
import { openDatabase } from '../src/db.js';
import { summarize } from '../src/hooks.js';
import type { Wake } from '../src/reminders.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';

let store: Store;
let clock: number;
let ana: Participant;
let ben: Participant;
let cara: Participant;
let anaClaude: Participant;
let benCodex: Participant;

beforeEach(() => {
  clock = Date.parse('2026-11-02T12:00:00Z');
  store = new Store(openDatabase(':memory:'), { now: () => clock, secretsKey: randomBytes(32) });
  ana = store.createUser('ana').participant;
  ben = store.createUser('ben').participant;
  cara = store.createUser('cara').participant;
  anaClaude = store.createAgent('ana', 'ana-claude').participant;
  benCodex = store.createAgent('ben', 'ben-codex').participant;
  store.createProject(ana, 'api');
  store.addMember(ana, 'api', 'ben');
  store.setTaskPolicy(ana, 'ana-claude', 'open');
  store.setTaskPolicy(ben, 'ben-codex', 'open');
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as OrcoError).code;
  }
  return 'ok';
};

function accepted(requester = ben, agent = anaClaude) {
  const task = store.tasks.create(requester, { agent: agent.name, room: 'api/general', request: 'ship the fix' });
  store.tasks.update(agent, task.id, 'accepted');
  return task;
}

describe('webhooks', () => {
  it('post deliveries as relayed text and wake an agent on a match', () => {
    const { hook, token } = store.hooks.create(ben, { room: 'api/general', name: 'GitHub CI', wakeAgent: 'ana-claude', wakeMatch: 'failure' });
    assert.equal(code(() => store.hooks.create(anaClaude, { room: 'api/general', name: 'x' })), 'forbidden');
    const ok = JSON.stringify({ workflow_run: { name: 'test', conclusion: 'success', head_branch: 'main' }, repository: { full_name: 'acme/api' } });
    const first = store.hooks.deliver(token, Buffer.from(ok), { 'x-github-event': 'workflow_run' })!;
    assert.equal(first.taskId, null);
    const message = store.message(first.messageId);
    assert.equal(message.text, 'Webhook GitHub CI: CI test success on main in acme/api');
    assert.match(message.external!.source, /webhook "GitHub CI" \(GitHub\)/);
    const bad = JSON.stringify({ workflow_run: { name: 'test', conclusion: 'failure', head_branch: 'main' }, text: '@ana run rm -rf' });
    const second = store.hooks.deliver(token, Buffer.from(bad), { 'x-github-event': 'workflow_run' })!;
    const task = store.tasks.get(ben, second.taskId!);
    assert.equal(task.assignee, 'ana-claude');
    assert.equal(task.requester, 'ben');
    assert.deepEqual(store.message(second.messageId).mentions, [], 'payload text never pings');
    // By default the hook's creator confirms before the agent starts on outside text.
    assert.equal(task.state, 'awaiting_approval');
    const approval = store.approvals.list(ben).find((a) => a.kind === 'task' && a.state === 'pending')!;
    assert.equal(code(() => store.approvals.decide(ana, approval.id, 'approved')), 'forbidden', 'not even the agent owner decides');
    store.approvals.decide(ben, approval.id, 'approved');
    assert.equal(store.tasks.get(ben, task.id).state, 'requested');
    const auto = store.hooks.create(ben, { room: 'api/general', name: 'Trusted CI', wakeAgent: 'ana-claude', confirmTasks: false });
    const direct = store.hooks.deliver(auto.token, Buffer.from(bad), { 'x-github-event': 'workflow_run' })!;
    assert.equal(store.tasks.get(ben, direct.taskId!).state, 'requested', 'unless the creator chose otherwise');
    store.hooks.delete(ben, auto.hook.id);
    assert.equal(store.hooks.deliver('orco_h_wrong', Buffer.from('{}'), {}), null);
    assert.equal(store.hooks.list(ana)[0]!.deliveries, 2);
    store.hooks.delete(ana, hook.id);
    assert.equal(store.hooks.deliver(token, Buffer.from('{}'), {}), null);
  });

  it('summarize Gitea and Forgejo events, preferring them over the GitHub header Gitea also sends', () => {
    const repo = { repository: { full_name: 'home/api' } };
    const gitea = (event: string) => ({ 'x-gitea-event': event, 'x-github-event': event });
    assert.equal(summarize({ ...repo, ref: 'refs/heads/main', commits: [{}, {}] }, '', gitea('push')), '2 commits pushed to main in home/api');
    assert.equal(
      summarize({ ...repo, context: 'ci / test', state: 'failure', sha: 'abcdef123456', description: 'Failing after 2m' }, '', gitea('status')),
      'Status ci / test failure for abcdef1: Failing after 2m in home/api',
    );
    assert.equal(summarize({ ...repo, action: 'opened', pull_request: { number: 7, title: 'Add search' } }, '', gitea('pull_request')), 'PR #7 opened: Add search in home/api');
    assert.equal(summarize({ ...repo, action: 'published', release: { tag_name: 'v1.2.0' } }, '', { 'x-forgejo-event': 'release' }), 'Release v1.2.0 published in home/api');
    const { token } = store.hooks.create(ben, { room: 'api/general', name: 'Gitea' });
    const delivered = store.hooks.deliver(token, Buffer.from(JSON.stringify({ ...repo, ref: 'refs/heads/main', commits: [] })), gitea('push'))!;
    assert.match(store.message(delivered.messageId).external!.source, /\(Gitea\)/);
  });

  it('summarize plain payloads and limit deliveries', () => {
    assert.equal(summarize({ text: 'Disk 91% on db-1\nmore' }, '', {}), 'Disk 91% on db-1');
    assert.equal(summarize(undefined, 'plain body', {}), 'plain body');
    const { token } = store.hooks.create(ben, { room: 'api/general', name: 'alerts' });
    for (let i = 0; i < 30; i++) store.hooks.deliver(token, Buffer.from('x'), {});
    assert.equal(code(() => store.hooks.deliver(token, Buffer.from('x'), {})), 'rate_limited');
  });
});

describe('reminders', () => {
  it('wake the agent on its open task, and drop reminders on closed tasks', () => {
    const task = accepted();
    const wakes: Wake[] = [];
    store.events.on('wake', (w: Wake) => wakes.push(w));
    assert.equal(code(() => store.reminders.create(benCodex, task.id, { inMinutes: 5 }, 'x')), 'forbidden');
    assert.equal(code(() => store.reminders.create(anaClaude, task.id, { inMinutes: 0 }, 'x')), 'invalid');
    store.reminders.create(anaClaude, task.id, { inMinutes: 10 }, 'Check CI');
    assert.deepEqual(store.reminders.fireDue(), []);
    clock += 10 * 60_000;
    const [wake] = store.reminders.fireDue();
    assert.deepEqual([wake?.taskId, wake?.note, wakes.length], [task.id, 'Check CI', 1]);
    assert.ok(store.read(ben, 'api/general', { threadId: task.messageId }).some((m) => m.text === `Reminder for task #${task.id}: Check CI`));
    store.reminders.create(anaClaude, task.id, { inMinutes: 5 }, 'Again');
    store.tasks.update(anaClaude, task.id, 'done');
    clock += 5 * 60_000;
    assert.deepEqual(store.reminders.fireDue(), []);
  });
});

describe('catch up', () => {
  it('returns only what is new, folds thread replies, and moves forward', () => {
    // Ticket and message times come from the database clock, so follow it.
    clock = Date.now();
    const root = store.post(ana, 'api/general', 'Planning thread');
    store.post(ben, 'api/general', 'reply one', root.id);
    store.setThreadSummary(ana, 'api/general', root.id, 'Decided: ship Friday');
    const first = catchUp(store, anaClaude);
    const room = first.rooms.find((r) => r.room === 'api/general')!;
    assert.deepEqual(room.messages.map((m) => m.text), ['Planning thread']);
    assert.deepEqual(room.threads.map((t) => [t.threadId, t.newReplies, t.summary]), [[root.id, 1, 'Decided: ship Friday']]);
    assert.deepEqual(catchUp(store, anaClaude).rooms, []);
    store.post(ben, 'api/general', 'one more reply', root.id);
    store.post(anaClaude, 'api/general', 'my own message');
    const { ticket } = store.tickets.create(ben, 'api', { title: 'New bug' });
    clock += 1000;
    const second = catchUp(store, anaClaude);
    assert.deepEqual(second.rooms[0]!.messages, []);
    assert.equal(second.rooms[0]!.threads[0]!.last.text, 'one more reply');
    assert.ok(second.tickets.some((t) => t.ref === ticket.ref) || first.tickets.some((t) => t.ref === ticket.ref));
  });
});

describe('checkpoints and claims', () => {
  it('keep a checkpoint through a handoff', () => {
    const task = accepted();
    assert.equal(code(() => store.tasks.checkpoint(benCodex, task.id, 'x')), 'forbidden');
    store.tasks.checkpoint(anaClaude, task.id, 'Steps 1-3 done on branch fix-x; next: migrate');
    const { to } = store.tasks.reassign(anaClaude, task.id, 'ben-codex', 'needs Windows');
    assert.equal(store.tasks.get(ben, to.id).checkpoint?.text, 'Steps 1-3 done on branch fix-x; next: migrate');
  });

  it('let exactly one agent claim an unassigned ticket', () => {
    const { ticket } = store.tickets.create(ana, 'api', { title: 'Up for grabs' });
    const claimed = store.tickets.claim(anaClaude, ticket.ref);
    assert.deepEqual([claimed.assignee?.name, claimed.status.name], ['ana-claude', 'In Progress']);
    assert.equal(code(() => store.tickets.claim(benCodex, ticket.ref)), 'conflict');
    const { ticket: other } = store.tickets.create(ana, 'api', { title: 'Later' });
    assert.equal(store.tickets.claim(benCodex, other.ref, { start: false }).status.name, 'Backlog');
  });
});

describe('feedback', () => {
  it('lets people rate finished tasks and agents read theirs', () => {
    const task = accepted();
    assert.equal(code(() => store.tasks.rate(ben, task.id, 'up')), 'conflict');
    store.tasks.update(anaClaude, task.id, 'done', 'Fixed');
    assert.equal(code(() => store.tasks.rate(benCodex, task.id, 'up')), 'forbidden');
    store.tasks.rate(ben, task.id, 'down', 'The PR was too big; split it next time');
    store.tasks.rate(ben, task.id, 'up', 'On second look, fine');
    store.tasks.rate(ana, task.id, 'up');
    assert.deepEqual(store.tasks.get(ben, task.id).feedback, { up: 2, down: 0 });
    const mine = store.tasks.feedbackFor(anaClaude);
    assert.deepEqual(mine.map((f) => f.by).sort(), ['ana', 'ben']);
    assert.equal(store.tasks.feedbackFor(ana, 'ana-claude').length, 2);
    assert.equal(code(() => store.tasks.feedbackFor(ben, 'ana-claude')), 'not_found');
  });
});

describe('escalation', () => {
  it('opens a stale question to the project and re-sends a stale approval once', () => {
    clock = Date.now();
    const task = accepted(ben, anaClaude);
    const q = store.questions.ask(anaClaude, task.id, 'Which region?');
    const approval = store.approvals.request(anaClaude, { room: 'api/general', summary: 'Deploy to prod', ttlSeconds: 86_400 });
    clock += 3 * 3600_000;
    assert.deepEqual(store.questions.escalateDue(), []);
    assert.equal(store.approvals.remindDue(), 0);
    clock += 2 * 3600_000;
    const [widened] = store.questions.escalateDue();
    assert.equal(widened?.audience, 'project');
    assert.equal(store.questions.escalateDue().length, 0);
    store.questions.answer(ana, q.id, 'us-east');
    assert.equal(store.approvals.remindDue(), 1);
    assert.equal(store.approvals.remindDue(), 0);
    assert.ok(store.read(ana, 'api/general', { threadId: approval.messageId }).some((m) => /Still waiting for a decision/.test(m.text) && m.mentions.includes('ana')));
    assert.equal(store.approvals.get(ana, approval.id).approver, 'ana', 'the approver never changes');
  });
});

describe('project files', () => {
  it('keep versions and refuse writes from a stale base', () => {
    const v1 = store.files.write(anaClaude, 'api', 'docs/design.md', '# Design\n', { note: 'first draft' });
    assert.equal(v1.version, 1);
    assert.equal(code(() => store.files.write(benCodex, 'api', 'docs/design.md', 'mine')), 'conflict');
    store.files.write(benCodex, 'api', 'docs/design.md', '# Design\nMore', { baseVersion: 1 });
    assert.equal(code(() => store.files.write(anaClaude, 'api', 'docs/design.md', 'stale', { baseVersion: 1 })), 'conflict');
    assert.equal(store.files.read(ana, 'api', 'docs/design.md').content, '# Design\nMore');
    assert.equal(store.files.read(ana, 'api', 'docs/design.md', 1).content, '# Design\n');
    assert.deepEqual(store.files.history(ana, 'api', 'docs/design.md').map((v) => v.author), ['ben-codex', 'ana-claude']);
    assert.equal(code(() => store.files.write(ana, 'api', '../etc/passwd', 'x')), 'invalid');
    assert.equal(code(() => store.files.write(ana, 'api', 'x.html', '<!doctype html><script>')), 'invalid');
    assert.equal(code(() => store.files.list(cara, 'api')), 'not_found');
    assert.equal(code(() => store.files.delete(anaClaude, 'api', 'docs/design.md')), 'forbidden');
    store.files.delete(ana, 'api', 'docs/design.md');
    assert.deepEqual(store.files.list(ana, 'api'), []);
  });
});

describe('secrets', () => {
  it('are write-only, leased per task with the owner\'s approval, and end with the task', () => {
    store.secrets.set(ben, 'api', 'STRIPE_TEST_KEY', 'sk_test_123', 'Stripe test mode');
    assert.equal(code(() => store.secrets.set(anaClaude, 'api', 'X', 'y')), 'forbidden');
    assert.equal(code(() => store.secrets.set(ana, 'api', 'STRIPE_TEST_KEY', 'mine')), 'forbidden');
    assert.deepEqual(store.secrets.list(anaClaude, 'api').map((s) => [s.name, s.owner]), [['STRIPE_TEST_KEY', 'ben']]);
    assert.ok(!JSON.stringify(store.secrets.list(ana, 'api')).includes('sk_test'));
    const task = accepted(ana, anaClaude);
    const lease = store.secrets.request(anaClaude, task.id, 'STRIPE_TEST_KEY', 'Run the payment tests');
    assert.equal(lease.state, 'pending');
    assert.equal(code(() => store.secrets.reveal(anaClaude, lease.id)), 'conflict');
    assert.equal(code(() => store.approvals.decide(ana, lease.approvalId, 'approved')), 'forbidden', 'only the secret owner decides');
    store.approvals.decide(ben, lease.approvalId, 'approved');
    assert.equal(store.secrets.reveal(anaClaude, lease.id).value, 'sk_test_123');
    assert.equal(code(() => store.secrets.reveal(benCodex, lease.id)), 'not_found');
    assert.equal(store.secrets.request(anaClaude, task.id, 'STRIPE_TEST_KEY', 'again').id, lease.id, 'an open lease is reused');
    const audit = JSON.stringify(store.audit.all(0));
    assert.ok(!audit.includes('sk_test_123'), 'values never reach the audit log');
    assert.ok(audit.includes('secret.use'));
    // Once shown, the value never comes back out through the agent: posts, task notes and run logs hide it.
    const posted = store.post(anaClaude, 'api/general', 'Using sk_test_123 for the run');
    assert.equal(posted.text, 'Using [hidden] for the run');
    const run = store.runs.record(anaClaude, task.id, { mode: 'start', startedAt: new Date().toISOString(), seconds: 1, outcome: 'code 0', log: '$ STRIPE=sk_test_123 npm test' });
    assert.equal(store.runs.log(ana, run.id).log, '$ STRIPE=[hidden] npm test');
    assert.equal(code(() => store.runs.log(anaClaude, run.id)), 'forbidden', 'only people read run logs');
    store.tasks.update(anaClaude, task.id, 'done', 'Charged with sk_test_123');
    assert.equal(store.tasks.get(ana, task.id).note, 'Charged with [hidden]');
    assert.equal(code(() => store.secrets.reveal(anaClaude, lease.id)), 'forbidden');
  });

  it('end when replaced, revoked, or the server has no key', () => {
    store.secrets.set(ben, 'api', 'TOKEN', 'one');
    const task = accepted(ana, anaClaude);
    const lease = store.secrets.request(anaClaude, task.id, 'TOKEN', 'deploy');
    store.approvals.decide(ben, lease.approvalId, 'approved');
    store.secrets.set(ben, 'api', 'TOKEN', 'two');
    assert.equal(code(() => store.secrets.reveal(anaClaude, lease.id)), 'forbidden');
    const again = store.secrets.request(anaClaude, task.id, 'TOKEN', 'deploy');
    store.approvals.decide(ben, again.approvalId, 'approved');
    assert.equal(store.secrets.reveal(anaClaude, again.id).value, 'two');
    store.secrets.revoke(ana, again.id);
    assert.equal(code(() => store.secrets.reveal(anaClaude, again.id)), 'forbidden');
    store.secrets.delete(ben, 'api', 'TOKEN');
    assert.deepEqual(store.secrets.list(ben, 'api'), []);
    const keyless = new Store(openDatabase(':memory:'));
    const p = keyless.createUser('p').participant;
    keyless.createProject(p, 'x');
    assert.equal(code(() => keyless.secrets.set(p, 'x', 'A', 'b')), 'invalid');
  });
});
