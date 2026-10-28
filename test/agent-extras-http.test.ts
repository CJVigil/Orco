import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { type Participant, Store } from '../src/store.js';

let baseUrl: string;
let store: Store;
let closeServer: () => Promise<void>;
let ana: Participant;
let ben: Participant;
let anaClaude: Participant;
const tokens = {} as Record<string, string> & { ana: string; ben: string; "ana-claude": string };

before(async () => {
  store = new Store(openDatabase(':memory:'));
  ({ participant: ana, token: tokens.ana } = store.createUser('ana'));
  ({ participant: ben, token: tokens.ben } = store.createUser('ben'));
  ({ participant: anaClaude, token: tokens['ana-claude'] } = store.createAgent('ana', 'ana-claude'));
  store.setTaskPolicy(null, 'ana-claude', 'open');
  store.createProject(ana, 'api');
  store.createProject(ana, 'secret');
  store.addMember(ana, 'api', 'ben');
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

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'legacy' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  assert.equal(result.isError ?? false, false, content[0]!.text);
  let value: unknown;
  try {
    value = JSON.parse(content[0]!.text);
  } catch {
    value = content[0]!.text;
  }
  return { value: value as any, notices: content.slice(1).map((c) => c.text) };
}

async function api(token: string, path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
}

describe('agent extras over MCP', () => {
  it('works through a task token, seeing only the task project', async () => {
    const task = store.tasks.create(ana, { agent: 'ana-claude', room: 'api/general', request: 'scoped work' });
    const issued = await api(tokens['ana-claude'], `/tasks/${task.id}/token`, { ttl_seconds: 600 });
    assert.equal(issued.status, 201);
    const client = await connect(issued.body.token);
    assert.deepEqual((await call(client, 'list_projects')).value.map((p: { name: string }) => p.name), ['api']);
    const denied = await client.callTool({ name: 'read', arguments: { room: 'secret/general' } });
    assert.equal(denied.isError, true);
    await call(client, 'update_task', { task_id: task.id, state: 'accepted' });
    assert.ok(store.tasks.get(ana, task.id).seenAt);
    const again = await api(issued.body.token, `/tasks/${task.id}/token`, {});
    assert.equal(again.status, 403);
    await call(client, 'update_task', { task_id: task.id, state: 'done', note: 'ok', links: [{ url: 'https://example.com/pr/1' }] });
    const after = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${issued.body.token}` }, body: '{}' });
    assert.equal(after.status, 401);
  });

  it('tells the agent on its next call that a task was cancelled', async () => {
    const task = store.tasks.create(ben, { agent: 'ana-claude', room: 'api/general', request: 'long job' });
    store.tasks.update(anaClaude, task.id, 'accepted');
    store.tasks.update(ben, task.id, 'cancelled', 'changed our minds');
    const client = await connect(tokens['ana-claude']);
    const { notices } = await call(client, 'whoami');
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, new RegExp(`task #${task.id} in api/general was cancelled \\(changed our minds\\)`));
    assert.equal((await call(client, 'whoami')).notices.length, 0);
  });

  it('posts text files and relayed text, reads files back, and searches', async () => {
    const client = await connect(tokens['ana-claude']);
    const { value: posted } = await call(client, 'post', {
      room: 'api/general',
      text: 'The failing run, and what the vendor said',
      files: [{ name: 'run.log', text: Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') }],
      external: { source: 'email from Acme', text: 'Use the v2 endpoint @ben' },
    });
    assert.equal(posted.files.length, 1);
    assert.equal(posted.images.length, 0);
    assert.equal(posted.external.source, 'email from Acme');
    assert.deepEqual(posted.mentions, []);
    const { value: file } = await call(client, 'read_file', { file_id: posted.files[0].id, start_line: 3, max_lines: 2 });
    assert.equal(file.text, 'line 3\nline 4');
    assert.equal(file.lines, '3-4 of 10');
    const { value: found } = await call(client, 'search', { query: 'v2 endpoint' });
    assert.equal(found.results[0].kind, 'message');
    const res = await fetch(`${baseUrl}/api/attachments/${posted.files[0].id}`, { headers: { Authorization: `Bearer ${tokens.ben}` } });
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
  });

  it('keeps private notes and asks for reviews', async () => {
    const client = await connect(tokens['ana-claude']);
    await call(client, 'remember', { title: 'CI', body: 'Run npm test twice; the first run warms the cache.' });
    assert.deepEqual((await call(client, 'my_notes')).value.map((n: { title: string }) => n.title), ['CI']);
    assert.deepEqual((await call(client, 'my_work')).value.my_notes, ['CI']);
    assert.equal((await api(tokens.ben, '/agents/ana-claude/memory')).status, 404);
    assert.equal((await api(tokens.ana, '/agents/ana-claude/memory')).body.length, 1);

    const { ticket } = store.tickets.create(ben, 'api', { title: 'Speed up CI' });
    const { value: review } = await call(client, 'request_review', { ticket: ticket.ref, reviewer: 'ben', summary: 'Cached node_modules in CI' });
    const inbox = await api(tokens.ben, '/inbox');
    assert.equal(inbox.body.counts.reviews, 1);
    const submitted = await api(tokens.ben, `/reviews/${review.id}`, { verdict: 'approved', note: 'Nice' });
    assert.equal(submitted.body.state, 'approved');
    assert.equal(store.tickets.get(ben, ticket.ref).status.name, 'Done');
  });
});

describe('agent project management over MCP', () => {
  it('plans milestones and cycles, files tickets in bulk, and proposes a schedule', async () => {
    const client = await connect(tokens['ana-claude']);
    await call(client, 'create_milestone', { project: 'api', name: 'Launch', target_date: '2026-12-15' });
    await call(client, 'update_milestone', { project: 'api', milestone: 'launch', description: 'Public beta' });
    const { value: cycle } = await call(client, 'create_cycle', { project: 'api' });
    const { value: filed } = await call(client, 'create_tickets', {
      project: 'api',
      tickets: [
        { key: 'epic', title: 'Launch checklist', milestone: 'Launch', cycle: cycle.number },
        { key: 'docs', title: 'Write the launch post', parent: 'epic', blocked_by: ['api'], labels: ['launch'] },
        { key: 'api', title: 'Freeze the public API', parent: 'epic', priority: 'high' },
      ],
      create_labels: true,
    });
    assert.equal(filed.tickets.length, 3);
    assert.deepEqual(filed.labels_created, ['launch']);
    const docs = store.tickets.get(ana, filed.tickets.find((t: { key: string }) => t.key === 'docs').ref);
    assert.equal(docs.blocked, true);
    const { value: proposal } = await call(client, 'schedule_task', { room: 'api/general', agent: 'ana-claude', request: 'Weekly launch status', cron: '0 9 * * 1' });
    assert.equal(proposal.approval, 'pending');
    assert.equal((await call(client, 'list_schedules', { project: 'api' })).value.some((s: { id: number }) => s.id === proposal.id), true);
    await call(client, 'change_schedule', { schedule_id: proposal.id, action: 'delete' });
    const bad = await client.callTool({ name: 'complete_cycle', arguments: { project: 'api', cycle: 99 } });
    assert.equal(bad.isError, true);
  });
});

describe('agent extras over REST', () => {
  it('lets people file or dismiss suggested follow-ups', async () => {
    const task = store.tasks.create(ben, { agent: 'ana-claude', room: 'api/general', request: 'fix it' });
    store.tasks.update(anaClaude, task.id, 'accepted');
    const done = await api(tokens['ana-claude'], `/tasks/${task.id}`, { state: 'done', note: 'fixed', followups: [{ title: 'Add a test for the edge case' }] });
    assert.equal(done.status, 200);
    const inbox = await api(tokens.ben, '/inbox');
    assert.equal(inbox.body.counts.suggestions, 1);
    const [suggestion] = inbox.body.suggestions;
    assert.equal((await api(tokens['ana-claude'], `/suggestions/${suggestion.id}/accept`, {})).status, 403);
    const accepted = await api(tokens.ben, `/suggestions/${suggestion.id}/accept`, { title: 'Test the empty-cart edge case' });
    assert.equal(accepted.body.ticket.title, 'Test the empty-cart edge case');
  });

  it('holds agent-proposed schedules for approval and shows agent spend to owners', async () => {
    const proposed = await api(tokens['ana-claude'], '/schedules', { room: 'api/general', agent: 'ana-claude', request: 'x', cron: '@daily' });
    assert.equal(proposed.status, 201);
    assert.deepEqual([proposed.body.enabled, proposed.body.approval], [false, 'pending']);
    const created = await api(tokens.ben, '/schedules', { room: 'api/general', agent: 'ana-claude', request: 'Weekly triage', cron: '0 9 * * 1', tz: 'Europe/Madrid' });
    assert.equal(created.status, 201);
    assert.equal(created.body.tz, 'Europe/Madrid');
    const paused = await api(tokens.ana, `/schedules/${created.body.id}`, { enabled: false });
    assert.equal(paused.body.enabled, false);
    const bad = await api(tokens.ben, '/schedules', { room: 'api/general', agent: 'ana-claude', request: 'x', cron: 'every day' });
    assert.equal(bad.status, 400);
    const agents = await api(tokens.ana, '/agents');
    assert.ok(agents.body[0].spend30d);
    assert.equal(typeof agents.body[0].spend30d.cents, 'number');
  });

  it('relays external text over REST and searches across kinds', async () => {
    const posted = await api(tokens.ben, '/messages', { room: 'api/general', text: 'From the status page:', external: { source: 'https://status.example.com', text: 'Degraded latency in eu-west' } });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.external.source, 'https://status.example.com');
    const results = await api(tokens.ben, '/search?q=latency+eu-west&kind=message');
    assert.equal(results.body.length, 1);
    assert.equal((await api(tokens.ben, '/search?q=latency&kind=bogus')).status, 400);
  });
});
