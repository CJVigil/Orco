import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';
import { waitFor } from '../src/waits.js';

let store: Store;
let clock: number;
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
  clock = Date.now();
  store = new Store(openDatabase(':memory:'), { now: () => clock });
  ana = store.createUser('ana').participant;
  const made = store.createAgent('ana', 'ana-bot');
  bot = made.participant;
  botToken = made.token;
  store.createProject(ana, 'ops');
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

const mine = (title: string) => store.tickets.create(bot, 'ops', { title, assignee: 'ana-bot' }, { dispatch: false }).ticket.ref;

const connect = async () => {
  const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'legacy' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${botToken}` } } }));
  return client;
};
const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  assert.equal(result.isError ?? false, false, text);
  return JSON.parse(text);
};

describe('multiple-choice questions (#77) kept as decisions (#78)', () => {
  it('asks with options and a recommendation; the answer is one pick, posted on the ticket and kept as a decision', () => {
    const ref = mine('Cleanup scope');
    const task = store.tickets.taskFor(bot, ref);
    const q = store.questions.ask(bot, task.id, 'How much should the cleanup cover?', 'owner', 'question', {
      options: [{ label: 'Last 30 days', description: 'Fast, low risk' }, { label: 'Everything' }],
      recommended: 'Last 30 days',
    });
    assert.deepEqual(q.options.map((o) => o.label), ['Last 30 days', 'Everything']);
    const posted = store.message(q.messageId);
    assert.match(posted.text, /1\. Last 30 days \(recommended\) — Fast, low risk\n2\. Everything/);
    assert.equal(code(() => store.questions.ask(bot, task.id, 'x', 'owner', 'question', { options: [{ label: 'a' }], recommended: 'a' })), 'invalid');
    assert.equal(code(() => store.questions.answer(ana, q.id, '', ['Some']))!, 'invalid', 'only its options');
    assert.equal(code(() => store.questions.answer(ana, q.id, '', ['Last 30 days', 'Everything'])), 'invalid', 'one pick');
    const answered = store.questions.answer(ana, q.id, 'skip the audit tables', ['Last 30 days']);
    assert.equal(answered.answer, 'Last 30 days. Other: skip the audit tables');
    const ticket = store.tickets.get(ana, ref);
    assert.ok(ticket.activity.some((a) => a.kind === 'comment' && a.body?.includes('Answer: Last 30 days')), 'on the ticket');
    assert.equal(ticket.decisions[0]!.decision, 'Last 30 days. Other: skip the audit tables');
    const looked = store.decisions.list(bot, { ticket: ref });
    assert.deepEqual([looked[0]!.title, looked[0]!.decidedBy, looked[0]!.ticket, looked[0]!.questionId], ['How much should the cleanup cover?', 'ana', ref, q.id]);
  });

  it('asks several questions in one call, each on its own ticket', async () => {
    const [a, b] = [mine('Push timing'), mine('Which lever')];
    const client = await connect();
    const out = await call(client, 'ask_question', {
      questions: [
        { ticket: a, question: 'Push tonight or Monday?', options: [{ label: 'Tonight' }, { label: 'Monday' }], recommended: 'Monday', to: 'owner' },
        { ticket: b, question: 'Which levers to trial?', options: [{ label: 'Price' }, { label: 'Layout' }, { label: 'Copy' }], multi_select: true, to: 'owner' },
      ],
    });
    assert.equal(out.asked.length, 2);
    const multi = store.questions.get(ana, out.asked[1].question_id);
    assert.equal(store.questions.answer(ana, multi.id, '', ['Price', 'Copy']).answer, 'Price, Copy');
    const dup = await client.callTool({ name: 'ask_question', arguments: { questions: [{ ticket: a, question: 'x' }, { ticket: a, question: 'y' }] } });
    assert.equal(dup.isError, true, 'one question per ticket at a time');
    await client.close();
  });
});

describe('approvals on a ticket with a scope and an end (#79)', () => {
  it('shows on the ticket, stays in force for its hours, and wakes wait_for', async () => {
    const ref = mine('Security pins');
    const approval = store.approvals.request(bot, { ticket: ref, summary: 'Push the security pins to prod', scope: ['api', 'web', 'worker'], validForHours: 48, ttlSeconds: 3600 });
    assert.equal(approval.room, 'ops/general', "the ticket's room");
    assert.equal(approval.scope, '- api\n- web\n- worker');
    const waiting = waitFor(store, bot, { approvals: [approval.id] }, 5_000);
    const decided = store.approvals.decide(ana, approval.id, 'approved', 'weekend only');
    assert.match((await waiting).fired[0]!, new RegExp(`Approval #${approval.id} is approved until`));
    assert.equal(decided.inForce, true);
    assert.equal(decided.validUntil, new Date(clock + 48 * 3600_000).toISOString());
    const ticket = store.tickets.get(bot, ref);
    assert.deepEqual(ticket.approvals.map((a) => [a.id, a.inForce, a.scope]), [[approval.id, true, '- api\n- web\n- worker']]);
    const history = JSON.stringify(ticket.activity.map((a) => a.detail));
    assert.match(history, /requested #\d+: Push the security pins/);
    assert.match(history, /approved by ana until/);
    assert.match(ticket.decisions[0]!.decision, /^Approved until .*Scope:\n- api/);
    clock += 49 * 3600_000;
    assert.equal(store.approvals.get(bot, approval.id).inForce, false, 'over after its hours');
    assert.equal(code(() => store.approvals.request(bot, { ticket: ref, summary: 'x', validForHours: 24 * 8 })), 'invalid');
  });
});

describe('reminders on a ticket (#80)', () => {
  it('takes a ticket instead of a task', async () => {
    const ref = mine('Cleanup verify');
    const client = await connect();
    const out = await call(client, 'remind_me', { ticket: ref, in_minutes: 60, note: 'run the cleanup verify' });
    assert.equal(out.task_id, store.tickets.get(ana, ref).task!.id);
    await client.close();
  });
});
