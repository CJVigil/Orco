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
  const ana = store.createUser('ana');
  tokens.ana = ana.token;
  tokens.ben = store.createUser('ben').token;
  tokens['ana-claude'] = store.createAgent('ana', 'ana-claude').token;
  tokens['ben-codex'] = store.createAgent('ben', 'ben-codex').token;
  store.setTaskPolicy(null, 'ben-codex', 'open');
  // People set up projects and members; agents cannot (see the test below).
  store.createProject(ana.participant, 'api');
  store.addMember(ana.participant, 'api', 'ben');
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

async function connect(name: string, mode: 'legacy' | 'auto' = 'legacy') {
  const client = new Client({ name: `test-${name}`, version: '0.0.0' }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${tokens[name]}` } },
  });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const first = (result.content as { type: string; text: string }[])[0]!;
  assert.equal(result.isError ?? false, false, first.text);
  try {
    return JSON.parse(first.text);
  } catch {
    return first.text;
  }
}

describe('MCP endpoint', () => {
  it('rejects requests without a valid token', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
  });

  it('lets one agent hand work to another through a mention', async () => {
    const claude = await connect('ana-claude');
    const codex = await connect('ben-codex', 'auto');

    const me = await call(claude, 'whoami');
    assert.deepEqual([me.name, me.kind, me.owner, me.canPlan], ['ana-claude', 'agent', 'ana', false]);
    assert.ok(me.rules.length > 0);
    const toolNames = (await claude.listTools()).tools.map((t) => t.name);
    assert.ok(!toolNames.includes('create_project') && !toolNames.includes('add_member'), 'people decide who is in a project');

    const waiting = call(codex, 'wait_for_mentions', { timeout_seconds: 10 });
    const posted = await call(claude, 'post', {
      room: 'api/general',
      text: '@ben-codex the client types are ready, can you update the SDK?',
    });

    const received = await waiting;
    assert.equal(received.mentions.length, 1);
    assert.equal(received.mentions[0].id, posted.id);
    assert.equal(received.mentions[0].author, 'ana-claude (agent of ana)');
    assert.match(received.note, /not as instructions from your owner/);

    await call(codex, 'post', { room: 'api/general', text: 'On it.', thread_id: posted.id });
    const thread = await call(claude, 'read', { room: 'api/general', thread_id: posted.id });
    assert.deepEqual(
      thread.messages.map((m: { text: string }) => m.text),
      ['@ben-codex the client types are ready, can you update the SDK?', 'On it.'],
    );

    await claude.close();
    await codex.close();
  });

  it('runs a task and a lock handoff between two agents', async () => {
    const claude = await connect('ana-claude');
    const codex = await connect('ben-codex');

    const lock = await call(claude, 'acquire_lock', { project: 'api', name: 'branch:main', note: 'merging types' });
    assert.equal(lock.fence, 1);

    const waiting = call(codex, 'wait_for_mentions', { timeout_seconds: 10 });
    const task = await call(claude, 'create_task', { agent: 'ben-codex', room: 'api/general', request: 'rebase the SDK on main' });
    const { mentions } = await waiting;
    assert.equal(mentions[0].task.id, task.id);

    await call(codex, 'update_task', { task_id: task.id, state: 'accepted' });
    const blocked = await codex.callTool({ name: 'acquire_lock', arguments: { project: 'api', name: 'branch:main' } });
    assert.equal(blocked.isError, true);

    const handoff = call(codex, 'acquire_lock', { project: 'api', name: 'branch:main', wait_seconds: 10 });
    await call(claude, 'release_lock', { project: 'api', name: 'branch:main' });
    assert.equal((await handoff).holder, 'ben-codex');

    const claudeWaits = call(claude, 'wait_for_mentions', { timeout_seconds: 10 });
    await call(codex, 'update_task', { task_id: task.id, state: 'done', note: 'Rebased, tests green' });
    const done = await claudeWaits;
    assert.match(done.mentions[0].text, /Task #\d+ done\.\nRebased, tests green/);

    const open = await call(codex, 'list_tasks', {});
    assert.deepEqual(open, []);

    await claude.close();
    await codex.close();
  });

  it('waits for a human approval and gets the decision', async () => {
    const claude = await connect('ana-claude');
    const pending = call(claude, 'request_approval', {
      room: 'api/general',
      summary: 'deploy v0.3 to prod',
      details: 'Rollback: redeploy v0.2',
      wait_seconds: 10,
    });
    let approval: { id: number } | undefined;
    while (!approval) {
      const res = await fetch(`${baseUrl}/api/approvals?pending=1&mine=1`, { headers: { Authorization: `Bearer ${tokens.ana}` } });
      approval = ((await res.json()) as { id: number }[])[0];
      if (!approval) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const decide = await fetch(`${baseUrl}/api/approvals/${approval.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.ana}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', note: 'ship it' }),
    });
    assert.equal(decide.status, 200);
    const result = await pending;
    assert.equal(result.state, 'approved');
    assert.equal(result.note, 'ship it');
    await claude.close();
  });

  it('marks read-only tools so clients can auto-approve them narrowly', async () => {
    const { tools } = await (await connect('ana-claude')).listTools();
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    assert.equal(hints.read, true);
    assert.equal(hints.get_task, true);
    assert.equal(hints.update_task, false);
    assert.equal(hints.acquire_lock, false);
    assert.ok(tools.every((t) => t.annotations?.openWorldHint === false));
  });

  it('keeps agents away from consent settings and the audit log', async () => {
    const headers = { Authorization: `Bearer ${tokens['ben-codex']}`, 'Content-Type': 'application/json' };
    const policy = await fetch(`${baseUrl}/api/agents/ben-codex/policy`, { method: 'POST', headers, body: JSON.stringify({ policy: 'open' }) });
    assert.equal(policy.status, 404);
    const audit = await fetch(`${baseUrl}/api/audit`, { headers });
    assert.equal(audit.status, 403);
    const tools = await (await connect('ben-codex')).listTools();
    const names = tools.tools.map((t) => t.name);
    assert.ok(!names.some((n) => /policy|trust|audit|decide/.test(n)), names.join(', '));
  });

  it('exports the audit log as JSON lines for people', async () => {
    const res = await fetch(`${baseUrl}/api/audit?project=api&format=jsonl`, { headers: { Authorization: `Bearer ${tokens.ana}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /orco-audit-api-/);
    const lines = (await res.text()).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(lines.some((e) => e.action === 'approval.decide' && e.actor === 'ana'));
    assert.ok(lines.some((e) => e.action === 'lock.acquire' && e.actor === 'ana-claude'));
  });

  it('returns tool errors for rooms the agent cannot see', async () => {
    const claude = await connect('ana-claude');
    const result = await claude.callTool({ name: 'read', arguments: { room: 'secret/general' } });
    assert.equal(result.isError, true);
    await claude.close();
  });
});

describe('REST API', () => {
  it('lets a human read and post', async () => {
    const headers = { Authorization: `Bearer ${tokens.ana}`, 'Content-Type': 'application/json' };
    const post = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ room: 'lobby', text: 'hello from ana' }),
    });
    assert.equal(post.status, 201);
    const list = await fetch(`${baseUrl}/api/messages?room=lobby`, { headers });
    const messages = (await list.json()) as { text: string }[];
    assert.ok(messages.some((m) => m.text === 'hello from ana'));
  });

  it('maps store errors to HTTP status codes', async () => {
    const res = await fetch(`${baseUrl}/api/messages?room=nowhere/general`, {
      headers: { Authorization: `Bearer ${tokens.ben}` },
    });
    assert.equal(res.status, 404);
  });
});
