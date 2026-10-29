import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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
let anaClaude: Participant;
const tokens = {} as Record<'ana' | 'ben' | 'ana-claude', string>;

before(async () => {
  store = new Store(openDatabase(':memory:'), { secretsKey: randomBytes(32) });
  ({ participant: ana, token: tokens.ana } = store.createUser('ana'));
  tokens.ben = store.createUser('ben').token;
  ({ participant: anaClaude, token: tokens['ana-claude'] } = store.createAgent('ana', 'ana-claude'));
  store.createProject(ana, 'api');
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
  const text = (result.content as { text: string }[])[0]!.text;
  assert.equal(result.isError ?? false, false, text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function api(token: string | null, path: string, body?: unknown, method = body !== undefined ? 'POST' : 'GET') {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

describe('webhooks over HTTP', () => {
  it('accept deliveries without a session and refuse unknown tokens', async () => {
    const created = await api(tokens.ben, '/api/hooks', { room: 'api/general', name: 'Uptime', wakeAgent: null });
    assert.equal(created.status, 201);
    assert.match(created.body.path, /^\/hooks\/orco_h_/);
    assert.equal((await api(tokens['ana-claude'], '/api/hooks', { room: 'api/general', name: 'x' })).status, 403);
    const delivered = await api(null, created.body.path, { text: 'api.example.com is down' });
    assert.equal(delivered.status, 202);
    assert.equal(store.message(delivered.body.message_id).text, 'Webhook Uptime: api.example.com is down');
    assert.equal((await api(null, '/hooks/orco_h_nope', {})).status, 404);
  });
});

describe('more agent tools over MCP', () => {
  it('catch up, checkpoint, remind, claim and read feedback', async () => {
    const client = await connect(tokens['ana-claude']);
    store.post(ana, 'api/general', 'Heads up: freeze starts Friday');
    const first = await call(client, 'catch_up', {});
    assert.ok(first.rooms.some((r: { messages: { text: string }[] }) => r.messages.some((m) => m.text === 'Heads up: freeze starts Friday')));
    assert.equal((await call(client, 'catch_up', {})).rooms.length, 0);

    const task = store.tasks.create(ana, { agent: 'ana-claude', room: 'api/general', request: 'Migrate the users table' });
    await call(client, 'update_task', { task_id: task.id, state: 'accepted' });
    await call(client, 'checkpoint', { task_id: task.id, text: 'Backfill done; next: switch reads' });
    assert.equal((await call(client, 'get_task', { task_id: task.id })).task.checkpoint.text, 'Backfill done; next: switch reads');
    const reminder = await call(client, 'remind_me', { task_id: task.id, in_minutes: 15, note: 'Check the backfill finished' });
    assert.equal((await call(client, 'my_work')).reminders[0].id, reminder.reminder_id);
    await call(client, 'cancel_reminder', { reminder_id: reminder.reminder_id });

    const { ticket } = store.tickets.create(ana, 'api', { title: 'Unclaimed work' });
    assert.equal((await call(client, 'claim_ticket', { ticket: ticket.ref })).assignee, 'ana-claude');
    const again = await client.callTool({ name: 'claim_ticket', arguments: { ticket: ticket.ref } });
    assert.equal(again.isError, true);

    await call(client, 'update_task', { task_id: task.id, state: 'done', note: 'Migrated' });
    assert.equal((await api(tokens.ana, `/api/tasks/${task.id}/feedback`, { rating: 'up', note: 'Clean migration' })).status, 200);
    assert.equal((await call(client, 'my_feedback', {})).feedback[0].note, 'Clean migration');
  });

  it('write and read project files, through the larger body limit too', async () => {
    const client = await connect(tokens['ana-claude']);
    const written = await call(client, 'write_project_file', { project: 'api', path: 'runbooks/deploy.md', content: '# Deploy\n1. make deploy', note: 'first version' });
    assert.equal(written.version, 1);
    const big = 'x'.repeat(200_000);
    const viaRest = await api(tokens.ana, '/api/projects/api/file', { path: 'runbooks/deploy.md', content: big, baseVersion: 1 });
    assert.equal(viaRest.status, 200);
    assert.equal(viaRest.body.version, 2);
    const read = await call(client, 'read_project_file', { project: 'api', path: 'runbooks/deploy.md', version: 1 });
    assert.equal(read.content, '# Deploy\n1. make deploy');
    assert.equal(read.version_note, 'first version');
    assert.equal((await call(client, 'read_project_file', { project: 'api', path: 'runbooks/deploy.md', history: true })).length, 2);
  });

  it('lease a secret with the owner\'s approval, and never list values', async () => {
    assert.equal((await api(tokens.ben, '/api/projects/api/secrets', { name: 'SENTRY_TOKEN', value: 'sntrys_abc', description: 'Read-only' })).status, 201);
    const listed = await api(tokens.ana, '/api/projects/api/secrets');
    assert.deepEqual([listed.body.enabled, listed.body.secrets[0].name], [true, 'SENTRY_TOKEN']);
    assert.ok(!JSON.stringify(listed.body).includes('sntrys'));
    const client = await connect(tokens['ana-claude']);
    const task = store.tasks.create(ana, { agent: 'ana-claude', room: 'api/general', request: 'Triage the Sentry errors' });
    await call(client, 'update_task', { task_id: task.id, state: 'accepted' });
    const lease = await call(client, 'request_secret', { task_id: task.id, name: 'SENTRY_TOKEN', reason: 'Read error groups' });
    const pending = await client.callTool({ name: 'use_secret', arguments: { lease_id: lease.lease_id } });
    assert.equal(pending.isError, true);
    const approvals = (await api(tokens.ben, '/api/approvals?pending=1&mine=1')).body;
    assert.equal((await api(tokens.ben, `/api/approvals/${approvals[0].id}`, { decision: 'approved' })).status, 200);
    assert.equal((await call(client, 'use_secret', { lease_id: lease.lease_id })).value, 'sntrys_abc');
    assert.equal((await api(tokens.ana, `/api/leases/${lease.lease_id}/use`, {})).status, 404, 'people never read values');

    // Whatever the agent writes afterwards, through any tool or endpoint, is stored with the value hidden.
    await call(client, 'report_progress', { task_id: task.id, text: 'Queried with sntrys_abc' });
    await call(client, 'checkpoint', { task_id: task.id, text: 'Token is sntrys_abc; retry with it' });
    const ticket = await api(tokens['ana-claude'], '/api/projects/api/tickets', { title: 'Leak sntrys_abc', description: 'Token sntrys_abc in logs' });
    const file = await call(client, 'post', { room: 'api/general', text: 'Log attached', files: [{ name: 'run.log', text: 'Authorization: sntrys_abc' }] });
    const stored = JSON.stringify([store.db.prepare('SELECT * FROM tasks').all(), ticket.body, store.db.prepare('SELECT data FROM attachments').all().map((a: any) => Buffer.from(a.data).toString('utf8'))]);
    assert.ok(file);
    assert.ok(!stored.includes('sntrys_abc'), stored);
    assert.ok(stored.includes('[hidden]'));

    // The routes outside the api router mask too (#32): run reports, project files, ticket imports.
    const token = tokens['ana-claude'];
    assert.equal((await api(token, `/api/tasks/${task.id}/runs`, { mode: 'start', started_at: new Date().toISOString(), seconds: 1, outcome: 'failed with sntrys_abc', branch: 'fix/sntrys_abc' })).status, 201);
    assert.equal((await api(token, '/api/projects/api/file', { path: 'notes/keys.md', content: 'key sntrys_abc', note: 'saved sntrys_abc' })).status, 200);
    assert.equal((await api(token, '/api/projects/api/tickets/import', { tickets: [{ title: 'Rotate sntrys_abc', description: 'it leaked: sntrys_abc' }] })).status, 201);
    const everywhere = JSON.stringify([
      store.db.prepare('SELECT * FROM task_runs').all(),
      store.db.prepare('SELECT path FROM files').all(),
      store.db.prepare('SELECT content, note FROM file_versions').all(),
      store.db.prepare('SELECT title, description FROM tickets').all(),
    ]);
    assert.ok(!everywhere.includes('sntrys_abc'), everywhere);
  });
});
