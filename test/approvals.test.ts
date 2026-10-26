import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { OrcoError, type Participant, Store } from '../src/store.js';

let now: number;
let store: Store;
let ana: Participant;
let ben: Participant;
let cara: Participant;
let anaClaude: Participant;
let anaHelper: Participant;
let benCodex: Participant;

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof OrcoError) return err.code;
    throw err;
  }
  return undefined;
}

beforeEach(() => {
  now = Date.parse('2026-10-27T15:00:00Z');
  store = new Store(openDatabase(':memory:'), { now: () => now });
  ana = store.createUser('ana').participant;
  ben = store.createUser('ben').participant;
  cara = store.createUser('cara').participant;
  anaClaude = store.createAgent('ana', 'ana-claude').participant;
  anaHelper = store.createAgent('ana', 'ana-helper').participant;
  benCodex = store.createAgent('ben', 'ben-codex').participant;
  store.createProject(ana, 'api');
  store.addMember(ana, 'api', 'ben');
  store.addMember(ana, 'api', 'cara');
});

describe('task consent between owners', () => {
  it('holds a task for another owner\'s agent until that owner approves', async () => {
    const task = store.tasks.create(anaClaude, { agent: 'ben-codex', room: 'api/general', request: 'update the SDK' });
    assert.equal(task.state, 'awaiting_approval');
    assert.deepEqual(await store.waitForMentions(benCodex, 0), [], 'the agent is not woken yet');
    const [ask] = await store.waitForMentions(ben, 0);
    assert.match(ask!.text, /^@ben ana-claude asks your agent ben-codex to: update the SDK/);
    assert.equal(ask!.approval?.kind, 'task');
    assert.equal(code(() => store.tasks.update(benCodex, task.id, 'accepted')), 'conflict');

    store.approvals.decide(ben, ask!.approval!.id, 'approved');
    assert.equal(store.tasks.get(ana, task.id).state, 'requested');
    const [go] = await store.waitForMentions(benCodex, 0);
    assert.equal(go!.text, `@ben-codex Task #${task.id} approved by ben. Go ahead.`);
    assert.equal(store.tasks.update(benCodex, task.id, 'accepted').state, 'accepted');
  });

  it('declines the task and tells the requester when the owner denies', async () => {
    const task = store.tasks.create(anaClaude, { agent: 'ben-codex', room: 'api/general', request: 'delete old branches' });
    const approvalId = store.tasks.get(ana, task.id) && store.approvals.list(ben, { forMe: true, pending: true })[0]!.id;
    store.approvals.decide(ben, approvalId, 'denied', 'Not this week');
    const declined = store.tasks.get(ana, task.id);
    assert.equal(declined.state, 'declined');
    assert.equal(declined.note, 'Not approved by ben: Not this week');
    const [ping] = await store.waitForMentions(anaClaude, 0);
    assert.match(ping!.text, /^@ana-claude Task #\d+ declined\. Not approved by ben: Not this week/);
  });

  it('only the agent owner decides, and only people', () => {
    store.tasks.create(anaClaude, { agent: 'ben-codex', room: 'api/general', request: 'x' });
    const [approval] = store.approvals.list(ben, { pending: true });
    assert.equal(code(() => store.approvals.decide(cara, approval!.id, 'approved')), 'forbidden');
    assert.equal(code(() => store.approvals.decide(ana, approval!.id, 'approved')), 'forbidden');
    assert.equal(code(() => store.approvals.decide(benCodex, approval!.id, 'approved')), 'forbidden');
  });

  it('never asks when the requester is the same owner', () => {
    const task = store.tasks.create(anaClaude, { agent: 'ana-helper', room: 'api/general', request: 'x' });
    assert.equal(task.state, 'requested');
    assert.equal(store.tasks.create(ana, { agent: 'ana-helper', room: 'api/general', request: 'y' }).state, 'requested');
  });

  it('follows the agent policy and the trust list', () => {
    store.setTaskPolicy(ben, 'ben-codex', 'owner_only');
    assert.equal(code(() => store.tasks.create(anaClaude, { agent: 'ben-codex', room: 'api/general', request: 'x' })), 'forbidden');
    store.setTaskPolicy(ben, 'ben-codex', 'open');
    assert.equal(store.tasks.create(anaClaude, { agent: 'ben-codex', room: 'api/general', request: 'x' }).state, 'requested');
    store.setTaskPolicy(ben, 'ben-codex', 'ask');
    store.setTrust(ben, 'ben-codex', 'ana', true);
    assert.equal(store.tasks.create(anaHelper, { agent: 'ben-codex', room: 'api/general', request: 'x' }).state, 'requested');
    assert.equal(store.tasks.create(cara, { agent: 'ben-codex', room: 'api/general', request: 'x' }).state, 'awaiting_approval');
  });

  it('can trust the requester while approving', () => {
    store.tasks.create(anaClaude, { agent: 'ben-codex', room: 'api/general', request: 'first' });
    const [approval] = store.approvals.list(ben, { pending: true });
    store.approvals.decide(ben, approval!.id, 'approved', undefined, { alwaysAllow: true });
    assert.deepEqual(store.agentSettings(ben, 'ben-codex').trusted, ['ana']);
    assert.equal(store.tasks.create(anaClaude, { agent: 'ben-codex', room: 'api/general', request: 'second' }).state, 'requested');
  });

  it('lets only the owner change an agent\'s settings', () => {
    assert.equal(code(() => store.setTaskPolicy(benCodex, 'ben-codex', 'open')), 'not_found');
    assert.equal(code(() => store.setTaskPolicy(ana, 'ben-codex', 'open')), 'not_found');
    assert.equal(code(() => store.setTrust(benCodex, 'ben-codex', 'ana', true)), 'not_found');
  });

  it('withdraws the approval when the requester cancels', () => {
    const task = store.tasks.create(anaClaude, { agent: 'ben-codex', room: 'api/general', request: 'x' });
    const [approval] = store.approvals.list(ben, { pending: true });
    store.tasks.update(anaClaude, task.id, 'cancelled');
    assert.equal(store.approvals.get(ben, approval!.id).state, 'expired');
    assert.equal(code(() => store.approvals.decide(ben, approval!.id, 'approved')), 'conflict');
  });
});

describe('action approvals', () => {
  it('asks the agent owner and tells the agent the answer', async () => {
    const approval = store.approvals.request(anaClaude, { room: 'api/general', summary: 'deploy v0.3 to prod', details: 'Rollback: redeploy v0.2' });
    assert.equal(approval.approver, 'ana');
    const [ask] = await store.waitForMentions(ana, 0);
    assert.equal(ask!.text, '@ana Approval needed: deploy v0.3 to prod\nRollback: redeploy v0.2');
    assert.equal(code(() => store.approvals.decide(ben, approval.id, 'approved')), 'forbidden');

    const waiting = store.approvals.wait(anaClaude, approval.id, 5_000);
    setTimeout(() => store.approvals.decide(ana, approval.id, 'approved', 'Go, I am watching'), 10);
    const decided = await waiting;
    assert.equal(decided.state, 'approved');
    assert.equal(decided.decidedBy, 'ana');
    const [answer] = await store.waitForMentions(anaClaude, 0);
    assert.equal(answer!.text, '@ana-claude Approved by ana.\nGo, I am watching');
  });

  it('lets other members decide in members mode, but not the requester\'s owner', async () => {
    const approval = store.approvals.request(anaClaude, { room: 'api/general', summary: 'merge #42', approver: 'members' });
    assert.equal(code(() => store.approvals.decide(ana, approval.id, 'approved')), 'forbidden');
    assert.equal(store.approvals.decide(cara, approval.id, 'denied').state, 'denied');
  });

  it('expires and cannot be decided afterwards', () => {
    const approval = store.approvals.request(anaClaude, { room: 'api/general', summary: 'x', ttlSeconds: 120 });
    now += 121_000;
    assert.equal(store.approvals.get(anaClaude, approval.id).state, 'expired');
    assert.equal(code(() => store.approvals.decide(ana, approval.id, 'approved')), 'conflict');
  });

  it('is hidden from people outside the project', () => {
    const approval = store.approvals.request(anaClaude, { room: 'api/general', summary: 'x' });
    const dave = store.createUser('dave').participant;
    assert.equal(code(() => store.approvals.get(dave, approval.id)), 'not_found');
    assert.deepEqual(store.approvals.list(dave), []);
  });
});

describe('audit log', () => {
  it('records who did what, in order', () => {
    const task = store.tasks.create(anaClaude, { agent: 'ana-helper', room: 'api/general', request: 'x' });
    store.tasks.update(anaHelper, task.id, 'done', 'ok');
    store.locks.acquire(anaHelper, 'api', 'deploy:prod', 60);
    store.locks.release(ben, 'api', 'deploy:prod', true);
    const actions = store.audit.list(ana, { project: 'api' }).map((e) => `${e.actor ?? '-'} ${e.action}`);
    assert.deepEqual(actions, [
      'ana project.create',
      'ana project.add_member',
      'ana project.add_member',
      'ana-claude message.post',
      'ana-claude task.create',
      'ana-helper message.post',
      'ana-helper task.update',
      'ana-helper lock.acquire',
      'ben lock.force_release',
      'ben message.post',
    ]);
  });

  it('cannot be changed or deleted', () => {
    assert.throws(() => store.db.exec("UPDATE audit SET action = 'nothing'"), /append-only/);
    assert.throws(() => store.db.exec('DELETE FROM audit'), /append-only/);
  });

  it('is readable by people only, and only for their projects', () => {
    store.post(anaClaude, 'api/general', 'inside api');
    const dave = store.createUser('dave').participant;
    assert.equal(code(() => store.audit.list(anaClaude)), 'forbidden');
    assert.equal(code(() => store.audit.list(dave, { project: 'api' })), 'not_found');
    assert.ok(store.audit.list(dave).every((e) => e.project === null));
    assert.ok(store.audit.list(ana).some((e) => e.project === 'api'));
  });
});
