import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';

let store: Store;
let clock: number;
let ana: Participant;
let bot: Participant;
let spare: Participant;
let botToken: string;

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as OrcoError).code;
  }
  return 'ok';
};

beforeEach(() => {
  clock = Date.parse('2026-11-02T12:00:00Z');
  store = new Store(openDatabase(':memory:'), { now: () => clock });
  ana = store.createUser('ana').participant;
  const made = store.createAgent('ana', 'ana-bot');
  bot = made.participant;
  botToken = made.token;
  spare = store.createAgent('ana', 'ana-spare').participant;
  store.createProject(ana, 'ops');
});

describe('task expiry (#59)', () => {
  it('cancels a task that did not start in time, tells the requester, and refuses to start it late', () => {
    const task = store.tasks.create(ana, { agent: 'ana-bot', room: 'ops/general', request: 'before the first wave', expiresAt: clock + 30 * 60_000 });
    assert.equal(task.expiresAt, '2026-11-02T12:30:00.000Z');
    assert.equal(code(() => store.tasks.create(ana, { agent: 'ana-bot', room: 'ops/general', request: 'x', expiresAt: clock - 1 })), 'invalid');
    clock += 31 * 60_000;
    assert.equal(code(() => store.tasks.update(bot, task.id, 'accepted')), 'conflict', 'never starts late');
    const closed = store.tasks.get(ana, task.id);
    assert.equal(closed.state, 'cancelled');
    assert.match(closed.note ?? '', /^Expired: it had not started by 2026-11-02 12:30 UTC/);
    const notice = store.read(ana, 'ops/general', { threadId: task.messageId }).at(-1)!;
    assert.deepEqual(notice.mentions, ['ana'], 'the requester hears about it');
    const other = store.tasks.create(ana, { agent: 'ana-bot', room: 'ops/general', request: 'soon', expiresAt: clock + 60_000 });
    clock += 2 * 60_000;
    assert.deepEqual(store.tasks.expireDue().map((t) => t.id), [other.id], 'the sweep catches the rest');
    const running = store.tasks.create(ana, { agent: 'ana-bot', room: 'ops/general', request: 'running', expiresAt: clock + 60_000 });
    store.tasks.update(bot, running.id, 'accepted');
    clock += 2 * 60_000;
    assert.deepEqual(store.tasks.expireDue(), [], 'a task already running is never stopped');
  });
});

describe('one bridge per task (#58)', () => {
  it('lets only one bridge claim a run, and lets go when it ends or the task closes', () => {
    const task = store.tasks.create(ana, { agent: 'ana-bot', room: 'ops/general', request: 'deploy' });
    store.tasks.claimRun(bot, task.id, 'laptop:aaaa', 600);
    assert.equal(store.tasks.get(ana, task.id).runningOn, 'laptop');
    assert.equal(code(() => store.tasks.claimRun(bot, task.id, 'desktop:bbbb', 600)), 'conflict');
    assert.equal(code(() => store.tasks.claimRun(spare, task.id, 'desktop:bbbb', 600)), 'forbidden', 'only its assignee');
    store.tasks.releaseRun(bot, task.id, 'desktop:bbbb');
    assert.equal(store.tasks.get(ana, task.id).runningOn, 'laptop', 'only the holder lets go');
    store.tasks.releaseRun(bot, task.id, 'laptop:aaaa');
    store.tasks.claimRun(bot, task.id, 'desktop:bbbb', 600);
    clock += 601_000;
    store.tasks.claimRun(bot, task.id, 'laptop:cccc', 600);
    assert.equal(store.tasks.get(ana, task.id).runningOn, 'laptop', 'a claim from a dead bridge runs out');
    assert.equal(store.tasks.claimRun(bot, task.id, 'laptop:dddd', 600, { recover: true }).recoveries, 1, 'the same computer, restarted, takes it back');
    store.tasks.update(bot, task.id, 'accepted');
    store.tasks.update(bot, task.id, 'done');
    assert.equal(store.tasks.get(ana, task.id).runningOn, null);
  });

  it('tells the older bridge stream that another one took over', async () => {
    const { app, close } = createApp(store);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const open = (instance: string) => fetch(`${base}/api/events?bridge=1&instance=${instance}`, { headers: { authorization: `Bearer ${botToken}` } });
    const first = await open('old-pc:aaaa');
    const reader = first.body!.getReader();
    let text = '';
    const read = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += new TextDecoder().decode(value);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await open('new-pc:bbbb');
    await read;
    assert.match(text, /event: takeover\ndata: \{"host":"new-pc"\}/);
    await second.body!.cancel();
    await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
});

describe('agents lost mid-task (#57)', () => {
  it('only the owner sets what happens, to their own agents', () => {
    assert.equal(code(() => store.tasks.setLostPolicy(bot, 'ana-bot', { minutes: 10, fallback: null, releaseLocks: false })), 'forbidden');
    const ben = store.createUser('ben').participant;
    store.createAgent('ben', 'ben-bot');
    assert.equal(code(() => store.tasks.setLostPolicy(ben, 'ana-bot', { minutes: 10, fallback: null, releaseLocks: false })), 'forbidden');
    assert.equal(code(() => store.tasks.setLostPolicy(ana, 'ana-bot', { minutes: 10, fallback: 'ben-bot', releaseLocks: false })), 'invalid');
    assert.equal(code(() => store.tasks.setLostPolicy(ana, 'ana-bot', { minutes: 1, fallback: null, releaseLocks: false })), 'invalid');
    assert.deepEqual(store.tasks.setLostPolicy(ana, 'ana-bot', { minutes: 10, fallback: 'ana-spare', releaseLocks: true }), { minutes: 10, fallback: 'ana-spare', releaseLocks: true });
  });

  it('tells the requester with the checkpoint, hands the task over and frees the locks', () => {
    store.tasks.setLostPolicy(ana, 'ana-bot', { minutes: 10, fallback: 'ana-spare', releaseLocks: true });
    const task = store.tasks.create(ana, { agent: 'ana-bot', room: 'ops/general', request: 'rotate the logs' });
    store.tasks.update(bot, task.id, 'accepted');
    store.tasks.checkpoint(bot, task.id, 'Rotated web-1 and web-2; web-3 next');
    store.locks.acquire(bot, 'ops', 'deploy:prod', 3600);
    clock += 5 * 60_000;
    assert.deepEqual(store.tasks.sweepLost(), [], 'not yet');
    clock += 6 * 60_000;
    const [handed] = store.tasks.sweepLost();
    assert.equal(handed?.assignee, 'ana-spare');
    assert.equal(store.tasks.get(ana, task.id).state, 'declined');
    assert.equal(store.tasks.get(ana, handed!.id).checkpoint?.text, 'Rotated web-1 and web-2; web-3 next', 'the checkpoint goes along');
    assert.deepEqual(store.locks.list(ana, 'ops'), []);
    const notice = store.read(ana, 'ops/general', { threadId: task.messageId }).find((m) => m.text.includes('treated as lost'))!;
    assert.match(notice.text, /not been heard from in 11 minutes/);
    assert.match(notice.text, /web-3 next/);
    assert.deepEqual(store.tasks.sweepLost(), [], 'once');
  });
});
