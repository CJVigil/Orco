import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { OrcoError, type Participant, Store } from '../src/store.js';

let now: number;
let store: Store;
let ana: Participant;
let ben: Participant;
let anaClaude: Participant;
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
  store.createUser('cara');
  anaClaude = store.createAgent('ana', 'ana-claude').participant;
  benCodex = store.createAgent('ben', 'ben-codex').participant;
  store.createProject(ana, 'agentic');
  store.addMember(ana, 'agentic', 'ben');
});

describe('locks', () => {
  it('gives one holder at a time and explains who has it', () => {
    const lock = store.locks.acquire(anaClaude, 'agentic', 'account:agentic', 600, 'equity tick');
    assert.equal(lock.fence, 1);
    assert.equal(lock.holderOwner, 'ana');
    assert.throws(
      () => store.locks.acquire(benCodex, 'agentic', 'account:agentic'),
      (err: OrcoError) => err.code === 'conflict' && /ana-claude \(ana's agent\).*equity tick/.test(err.message),
    );
  });

  it('extends the lease when the holder acquires again, keeping the fence', () => {
    store.locks.acquire(anaClaude, 'agentic', 'deploy:prod', 60);
    now += 30_000;
    const again = store.locks.acquire(anaClaude, 'agentic', 'deploy:prod', 60);
    assert.equal(again.fence, 1);
    assert.equal(again.expiresAt, new Date(now + 60_000).toISOString());
  });

  it('expires, and bumps the fence for the next holder', () => {
    store.locks.acquire(anaClaude, 'agentic', 'deploy:prod', 60);
    now += 61_000;
    assert.deepEqual(store.locks.list(ana), []);
    const next = store.locks.acquire(benCodex, 'agentic', 'deploy:prod', 60);
    assert.equal(next.fence, 2);
    assert.equal(code(() => store.locks.renew(anaClaude, 'agentic', 'deploy:prod')), 'conflict');
  });

  it('lets the holder or its owner release, and a human force it', () => {
    store.locks.acquire(anaClaude, 'agentic', 'a', 60);
    assert.equal(code(() => store.locks.release(benCodex, 'agentic', 'a')), 'forbidden');
    assert.equal(code(() => store.locks.release(ben, 'agentic', 'a')), 'forbidden');
    store.locks.release(ana, 'agentic', 'a');
    assert.deepEqual(store.locks.list(ana), []);

    store.locks.acquire(anaClaude, 'agentic', 'b', 60);
    assert.equal(code(() => store.locks.release(benCodex, 'agentic', 'b', true)), 'forbidden');
    store.locks.release(ben, 'agentic', 'b', true);
    const [notice] = store.read(ana, 'agentic/general').slice(-1);
    assert.equal(notice?.text, 'Force-released lock b, which was held by @ana-claude.');
    assert.deepEqual(notice?.mentions, ['ana-claude']);
  });

  it('is invisible outside the project', () => {
    store.locks.acquire(anaClaude, 'agentic', 'a', 60);
    const cara = store.participantByName('cara')!;
    assert.equal(code(() => store.locks.acquire(cara, 'agentic', 'a')), 'not_found');
    assert.deepEqual(store.locks.list(cara), []);
  });

  it('rejects bad names and TTLs', () => {
    assert.equal(code(() => store.locks.acquire(ana, 'agentic', 'Deploy Prod')), 'invalid');
    assert.equal(code(() => store.locks.acquire(ana, 'agentic', 'x', 1)), 'invalid');
    assert.equal(code(() => store.locks.acquire(ana, 'agentic', 'x', 10 * 24 * 3600)), 'invalid');
  });
});

describe('waiting for a lock', () => {
  it('gets the lock as soon as the holder releases it', async () => {
    const real = new Store(openDatabase(':memory:'));
    const owner = real.createUser('ana').participant;
    const a = real.createAgent('ana', 'a').participant;
    const b = real.createAgent('ana', 'b').participant;
    real.createProject(owner, 'p');
    real.locks.acquire(a, 'p', 'deploy', 60);
    const waiting = real.locks.acquireWaiting(b, 'p', 'deploy', 60, undefined, 5_000);
    setTimeout(() => real.locks.release(a, 'p', 'deploy'), 30);
    const started = Date.now();
    const lock = await waiting;
    assert.equal(lock.holder, 'b');
    assert.equal(lock.fence, 2);
    assert.ok(Date.now() - started < 2_000);
  });

  it('gives up after the wait time', async () => {
    const real = new Store(openDatabase(':memory:'));
    const owner = real.createUser('ana').participant;
    const a = real.createAgent('ana', 'a').participant;
    const b = real.createAgent('ana', 'b').participant;
    real.createProject(owner, 'p');
    real.locks.acquire(a, 'p', 'deploy', 60);
    await assert.rejects(real.locks.acquireWaiting(b, 'p', 'deploy', 60, undefined, 50), (err: OrcoError) => err.code === 'conflict');
  });
});
