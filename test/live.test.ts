import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { Presence, type PresenceChange } from '../src/presence.js';
import { roomMatcher } from '../src/rooms.js';
import { type Participant, Store } from '../src/store.js';
import { waitFor } from '../src/waits.js';

let store: Store;
let base: string;
let stop: () => Promise<void>;
let ana: Participant;
let anaToken: string;
let bot: Participant;

before(async () => {
  store = new Store(openDatabase(':memory:'));
  const created = store.createUser('ana');
  ana = created.participant;
  anaToken = created.token;
  bot = store.createAgent('ana', 'ana-bot').participant;
  store.createProject(ana, 'ops');
  store.createRoom(ana, 'ops', 'alerts');
  store.createProject(ana, 'api');
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

/** Reads an event stream until `until` matches, running `during` once it is ready. */
async function events(path: string, headers: Record<string, string>, until: (event: string, data: any) => boolean, during: () => void = () => {}) {
  const controller = new AbortController();
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${anaToken}`, ...headers }, signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out: { id: string | null; event: string; data: any }[] = [];
  let buffer = '';
  let ran = false;
  while (!out.some((e) => until(e.event, e.data))) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (event && data) out.push({ id: /^id: (.*)$/m.exec(chunk)?.[1] ?? null, event, data: JSON.parse(data) });
    }
    if (!ran && out.some((e) => e.event === 'ready')) {
      ran = true;
      during();
    }
  }
  controller.abort();
  return out;
}

describe('mentions in batches (#63)', () => {
  it('caps a batch, and with after_id hands it out again until acknowledged', async () => {
    const ids = [1, 2, 3].map((n) => store.post(ana, 'ops/general', `@ana-bot job ${n}`).id);
    const first = await store.waitForMentionBatch(bot, 0, undefined, { afterId: 0, limit: 2 });
    assert.deepEqual(first.messages.map((m) => m.id), ids.slice(0, 2));
    assert.equal(first.remaining, 1);
    const again = await store.waitForMentionBatch(bot, 0, undefined, { afterId: 0, limit: 2 });
    assert.deepEqual(again.messages.map((m) => m.id), ids.slice(0, 2), 'a lost reply is not a lost mention');
    const next = await store.waitForMentionBatch(bot, 0, undefined, { afterId: ids[1], limit: 2 });
    assert.deepEqual(next.messages.map((m) => m.id), [ids[2]]);
    const plain = await store.waitForMentionBatch(bot, 0);
    assert.deepEqual(plain.messages.map((m) => m.id), [ids[2]], 'without after_id: handed out once');
    assert.equal((await store.waitForMentionBatch(bot, 0)).messages.length, 0);
  });
});

describe('following rooms (#64)', () => {
  it('matches rooms by pattern', () => {
    const m = roomMatcher('ops/*, */alerts');
    assert.ok(m.room('ops/general') && m.room('api/alerts') && !m.room('api/general') && !m.room('lobby'));
    assert.ok(roomMatcher(['*']).room('lobby'));
    assert.ok(m.project('ops') && m.project('api') && !m.project(null));
    assert.throws(() => roomMatcher('ops/x/y'), /not a room pattern/);
  });

  it('wakes wait_for on a new message in a followed room, with its id', async () => {
    const before = store.latestMessageId();
    const pending = waitFor(store, bot, { rooms: { patterns: ['*/alerts'] } }, 5_000);
    store.post(ana, 'api/general', 'not this one');
    const alert = store.post(ana, 'ops/alerts', 'disk 91% on db-1');
    const result = await pending;
    assert.deepEqual(result.messages, [alert.id]);
    assert.match(result.fired[0]!, /1 new message in ops\/alerts/);
    const later = await waitFor(store, bot, { rooms: { patterns: ['ops/*'], afterId: before } }, 0);
    assert.deepEqual(later.messages, [alert.id], 'after_id picks up from there');
  });
});

describe('event stream (#60, #62, #64)', () => {
  it('puts ids on frames, replays what was missed after Last-Event-ID, then asks for a resync', async () => {
    const seen = store.post(ana, 'lobby', 'before the drop');
    const missed = [store.post(ana, 'lobby', 'missed one'), store.post(ana, 'ops/general', 'missed two')];
    const out = await events('/api/events', { 'Last-Event-ID': String(seen.id) }, (event) => event === 'resync');
    assert.ok(out.every((e) => e.id !== null), 'every frame has an id');
    assert.deepEqual(out.filter((e) => e.event === 'message').map((e) => e.data.id), missed.map((m) => m.id));
    assert.deepEqual(out.find((e) => e.event === 'resync')!.data, { replayed: 2, complete: true });
    assert.equal(out.find((e) => e.event === 'message')!.id, String(missed[0]!.id));
  });

  it('sends room statuses on connect and when they change, and filters by rooms and types', async () => {
    store.roomStatus.set(ana, 'ops/alerts', 'wave 2 released');
    const out = await events('/api/events?rooms=ops/*&types=message,status', {}, (event, data) => event === 'message' && data.text === 'in ops', () => {
      store.post(ana, 'api/general', 'in api');
      store.roomStatus.set(ana, 'ops/alerts', 'aisle 12 blocked', 30);
      store.post(ana, 'ops/general', 'in ops');
    });
    const statuses = out.filter((e) => e.event === 'status').map((e) => e.data.status.text);
    assert.deepEqual(statuses, ['wave 2 released', 'aisle 12 blocked']);
    assert.deepEqual(out.filter((e) => e.event === 'message').map((e) => e.data.text), ['in ops'], 'api rooms filtered out');
    assert.ok(!out.some((e) => !['ready', 'status', 'message'].includes(e.event)), 'only the asked-for types');
  });

  it('expires a room status on its own', () => {
    const clock = Date.now();
    const local = new Store(openDatabase(':memory:'), { now: () => now });
    let now = clock;
    const carlos = local.createUser('carlos').participant;
    local.roomStatus.set(carlos, 'lobby', 'deploy frozen', 10);
    assert.equal(local.roomStatus.of(local.room(carlos, 'lobby'))?.text, 'deploy frozen');
    now += 11 * 60_000;
    assert.equal(local.roomStatus.of(local.room(carlos, 'lobby')), null);
    local.roomStatus.sweep();
    assert.equal((local.db.prepare('SELECT count(*) AS n FROM room_status').get() as { n: number }).n, 0);
    assert.throws(() => local.roomStatus.set(carlos, 'lobby', 'x'.repeat(281)), /at most 280/);
  });
});

describe('presence (#61)', () => {
  it('says who changed and why, and keeps a last-seen time', () => {
    let now = 1_000_000;
    const saved: [number, string][] = [];
    const presence = new Presence(() => now, (id, at) => saved.push([id, at]));
    const changes: PresenceChange[] = [];
    presence.events.on('change', (_id: number, change: PresenceChange) => changes.push(change));
    presence.touch(7);
    assert.deepEqual(changes.at(-1), { id: 7, status: 'online', previous: 'offline', lastSeen: new Date(now).toISOString(), reason: 'activity' });
    now += 10_000;
    presence.touch(7);
    assert.equal(saved.length, 1, 'written at most every 30 seconds');
    now += 30_000;
    const release = presence.hold(7, 'waiting');
    assert.equal(changes.at(-1)!.reason, 'connected');
    release();
    assert.equal(saved.length, 2);
    presence.stop();
  });
});
