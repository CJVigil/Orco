import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';
import { myWork } from '../src/work.js';

let store: Store;
let carlos: Participant;
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
  carlos = store.createUser('carlos').participant;
  ana = store.createUser('ana').participant;
  const made = store.createAgent('carlos', 'carlos-bot');
  bot = made.participant;
  botToken = made.token;
  store.createProject(carlos, 'web');
  store.addMember(carlos, 'web', 'ana');
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

describe('a next step on every ticket (#83)', () => {
  it('is one line, for someone, on the summary and in the history', () => {
    const { ticket } = store.tickets.create(carlos, 'web', { title: 'Checkout', description: 'x'.repeat(2000), nextStep: 'Ana reviews the copy', nextStepFor: 'ana' });
    assert.deepEqual(ticket.nextStep, { text: 'Ana reviews the copy', for: 'ana' });
    assert.equal(store.tickets.list(carlos, { project: 'web' }).find((t) => t.ref === ticket.ref)!.nextStep!.text, 'Ana reviews the copy');
    assert.equal(code(() => store.tickets.update(carlos, ticket.ref, { nextStep: 'x'.repeat(141) })), 'invalid');
    assert.equal(store.tickets.update(carlos, ticket.ref, { nextStep: '' }).ticket.nextStep, null);
    const history = store.tickets.get(carlos, ticket.ref).activity.flatMap((a) => (a.detail as { changes?: { field: string }[] } | null)?.changes ?? []);
    assert.equal(history.filter((c) => c.field === 'nextStep').length, 2);
  });
});

describe('waiting on a person (#85)', () => {
  it("reaches the person's Needs you, and one tap clears it and wakes the agent", async () => {
    const { ticket } = store.tickets.create(bot, 'web', { title: 'Open the port', assignee: 'carlos-bot' }, { dispatch: false });
    store.tickets.taskFor(bot, ticket.ref);
    assert.equal(code(() => store.tickets.update(bot, ticket.ref, { waitingOn: 'carlos-bot', waitingAsk: 'x' })), 'invalid', 'a person');
    assert.equal(code(() => store.tickets.update(bot, ticket.ref, { waitingOn: 'ana' })), 'invalid', 'with an ask');
    store.tickets.update(bot, ticket.ref, { waitingOn: 'ana', waitingAsk: 'Open port 443 on the staging firewall' });
    assert.deepEqual(store.tickets.waitingFor(ana).map((t) => t.ref), [ticket.ref]);
    assert.match(myWork(store, ana).next[0]!, new RegExp(`${ticket.ref} waits on you: Open port 443`));
    const inbox = (await (await fetch(`${base}/api/inbox`, { headers: { authorization: `Bearer ${store.rotateToken('ana')}` } })).json()) as { waiting: { ref: string }[] };
    assert.deepEqual(inbox.waiting.map((t) => t.ref), [ticket.ref]);
    assert.equal(code(() => store.tickets.replyWaiting(carlos, ticket.ref, 'done')), 'forbidden', 'only the person it waits on');
    const wakes: unknown[] = [];
    store.events.on('wake', (w) => wakes.push(w));
    store.tickets.replyWaiting(ana, ticket.ref, 'not_yet');
    assert.deepEqual(store.tickets.waitingFor(ana), [], 'snoozed a day');
    const done = store.tickets.replyWaiting(ana, ticket.ref, 'done');
    assert.equal(done.waitingOn, null);
    assert.ok(done.activity.some((a) => a.kind === 'comment' && a.body === 'ana on "Open port 443 on the staging firewall": Done'));
    assert.equal(wakes.length, 2, 'the agent hears each reply');
    assert.ok(store.unseenMentions(bot).some((m) => m.text.includes('answered "Open port 443')));
  });
});

describe('telling agents how people read them (#87)', () => {
  it('puts the rules in the server instructions and warns on a long comment', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${botToken}` } } }));
    assert.match(client.getInstructions() ?? '', /lead with the point in the first line/);
    const { ticket } = store.tickets.create(carlos, 'web', { title: 'Long one' });
    const reply = await client.callTool({ name: 'comment_ticket', arguments: { ticket: ticket.ref, text: 'y'.repeat(3000) } });
    assert.match((reply.content as { text: string }[])[0]!.text, /People see your first line \(yours is 3000 characters; keep it under 120\)/);
    const short = await client.callTool({ name: 'comment_ticket', arguments: { ticket: ticket.ref, text: 'Fixed in #12' } });
    assert.equal((short.content as { text: string }[])[0]!.text, `Commented on ${ticket.ref}`);
    await client.close();
  });
});
