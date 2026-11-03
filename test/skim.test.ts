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

describe('stale means the status stopped moving (#86)', () => {
  it('keeps when the status last changed, not when a bulk edit touched it', async () => {
    const { ticket } = store.tickets.create(carlos, 'web', { title: 'Old work', status: 'In Progress' });
    const moved = ticket.statusChangedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.tickets.update(carlos, ticket.ref, { priority: 'high' });
    assert.equal(store.tickets.get(carlos, ticket.ref).statusChangedAt, moved, 'an edit is not a move');
    store.tickets.update(carlos, ticket.ref, { status: 'Done' });
    assert.ok(store.tickets.get(carlos, ticket.ref).statusChangedAt > moved);
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

describe('quick replies to an ask (#90)', () => {
  it('offers Yes / No for a question, passes the literal choice to the agent, and takes the agent\'s own replies', () => {
    const { ticket } = store.tickets.create(bot, 'web', { title: 'Push the pins', assignee: 'carlos-bot' }, { dispatch: false });
    store.tickets.taskFor(bot, ticket.ref);
    store.tickets.update(bot, ticket.ref, { waitingOn: 'ana', waitingAsk: "OK to push the pins after today's shift?" });
    assert.deepEqual(store.tickets.get(ana, ticket.ref).waitingOn?.options, ['Yes', 'No']);
    const answered = store.tickets.replyWaiting(ana, ticket.ref, 'yes');
    assert.equal(answered.waitingOn, null);
    assert.ok(answered.activity.some((a) => a.kind === 'comment' && a.body === `ana on "OK to push the pins after today's shift?": Yes`));
    assert.ok(store.unseenMentions(bot).some((m) => /answered "OK to push the pins after today's shift\?" on WEB-\d+: Yes$/.test(m.text)), 'the agent reads "Yes", not "Done"');

    store.tickets.update(bot, ticket.ref, { waitingOn: 'ana', waitingAsk: 'Open port 443' });
    assert.deepEqual(store.tickets.get(ana, ticket.ref).waitingOn?.options, ['Done'], 'not a question');
    store.tickets.update(bot, ticket.ref, { waitingOn: 'ana', waitingAsk: 'Which night works?', waitingOptions: ['Tonight', 'Monday night'] });
    assert.deepEqual(store.tickets.get(ana, ticket.ref).waitingOn?.options, ['Tonight', 'Monday night']);
    store.tickets.update(bot, ticket.ref, { waitingAsk: 'Ready to ship?' });
    assert.deepEqual(store.tickets.get(ana, ticket.ref).waitingOn?.options, ['Yes', 'No'], 'a new ask drops replies made for the old one');
    store.tickets.update(bot, ticket.ref, { waitingOptions: ['Ship it', 'Hold'] });
    assert.equal(store.tickets.replyWaiting(ana, ticket.ref, 'ship it').activity.at(-2)?.body, 'ana on "Ready to ship?": Ship it');

    store.tickets.update(bot, ticket.ref, { waitingOn: 'ana', waitingAsk: 'Pick one?' });
    assert.equal(code(() => store.tickets.update(bot, ticket.ref, { waitingOptions: ['Not yet'] })), 'invalid', 'Not yet is always there');
    assert.equal(code(() => store.tickets.update(bot, ticket.ref, { waitingOptions: ['A', 'a'] })), 'invalid', 'no duplicates');
    assert.equal(code(() => store.tickets.update(bot, ticket.ref, { waitingOptions: ['1', '2', '3', '4', '5', '6', '7'] })), 'invalid', 'at most six');
    store.tickets.update(bot, ticket.ref, { waitingOn: '' });
    assert.equal(store.tickets.get(ana, ticket.ref).waitingOn, null, 'an empty waiting_on clears it');
    assert.equal(code(() => store.tickets.update(bot, ticket.ref, { waitingOptions: ['Yes', 'No'] })), 'invalid', 'replies need someone to wait on');
  });

  it('clears with waiting_on "" and shows the replies over MCP', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${botToken}` } } }));
    const { ticket } = store.tickets.create(carlos, 'web', { title: 'Release call' });
    const set = await client.callTool({ name: 'update_ticket', arguments: { ticket: ticket.ref, waiting_on: 'ana', waiting_ask: 'Release on Friday?', waiting_options: ['Friday', 'Next week'] } });
    assert.equal(set.isError ?? false, false, (set.content as { text: string }[])[0]!.text);
    const got = await client.callTool({ name: 'get_ticket', arguments: { ticket: ticket.ref } });
    assert.deepEqual(JSON.parse((got.content as { text: string }[])[0]!.text).ticket.waiting_on.replies, ['Friday', 'Next week']);
    const cleared = await client.callTool({ name: 'update_ticket', arguments: { ticket: ticket.ref, waiting_on: '' } });
    assert.equal(cleared.isError ?? false, false, (cleared.content as { text: string }[])[0]!.text);
    assert.equal(store.tickets.get(carlos, ticket.ref).waitingOn, null);
    await client.close();
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
