import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';

let store: Store;
let ana: Participant;
let bot: Participant;
let botToken: string;
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
  store = new Store(openDatabase(':memory:'));
  ana = store.createUser('ana').participant;
  const made = store.createAgent('ana', 'ana-bot');
  bot = made.participant;
  botToken = made.token;
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

const changesOf = (ref: string, field: string) =>
  store.tickets
    .get(ana, ref)
    .activity.filter((a) => a.kind === 'change')
    .flatMap((a) => (a.detail as { changes: { field: string; from: unknown; to: unknown }[] }).changes)
    .filter((c) => c.field === field);

describe('ticket history', () => {
  it('says the description changed instead of null → null (#70)', () => {
    const { ticket } = store.tickets.create(ana, 'api', { title: 'Docs' });
    store.tickets.update(ana, ticket.ref, { description: 'First draft' });
    store.tickets.update(ana, ticket.ref, { description: '' });
    assert.deepEqual(changesOf(ticket.ref, 'description').map((c) => [c.from, c.to]), [
      [null, '(updated: see description)'],
      ['(earlier text)', '(cleared)'],
    ]);
  });

  it('notes on a ticket when its last blocker closes, and touches it (#74)', async () => {
    const first = store.tickets.create(ana, 'api', { title: 'Schema' }).ticket;
    const second = store.tickets.create(ana, 'api', { title: 'Endpoint' }).ticket;
    const third = store.tickets.create(ana, 'api', { title: 'Docs page' }).ticket;
    store.tickets.update(ana, second.ref, { blockedByAdd: [first.ref, third.ref] });
    const before = store.tickets.get(ana, second.ref).updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.tickets.update(ana, first.ref, { status: 'Done' });
    assert.deepEqual(changesOf(second.ref, 'unblocked'), [], 'still waits on another');
    store.tickets.update(ana, third.ref, { status: 'Done' });
    assert.deepEqual(changesOf(second.ref, 'unblocked').map((c) => c.from), [third.ref]);
    const after = store.tickets.get(ana, second.ref);
    assert.equal(after.blocked, false);
    assert.ok(after.updatedAt > before, 'catch_up sees it as changed');
  });

  it('closes a ticket as a duplicate or superseded, linked both ways (#73)', () => {
    const keep = store.tickets.create(ana, 'api', { title: 'Rate limit login' }).ticket;
    const dupe = store.tickets.create(ana, 'api', { title: 'Throttle sign-in' }).ticket;
    const closed = store.tickets.update(ana, dupe.ref, { duplicateOf: keep.ref }).ticket;
    assert.equal(closed.status.category, 'canceled');
    assert.deepEqual([closed.closedAs?.reason, closed.closedAs?.ticket.ref], ['duplicate', keep.ref]);
    assert.deepEqual(store.tickets.get(ana, keep.ref).replaces.map((r) => [r.ref, r.reason]), [[dupe.ref, 'duplicate']]);
    assert.equal(code(() => store.tickets.update(ana, keep.ref, { supersededBy: keep.ref })), 'invalid');
    assert.equal(store.tickets.update(ana, dupe.ref, { status: 'Todo' }).ticket.closedAs, null, 'reopening clears it');
  });
});

describe('tickets for agents', () => {
  it('changes many tickets in one call, all or nothing, past the rate limit (#71)', () => {
    const refs = Array.from({ length: 35 }, (_, i) => store.tickets.create(ana, 'api', { title: `Bulk ${i}` }).ticket.ref);
    assert.equal(code(() => store.tickets.updateMany(bot, [...refs.slice(0, 3).map((ref) => ({ ref, input: { assignee: 'ana-bot' } })), { ref: 'API-999', input: {} }])), 'not_found');
    assert.equal(store.tickets.get(ana, refs[0]!).assignee, null, 'nothing changed');
    const done = store.tickets.updateMany(bot, refs.map((ref) => ({ ref, input: { assignee: 'ana-bot' } })));
    assert.equal(done.length, 35);
    assert.ok(refs.every((ref) => store.tickets.get(ana, ref).assignee?.name === 'ana-bot'));
  });

  it('opens a task from the owner when an agent starts its own ticket, and names criterion ids (#66, #68)', () => {
    const { ticket } = store.tickets.create(bot, 'api', { title: 'Mine', assignee: 'ana-bot', criteriaAdd: ['a', 'b'] });
    const started = store.tickets.startTask(bot, ticket.ref).ticket;
    assert.equal(started.task?.state, 'accepted');
    const ids = store.tickets.get(ana, ticket.ref).criteriaItems.map((c) => c.id);
    assert.throws(() => store.tickets.update(bot, ticket.ref, { criteriaDone: [999_999] }), new RegExp(`criterion ids are ${ids.join(', ')}`));
  });

  it('replies to writes with a summary, and shows text limits in the schemas (#65, #69)', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${botToken}` } } }));
    const { tools } = await client.listTools();
    const update = tools.find((t) => t.name === 'update_ticket')!.inputSchema as { properties: Record<string, { maxLength?: number }> };
    assert.equal(update.properties.blocked_reason!.maxLength, 200);
    assert.equal(update.properties.title!.maxLength, 200);
    const { ticket } = store.tickets.create(ana, 'api', { title: 'Parent', description: 'x'.repeat(5000) });
    for (let i = 0; i < 3; i++) store.tickets.comment(ana, ticket.ref, 'y'.repeat(2000));
    const reply = await client.callTool({ name: 'update_ticket', arguments: { ticket: ticket.ref, priority: 'high' } });
    const text = (reply.content as { text: string }[])[0]!.text;
    assert.ok(text.length < 2000, `brief: ${text.length} characters`);
    assert.match(text, /last_activity_id/);
    const full = await client.callTool({ name: 'update_ticket', arguments: { ticket: ticket.ref, priority: 'low', full: true } });
    assert.ok((full.content as { text: string }[])[0]!.text.length > 10_000, 'full on request');
    const bulk = await client.callTool({ name: 'update_tickets', arguments: { tickets: [{ ticket: ticket.ref }], set: { status: 'Todo' } } });
    assert.match((bulk.content as { text: string }[])[0]!.text, new RegExp(`^${ticket.ref}: Todo`));
    await client.close();
  });
});
