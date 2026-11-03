import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';

let store: Store;
let carlos: Participant;
let carlosToken: string;
let bot: Participant;
let other: Participant;
let base: string;
let stop: () => Promise<void>;
let ref: string;

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as OrcoError).code;
  }
  return 'ok';
};

before(async () => {
  store = new Store(openDatabase(':memory:'));
  const made = store.createUser('carlos');
  carlos = made.participant;
  carlosToken = made.token;
  bot = store.createAgent('carlos', 'carlos-bot').participant;
  other = store.createAgent('carlos', 'carlos-other').participant;
  store.createProject(carlos, 'web');
  ref = store.tickets.create(carlos, 'web', { title: 'Ship the pins' }).ticket.ref;
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

describe('"Yes, and don\'t ask again" on a ticket (#95)', () => {
  it('approves later requests of the same kind on the ticket at once, and asks again for anything else', async () => {
    const first = store.approvals.request(bot, { ticket: ref, summary: 'Push the pins to main', details: '```diff\n-a\n+b\n```', kind: 'push to main' });
    assert.equal(first.actionKind, 'push to main');
    const res = await fetch(`${base}/api/approvals/${first.id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${carlosToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', standing: true }),
    });
    assert.equal(res.status, 200);
    const decided = (await res.json()) as { standing: boolean; inForce: boolean; validUntil: string };
    assert.deepEqual([decided.standing, decided.inForce], [true, true]);

    const again = store.approvals.request(bot, { ticket: ref, summary: 'Push the next pin to main', kind: 'Push to main' });
    assert.equal(again.state, 'approved', 'same kind on the same ticket, any case');
    assert.match(again.note ?? '', /carlos said not to ask again for "Push to main"/);
    assert.ok(store.audit.list(carlos, { limit: 100 }).some((e) => e.action === 'approval.auto'));

    assert.equal(store.approvals.request(bot, { ticket: ref, summary: 'Push to staging', kind: 'push to staging' }).state, 'pending', 'another kind asks');
    assert.equal(store.approvals.request(bot, { ticket: ref, summary: 'Delete the old branch tables', kind: 'push to main' }).state, 'pending', 'a different risky action under the same label asks');
    assert.equal(store.approvals.request(other, { ticket: ref, summary: 'Push to main too', kind: 'push to main' }).state, 'pending', 'another agent asks');

    assert.equal(code(() => store.approvals.revoke(bot, first.id)), 'forbidden', 'agents cannot end it');
    store.approvals.revoke(carlos, first.id);
    assert.equal(store.approvals.request(bot, { ticket: ref, summary: 'Push once more', kind: 'push to main' }).state, 'pending', 'ended: it asks again');
  });

  it('needs a ticket and a kind to stand, and a "no" carries its note to the agent', () => {
    const loose = store.approvals.request(bot, { ticket: ref, summary: 'Restart the worker' });
    assert.equal(code(() => store.approvals.decide(carlos, loose.id, 'approved', undefined, { standing: true })), 'invalid');
    store.approvals.decide(carlos, loose.id, 'denied', 'Restart only the web pool');
    const told = store.unseenMentions(bot).find((m) => m.text.includes('Denied by carlos'));
    assert.match(told?.text ?? '', /Restart only the web pool/);
  });
});
