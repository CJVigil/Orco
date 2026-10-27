import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { OrcoError, type Participant, Store } from '../src/store.js';

let store: Store;
let ana: Participant;
let ben: Participant;
let anaClaude: Participant;
let benCodex: Participant;
let caraBot: Participant;

function setup(limits = {}) {
  store = new Store(openDatabase(':memory:'), { limits });
  ana = store.createUser('ana').participant;
  ben = store.createUser('ben').participant;
  store.createUser('cara');
  anaClaude = store.createAgent('ana', 'ana-claude').participant;
  benCodex = store.createAgent('ben', 'ben-codex').participant;
  caraBot = store.createAgent('cara', 'cara-bot').participant;
  store.createProject(ana, 'api');
  store.addMember(ana, 'api', 'ben');
  store.setTaskPolicy(ben, 'ben-codex', 'open');
  store.setTaskPolicy(ana, 'ana-claude', 'open');
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof OrcoError) return err.code;
    throw err;
  }
  return undefined;
}

beforeEach(() => setup());

describe('creating tasks', () => {
  it('posts a mention, links the task to it, and wakes the assignee', async () => {
    const task = store.tasks.create(anaClaude, { agent: '@ben-codex', room: 'api/general', request: 'update the SDK types' });
    assert.equal(task.state, 'requested');
    assert.equal(task.depth, 0);
    const [mention] = await store.waitForMentions(benCodex, 0);
    assert.equal(mention?.text, '@ben-codex update the SDK types');
    assert.deepEqual(mention?.task, { id: task.id, state: 'requested', assignee: 'ben-codex', since: mention?.task?.since, chain: ['ana-claude'] });
    assert.ok(mention?.task?.since);
  });

  it('only assigns to agents that can see the room', () => {
    assert.equal(code(() => store.tasks.create(ana, { agent: 'cara-bot', room: 'api/general', request: 'x' })), 'forbidden');
    assert.equal(code(() => store.tasks.create(ana, { agent: 'ben', room: 'api/general', request: 'x' })), 'not_found');
    assert.equal(code(() => store.tasks.create(caraBot, { agent: 'ben-codex', room: 'api/general', request: 'x' })), 'not_found');
    assert.equal(code(() => store.tasks.create(anaClaude, { agent: 'ana-claude', room: 'api/general', request: 'x' })), 'invalid');
  });
});

describe('task lifecycle', () => {
  it('lets the assignee accept and finish, and notifies the requester', async () => {
    const task = store.tasks.create(anaClaude, { agent: 'ben-codex', room: 'api/general', request: 'update the SDK' });
    store.tasks.update(benCodex, task.id, 'accepted');
    assert.deepEqual(await store.waitForMentions(anaClaude, 0), [], 'accepting does not ping the requester');
    const done = store.tasks.update(benCodex, task.id, 'done', 'Merged in #42');
    assert.equal(done.state, 'done');
    assert.equal(done.note, 'Merged in #42');
    const [ping] = await store.waitForMentions(anaClaude, 0);
    assert.equal(ping?.text, '@ana-claude Task #1 done.\nMerged in #42');
    assert.equal(ping?.threadId, task.messageId);
  });

  it('enforces who can move a task and where', () => {
    const task = store.tasks.create(anaClaude, { agent: 'ben-codex', room: 'api/general', request: 'x' });
    assert.equal(code(() => store.tasks.update(anaClaude, task.id, 'done')), 'forbidden');
    assert.equal(code(() => store.tasks.update(ben, task.id, 'accepted')), 'forbidden');
    store.tasks.update(benCodex, task.id, 'declined', 'Not my area');
    assert.equal(code(() => store.tasks.update(benCodex, task.id, 'accepted')), 'conflict');
  });

  it('lets the requester or a human owner cancel an open task', () => {
    const first = store.tasks.create(anaClaude, { agent: 'ben-codex', room: 'api/general', request: 'a' });
    assert.equal(store.tasks.update(ana, first.id, 'cancelled').state, 'cancelled');
    const second = store.tasks.create(anaClaude, { agent: 'ben-codex', room: 'api/general', request: 'b' });
    assert.equal(store.tasks.update(ben, second.id, 'cancelled').state, 'cancelled');
    const third = store.tasks.create(anaClaude, { agent: 'ben-codex', room: 'api/general', request: 'c' });
    assert.equal(code(() => store.tasks.update(benCodex, third.id, 'cancelled')), 'forbidden');
  });

  it('lists open tasks for the assignee and hides other projects', () => {
    store.tasks.create(anaClaude, { agent: 'ben-codex', room: 'api/general', request: 'a' });
    const closed = store.tasks.create(anaClaude, { agent: 'ben-codex', room: 'api/general', request: 'b' });
    store.tasks.update(benCodex, closed.id, 'done');
    assert.deepEqual(
      store.tasks.list(benCodex, { assignedToMe: true, open: true }).map((t) => t.request),
      ['a'],
    );
    assert.deepEqual(store.tasks.list(caraBot), []);
  });
});

describe('loop protection', () => {
  it('chains sub-tasks automatically and stops at the depth limit', () => {
    setup({ maxTaskDepth: 2 });
    let task = store.tasks.create(ana, { agent: 'ana-claude', room: 'api/general', request: 'start' });
    const agents = [anaClaude, benCodex];
    for (let depth = 1; depth <= 2; depth++) {
      const worker = agents[(depth - 1) % 2]!;
      const next = agents[depth % 2]!;
      store.tasks.update(worker, task.id, 'accepted');
      task = store.tasks.create(worker, { agent: next.name, room: 'api/general', request: `hop ${depth}` });
      assert.equal(task.depth, depth);
    }
    store.tasks.update(anaClaude, task.id, 'accepted');
    assert.equal(code(() => store.tasks.create(anaClaude, { agent: 'ben-codex', room: 'api/general', request: 'hop 3' })), 'forbidden');
  });

  it('rate limits agent posts but not humans', () => {
    setup({ agentPostsPerMinute: 3 });
    for (let i = 0; i < 3; i++) store.post(anaClaude, 'lobby', `msg ${i}`);
    assert.equal(code(() => store.post(anaClaude, 'lobby', 'one too many')), 'rate_limited');
    for (let i = 0; i < 5; i++) store.post(ana, 'lobby', `human ${i}`);
  });

  it('lets an agent post again after a minute', () => {
    let now = 0;
    store = new Store(openDatabase(':memory:'), { now: () => now, limits: { agentPostsPerMinute: 1 } });
    store.createUser('ana');
    const bot = store.createAgent('ana', 'bot').participant;
    store.post(bot, 'lobby', 'one');
    assert.equal(code(() => store.post(bot, 'lobby', 'two')), 'rate_limited');
    now += 61_000;
    store.post(bot, 'lobby', 'two');
  });
});
