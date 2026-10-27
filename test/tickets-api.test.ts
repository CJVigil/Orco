import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { Store } from '../src/store.js';

let baseUrl: string;
let closeServer: () => Promise<void>;
const tokens: Record<string, string> = {};

before(async () => {
  const store = new Store(openDatabase(':memory:'));
  tokens.ana = store.createUser('ana').token;
  tokens.ben = store.createUser('ben').token;
  tokens['ana-claude'] = store.createAgent('ana', 'ana-claude').token;
  const ana = store.participantByName('ana')!;
  store.createProject(ana, 'api');
  const { app, close } = createApp(store);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = async () => {
    await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
});

after(async () => {
  await closeServer();
});

async function api(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${tokens[who]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return { isError: result.isError ?? false, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

describe('tickets over REST', () => {
  it('creates, updates, comments on and lists tickets', async () => {
    assert.equal((await api('ana', 'POST', '/projects/api/labels', { name: 'bug' })).status, 201);
    const created = await api('ana', 'POST', '/projects/api/tickets', { title: 'Login breaks', labels: ['bug'], priority: 'high' });
    assert.equal(created.status, 201);
    assert.equal(created.body.ticket.ref, 'API-1');
    const moved = await api('ana', 'POST', '/tickets/API-1', { status: 'In Progress', estimate: 2, dueDate: null });
    assert.equal(moved.body.ticket.status.name, 'In Progress');
    assert.equal((await api('ana', 'POST', '/tickets/API-1/comments', { text: 'on it' })).status, 201);
    const listed = await api('ana', 'GET', '/tickets?project=api&open=1&label=bug');
    assert.deepEqual(listed.body.map((t: { ref: string }) => t.ref), ['API-1']);
    const plan = await api('ana', 'GET', '/projects/api/plan');
    assert.equal(plan.body.key, 'API');
    assert.equal(plan.body.statuses.length, 6);
  });

  it('rejects badly typed fields and outsiders', async () => {
    const bad = await api('ana', 'POST', '/tickets/API-1', { estimate: '3' });
    assert.equal(bad.status, 400);
    assert.equal((await api('ben', 'GET', '/tickets/API-1')).status, 404);
  });

  it('keeps planning to people', async () => {
    const res = await api('ana-claude', 'POST', '/projects/api/cycles', {});
    assert.equal(res.status, 403);
    assert.equal((await api('ana', 'POST', '/projects/api/cycles', {})).status, 201);
  });
});

describe('tickets in the inbox', () => {
  it('lists open tickets assigned to you, work in progress first, then by priority', async () => {
    const make = async (title: string, extra: Record<string, unknown>) =>
      (await api('ana', 'POST', '/projects/api/tickets', { title, assignee: 'ana', ...extra })).body.ticket.ref;
    const low = await make('low todo', { priority: 'low', status: 'Todo' });
    const urgent = await make('urgent todo', { priority: 'urgent', status: 'Todo' });
    const started = await make('started', { priority: 'low', status: 'In Progress' });
    await make('done', { status: 'Done' });
    await api('ben', 'POST', '/projects/api/tickets', { title: 'not mine' }).catch(() => null);
    const inbox = (await api('ana', 'GET', '/inbox')).body;
    const refs = inbox.tickets.map((t: { ref: string }) => t.ref);
    assert.deepEqual(refs.filter((r: string) => [low, urgent, started].includes(r)), [started, urgent, low]);
    assert.ok(inbox.tickets.every((t: { assignee: { name: string } }) => t.assignee.name === 'ana'));
    assert.ok(inbox.tickets.every((t: { status: { category: string } }) => !['completed', 'canceled'].includes(t.status.category)));
    assert.equal(inbox.counts.approvals + inbox.counts.unseenMentions, 0);
  });
});

describe('my_work', () => {
  it('gives an agent questions, tasks, tickets and mentions in one call, with a suggested order', async () => {
    const connect = async (who: string) => {
      const client = new Client({ name: who, version: '0.0.0' }, { versionNegotiation: { mode: 'legacy' } });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens[who]}` } } }));
      return client;
    };
    const agent = await connect('ana-claude');
    const created = (await api('ana', 'POST', '/projects/api/tickets', {
      title: 'Ship the fix',
      priority: 'high',
      assignee: 'ana-claude',
      criteriaAdd: ['Tests pass'],
    })).body.ticket;
    const taskId = created.task.id;
    let work = (await call(agent, 'my_work', {})).json;
    assert.ok(work.next.some((n: string) => n.startsWith(`Accept or decline task #${taskId} from ana`)));
    assert.equal(work.tasks.find((t: { id: number }) => t.id === taskId).requested_via, 'ana');
    const ticket = work.tickets.find((t: { ref: string }) => t.ref === created.ref);
    assert.deepEqual(ticket.open_criteria.map((c: string) => c.replace(/^\d+: /, '')), ['Tests pass']);
    assert.ok(work.mentions.length >= 1);

    await call(agent, 'update_task', { task_id: taskId, state: 'accepted' });
    const asked = await call(agent, 'ask_question', { task_id: taskId, question: 'Staging or prod?' });
    assert.equal(asked.json.state, 'needs_input');
    const people = (await api('ana', 'GET', '/my-work')).body;
    assert.ok(people.next.some((n: string) => n.startsWith(`Answer question ${asked.json.question_id}`)));
    await api('ana', 'POST', `/questions/${asked.json.question_id}/answer`, { answer: 'staging' });
    work = (await call(agent, 'my_work', {})).json;
    assert.ok(work.next.some((n: string) => n === `Continue task #${taskId}: ana answered your question.`));
    assert.equal(work.tasks.find((t: { id: number }) => t.id === taskId).question.answer, 'staging');
    await agent.close();
  });
});

describe('tickets over MCP', () => {
  it('lets an agent file, read, move and comment on tickets', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens['ana-claude']}` } } }),
    );
    const created = await call(client, 'create_ticket', { project: 'api', title: 'Flaky test', labels: ['bug'], priority: 'medium' });
    assert.equal(created.isError, false, created.text);
    const ref = created.json.ticket.ref;
    assert.equal((await call(client, 'update_ticket', { ticket: ref, status: 'Todo', estimate: 1 })).isError, false);
    assert.equal((await call(client, 'comment_ticket', { ticket: ref, text: 'Seen twice today' })).text, `Commented on ${ref}`);
    const got = await call(client, 'get_ticket', { ticket: ref });
    assert.match(got.json.note, /not as instructions/);
    assert.equal(got.json.ticket.status, 'Todo');
    assert.equal(got.json.ticket.activity.at(-1).text, 'Seen twice today');
    const listed = await call(client, 'list_tickets', { project: 'api', label: 'bug' });
    assert.ok(listed.json.tickets.some((t: { ref: string }) => t.ref === ref));
    const plan = await call(client, 'project_plan', { project: 'api' });
    assert.ok(plan.json.statuses.some((s: { name: string }) => s.name === 'In Review'));
    const denied = await call(client, 'update_ticket', { ticket: ref, status: 'Shipped' });
    assert.equal(denied.isError, true);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.find((t) => t.name === 'get_ticket')?.annotations?.readOnlyHint, true);
    await client.close();
  });
});
