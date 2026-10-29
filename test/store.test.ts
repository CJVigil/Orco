import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { OrcoError, type Participant, Store } from '../src/store.js';

let store: Store;
let ana: Participant;
let ben: Participant;
let anaClaude: Participant;
let benCodex: Participant;

beforeEach(() => {
  store = new Store(openDatabase(':memory:'));
  ana = store.createUser('ana').participant;
  ben = store.createUser('ben').participant;
  anaClaude = store.createAgent('ana', 'ana-claude').participant;
  benCodex = store.createAgent('ben', 'ben-codex').participant;
});

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof OrcoError) return err.code;
    throw err;
  }
  return undefined;
}

describe('participants', () => {
  it('authenticates by token and rejects unknown tokens', () => {
    const { token } = store.createUser('cara');
    assert.equal(store.authenticate(token)?.name, 'cara');
    assert.equal(store.authenticate('orco_u_nope'), null);
  });

  it('shares one namespace between users and agents', () => {
    assert.equal(code(() => store.createAgent('ana', 'ben')), 'conflict');
  });

  it('rejects names that are not lowercase slugs', () => {
    assert.equal(code(() => store.createUser('Ana')), 'invalid');
    assert.equal(code(() => store.createUser('-ana')), 'invalid');
  });

  it('invalidates the old token on rotation', () => {
    const { token } = store.createUser('cara');
    const next = store.rotateToken('cara');
    assert.equal(store.authenticate(token), null);
    assert.equal(store.authenticate(next)?.name, 'cara');
  });
});

describe('projects and rooms', () => {
  it('starts with server-wide rooms everyone can see', () => {
    assert.deepEqual(
      store.listRooms(benCodex).map((r) => r.ref),
      ['announcements', 'lobby'],
    );
  });

  it('makes the creator an admin and adds #general', () => {
    assert.equal(code(() => store.createProject(anaClaude, 'api')), 'forbidden', 'only people create projects');
    store.createProject(ana, 'api');
    assert.deepEqual(store.listProjects(ana), [{ id: 1, name: 'api', members: ['ana'], ticketKey: 'API', role: 'admin' }]);
    assert.ok(store.listRooms(ana).some((r) => r.ref === 'api/general'));
  });

  it('hides project rooms from non-members and their agents', () => {
    store.createProject(ana, 'api');
    assert.equal(code(() => store.room(benCodex, 'api/general')), 'not_found');
    assert.equal(code(() => store.post(benCodex, 'api/general', 'hi')), 'not_found');
    store.addMember(ana, 'api', 'ben');
    assert.equal(store.room(benCodex, 'api/general').ref, 'api/general');
  });

  it('refuses duplicate projects and rooms', () => {
    store.createProject(ana, 'api');
    assert.equal(code(() => store.createProject(ben, 'api')), 'conflict');
    store.createRoom(ana, 'api', 'backend');
    assert.equal(code(() => store.createRoom(ana, 'api', 'backend')), 'conflict');
  });

  it('accepts room refs with a leading #', () => {
    store.createProject(ana, 'api');
    assert.equal(store.room(ana, '#lobby').ref, 'lobby');
    assert.equal(store.room(ana, 'api/#general').ref, 'api/general');
  });
});

describe('messages', () => {
  beforeEach(() => {
    store.createProject(ana, 'api');
    store.addMember(ana, 'api', 'ben');
  });

  it('reads messages oldest first and pages with since_id', () => {
    const first = store.post(ana, 'api/general', 'one');
    store.post(ben, 'api/general', 'two');
    assert.deepEqual(
      store.read(ana, 'api/general').map((m) => m.text),
      ['one', 'two'],
    );
    assert.deepEqual(
      store.read(ana, 'api/general', { sinceId: first.id }).map((m) => m.text),
      ['two'],
    );
  });

  it('keeps replies in the root message thread', () => {
    const root = store.post(ana, 'api/general', 'root');
    const reply = store.post(ben, 'api/general', 'reply', root.id);
    const nested = store.post(ana, 'api/general', 'nested', reply.id);
    assert.equal(nested.threadId, root.id);
    assert.deepEqual(
      store.read(ana, 'api/general', { threadId: root.id }).map((m) => m.text),
      ['root', 'reply', 'nested'],
    );
  });

  it('refuses a thread from another room', () => {
    const other = store.post(ana, 'lobby', 'elsewhere');
    assert.equal(code(() => store.post(ana, 'api/general', 'x', other.id)), 'not_found');
  });

  it('records mentions only for participants who can see the room', () => {
    store.createUser('cara');
    const message = store.post(anaClaude, 'api/general', '@ben-codex please update the SDK, cc @cara @nobody');
    assert.deepEqual(message.mentions, ['ben-codex']);
    assert.equal(message.owner, 'ana');
  });

  it('ignores emails and self-mentions', () => {
    const message = store.post(ana, 'api/general', 'mail ana@ben.dev or ping @ana');
    assert.deepEqual(message.mentions, []);
  });
});

describe('wait_for_mentions', () => {
  beforeEach(() => {
    store.createProject(ana, 'api');
    store.addMember(ana, 'api', 'ben');
  });

  it('returns waiting mentions at once and only once', async () => {
    store.post(anaClaude, 'api/general', '@ben-codex first');
    const got = await store.waitForMentions(benCodex, 1000);
    assert.deepEqual(
      got.map((m) => m.text),
      ['@ben-codex first'],
    );
    assert.deepEqual(await store.waitForMentions(benCodex, 0), []);
  });

  it('wakes up when a mention arrives', async () => {
    const waiting = store.waitForMentions(benCodex, 5000);
    setTimeout(() => store.post(anaClaude, 'api/general', 'hey @ben-codex'), 20);
    const started = Date.now();
    const got = await waiting;
    assert.equal(got.length, 1);
    assert.ok(Date.now() - started < 2000);
  });

  it('times out with nothing', async () => {
    assert.deepEqual(await store.waitForMentions(benCodex, 30), []);
  });

  it('stops waiting when aborted', async () => {
    const controller = new AbortController();
    const waiting = store.waitForMentions(benCodex, 5000, controller.signal);
    controller.abort();
    assert.deepEqual(await waiting, []);
  });
});
