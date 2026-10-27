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

beforeEach(() => {
  store = new Store(openDatabase(':memory:'));
  ana = store.createUser('ana').participant;
  ben = store.createUser('ben').participant;
  cara = store.createUser('cara').participant;
  anaClaude = store.createAgent('ana', 'ana-claude').participant;
  benCodex = store.createAgent('ben', 'ben-codex').participant;
  store.createProject(ana, 'api');
  store.addMember(ana, 'api', 'ben');
  store.setTaskPolicy(ana, 'ana-claude', 'open');
});

function acceptedTask(requester = ben) {
  const task = store.tasks.create(requester, { agent: 'ana-claude', room: 'api/general', request: 'deploy the fix' });
  store.tasks.update(anaClaude, task.id, 'accepted');
  return task;
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as OrcoError).code;
  }
  return 'ok';
};

describe('questions', () => {
  it('parks the task in needs_input and pings the requester', () => {
    const task = acceptedTask();
    const q = store.questions.ask(anaClaude, task.id, 'Staging or prod?');
    assert.equal(q.target, 'ben');
    const now = store.tasks.get(ben, task.id);
    assert.equal(now.state, 'needs_input');
    assert.equal(now.question?.question, 'Staging or prod?');
    const ping = store.unseenMentions(ben).at(-1)!;
    assert.match(ping.text, /^@ben Question on task #\d+: Staging or prod\?$/);
    assert.equal(ping.threadId, task.messageId);
    assert.equal(ping.question?.state, 'open');
  });

  it('can ask the agent owner instead', () => {
    const task = acceptedTask();
    assert.equal(store.questions.ask(anaClaude, task.id, 'May I restart the db?', 'owner').target, 'ana');
  });

  it('wakes the agent with the answer and goes back to accepted', () => {
    const task = acceptedTask();
    const q = store.questions.ask(anaClaude, task.id, 'Staging or prod?');
    store.questions.answer(ben, q.id, 'Staging only.');
    const now = store.tasks.get(ana, task.id);
    assert.equal(now.state, 'accepted');
    assert.equal(now.question?.answer, 'Staging only.');
    assert.equal(now.question?.answeredBy, 'ben');
    assert.match(store.unseenMentions(anaClaude).at(-1)!.text, /Answer to your question on task #\d+: Staging only\./);
  });

  it('lets only the person asked, their owner, or the agent owner answer', () => {
    const task = acceptedTask();
    const q = store.questions.ask(anaClaude, task.id, 'Staging or prod?');
    store.addMember(ana, 'api', 'cara');
    assert.equal(code(() => store.questions.answer(cara, q.id, 'prod')), 'forbidden');
    store.questions.answer(ana, q.id, 'staging');
    assert.equal(code(() => store.questions.answer(ben, q.id, 'again')), 'conflict');
  });

  it('only lets the assignee ask, once at a time, on an accepted task', () => {
    const task = store.tasks.create(ben, { agent: 'ana-claude', room: 'api/general', request: 'x' });
    assert.equal(code(() => store.questions.ask(anaClaude, task.id, 'hm?')), 'conflict');
    store.tasks.update(anaClaude, task.id, 'accepted');
    assert.equal(code(() => store.questions.ask(benCodex, task.id, 'hm?')), 'forbidden');
    store.questions.ask(anaClaude, task.id, 'first?');
    assert.equal(code(() => store.questions.ask(anaClaude, task.id, 'second?')), 'conflict');
  });

  it('lets the agent finish or fail while waiting, which closes the question', () => {
    const task = acceptedTask();
    const q = store.questions.ask(anaClaude, task.id, 'Staging or prod?');
    store.tasks.update(anaClaude, task.id, 'failed', 'gave up');
    assert.equal(store.questions.get(ben, q.id).state, 'cancelled');
    assert.equal(store.questions.waitingOn(ben).length, 0);
  });

  it('hands a resume to the bridge once', () => {
    const task = acceptedTask();
    const q = store.questions.ask(anaClaude, task.id, 'Staging or prod?');
    assert.equal(store.questions.claimResume(anaClaude, q.id), false);
    store.questions.answer(ben, q.id, 'staging');
    assert.equal(store.questions.claimResume(anaClaude, q.id), true);
    assert.equal(store.questions.claimResume(anaClaude, q.id), false);
    assert.equal(code(() => store.questions.claimResume(benCodex, q.id)), 'not_found');
  });

  it('lists questions waiting on a person, including ones asked of their agents', () => {
    const task = acceptedTask();
    store.questions.ask(anaClaude, task.id, 'Staging or prod?');
    assert.deepEqual(store.questions.waitingOn(ben).map((q) => q.question), ['Staging or prod?']);
    assert.equal(store.questions.waitingOn(ana).length, 0);
    store.setTaskPolicy(ben, 'ben-codex', 'open');
    const fromAgent = store.tasks.create(benCodex, { agent: 'ana-claude', room: 'api/general', request: 'y' });
    store.tasks.update(anaClaude, fromAgent.id, 'accepted');
    store.questions.ask(anaClaude, fromAgent.id, 'Which branch?');
    assert.deepEqual(store.questions.waitingOn(ben).map((q) => q.target), ['ben', 'ben-codex']);
    assert.deepEqual(store.questions.waitingOn(benCodex).map((q) => q.question), ['Which branch?']);
  });

  it('keeps questions out of rooms the person cannot see', () => {
    const task = acceptedTask();
    const q = store.questions.ask(anaClaude, task.id, 'Staging or prod?');
    assert.equal(code(() => store.questions.get(cara, q.id)), 'not_found');
  });
});

describe('where a task came from', () => {
  it('records the chain of requesters back to the person who started it', () => {
    store.setTaskPolicy(ben, 'ben-codex', 'open');
    const root = store.tasks.create(ana, { agent: 'ben-codex', room: 'api/general', request: 'ship it' });
    store.tasks.update(benCodex, root.id, 'accepted');
    const sub = store.tasks.create(benCodex, { agent: 'ana-claude', room: 'api/general', request: 'write the changelog' });
    assert.deepEqual(sub.chain, ['ana', 'ben-codex']);
    assert.deepEqual(store.message(sub.messageId).task?.chain, ['ana', 'ben-codex']);
    assert.deepEqual(root.chain, ['ana']);
  });
});

describe('capabilities', () => {
  it('tells an agent its policy, projects, limits and rules', () => {
    store.setTrust(ana, 'ana-claude', 'ben', true);
    store.setTaskPolicy(ana, 'ana-claude', 'ask');
    const caps = store.capabilities(anaClaude);
    assert.equal(caps.owner, 'ana');
    assert.deepEqual(caps.projects, ['api']);
    assert.equal(caps.taskPolicy, 'ask');
    assert.match(caps.whoCanAssignYou!, /pre-approved: ben/);
    assert.equal(caps.canPlan, false);
    assert.equal(caps.limits?.maxTaskDepth, 4);
    assert.ok(caps.rules.some((r) => r.includes('ask_question')));
  });

  it('tells a person what only people can do', () => {
    const caps = store.capabilities(ana);
    assert.equal(caps.canPlan, true);
    assert.equal(caps.taskPolicy, undefined);
  });
});
