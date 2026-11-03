import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { type Message, type OrcoError, type Participant, Store } from '../src/store.js';

let store: Store;
let clock: number;
let carlos: Participant;
let carlosToken: string;
let ana: Participant;
let ben: Participant;
let bot: Participant;
let base: string;
let stop: () => Promise<void>;

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as OrcoError).code;
  }
  return 'ok';
};

before(async () => {
  clock = Date.now();
  store = new Store(openDatabase(':memory:'), { now: () => clock });
  const made = store.createUser('carlos');
  carlos = made.participant;
  carlosToken = made.token;
  ana = store.createUser('ana').participant;
  ben = store.createUser('ben').participant;
  bot = store.createAgent('carlos', 'carlos-bot').participant;
  store.createProject(carlos, 'web');
  store.addMember(carlos, 'web', 'ana');
  store.addMember(carlos, 'web', 'ben');
  const { app, close } = createApp(store);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stop = async () => {
    await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
});

after(async () => {
  await stop();
});

describe('editing your last message (#93)', () => {
  it('changes the text, pings no one new, and keeps the original in the audit log', async () => {
    const posted = store.post(carlos, 'web/general', 'Deploy at 5 @ana');
    const edits: Message[] = [];
    store.events.on('message_edit', (m: Message) => edits.push(m));
    const res = await fetch(`${base}/api/messages/${posted.id}/edit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${carlosToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Deploy at 6 @ana @ben' }),
    });
    assert.equal(res.status, 200);
    const edited = (await res.json()) as Message;
    assert.equal(edited.text, 'Deploy at 6 @ana @ben');
    assert.ok(edited.editedAt);
    assert.deepEqual(edited.mentions, ['ana'], 'an edit pings no one new');
    assert.deepEqual(store.unseenMentions(ben), []);
    assert.equal(edits.length, 1, 'open browsers hear about it');
    const audit = store.audit.list(carlos, { limit: 50 }).find((e) => e.action === 'message.edit');
    assert.deepEqual(audit?.detail, { from: 'Deploy at 5 @ana', to: 'Deploy at 6 @ana @ben' });
  });

  it('is for your own plain messages, within a day', () => {
    const mine = store.post(carlos, 'web/general', 'Lunch at noon');
    assert.equal(code(() => store.editMessage(ana, mine.id, 'mine now')), 'forbidden', 'not someone else\'s');
    const botPost = store.post(bot, 'web/general', 'Build is green');
    assert.equal(code(() => store.editMessage(bot, botPost.id, 'Build is red')), 'forbidden', 'agents do not rewrite what people read');
    const task = store.tasks.create(carlos, { agent: 'carlos-bot', room: 'web/general', request: 'Bump the SDK' });
    assert.equal(code(() => store.editMessage(carlos, task.messageId, '@carlos-bot do something else')), 'conflict', 'a task message stays as asked');
    assert.equal(code(() => store.editMessage(carlos, mine.id, '   ')), 'invalid');
    clock += 25 * 3600_000;
    assert.equal(code(() => store.editMessage(carlos, mine.id, 'Lunch at one')), 'conflict', 'a day later it stands');
  });
});
