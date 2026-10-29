import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseBridgeConfig } from '../src/bridge/config.js';
import { connect, detectTools } from '../src/connect.js';
import { openDatabase } from '../src/db.js';
import { createApp, PACKAGE_PATH } from '../src/http.js';
import { Store } from '../src/store.js';

let store: Store;
let baseUrl: string;
let closeServer: () => Promise<void>;
let cookie = '';

before(async () => {
  store = new Store(openDatabase(':memory:'));
  const { app, close } = createApp(store, { setupCode: 'let-me-in' });
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

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') };
}

describe('first run in the browser', () => {
  it('lets the first person set up Orco with the printed code, once', async () => {
    assert.deepEqual((await http('GET', '/api/setup')).body, { needed: true });
    assert.equal((await http('POST', '/api/setup', { code: 'guess', name: 'carlos' })).status, 403);
    const done = await http('POST', '/api/setup', { code: 'let-me-in', name: 'Carlos' });
    assert.equal(done.status, 201);
    assert.equal(done.body.name, 'carlos');
    assert.ok(done.body.token.startsWith('orco_u_'), 'the token is shown once, for the command line');
    cookie = done.setCookie!.split(';')[0]!;
    const me = await http('GET', '/api/me');
    assert.equal(me.body.orgAdmin, true);
    assert.equal((await http('POST', '/api/setup', { code: 'let-me-in', name: 'mallory' })).status, 409);
    assert.deepEqual((await http('GET', '/api/setup')).body, { needed: false });
  });

  it('lets people add agents and org admins add people, showing tokens once', async () => {
    const agent = await http('POST', '/api/agents', { name: 'carlos-claude' });
    assert.equal(agent.status, 201);
    assert.ok(agent.body.token.startsWith('orco_a_'));
    assert.equal(store.authenticate(agent.body.token)!.name, 'carlos-claude');
    const rotated = await http('POST', '/api/agents/carlos-claude/token', {});
    assert.equal(store.authenticate(agent.body.token), null, 'the old token stops working');
    assert.equal(store.authenticate(rotated.body.token)!.name, 'carlos-claude');
    const person = await http('POST', '/api/users', { name: 'ana' });
    assert.equal(person.status, 201);
    assert.equal(person.body.orgAdmin, false);
    // Ana is no org admin, and cannot add people or rotate Carlos's agent.
    const anaCookie = (await http('POST', '/api/session', { token: person.body.token })).setCookie!.split(';')[0]!;
    const asAna = (method: string, path: string, body?: unknown) => http(method, path, body, { Cookie: anaCookie });
    assert.equal((await asAna('POST', '/api/users', { name: 'eve' })).status, 403);
    assert.equal((await asAna('POST', '/api/agents/carlos-claude/token', {})).status, 404);
  });

  it('tracks the first steps', async () => {
    const steps = (await http('GET', '/api/getting-started')).body as { key: string; done: boolean }[];
    assert.deepEqual(
      steps.map((s) => `${s.key}:${s.done}`),
      ['project:false', 'agent:true', 'connect:false', 'task:false', 'result:false'],
    );
  });
});

describe('orco connect', () => {
  it('finds tools, waits for the code to be approved, and writes a private config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orco-connect-'));
    const lines: string[] = [];
    const running = connect(
      {
        server: `${baseUrl}/`,
        dir: '/home/carlos/code/api',
        config: join(dir, 'bridge.json'),
        tokenDir: join(dir, 'tokens'),
        service: false,
        probe: (bin) => bin === 'claude' || bin === 'codex',
        pollMs: 20,
      },
      { out: (text) => lines.push(text) },
    );
    let code = '';
    for (let i = 0; i < 100 && !code; i++) {
      code = /enter ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(lines.join('\n'))?.[1] ?? '';
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(code, lines.join('\n'));
    const view = (await http('GET', `/api/pair/code/${code.toLowerCase()}`)).body;
    assert.deepEqual(view.tools, ['claude', 'codex']);
    assert.equal(view.cwd, '/home/carlos/code/api');
    const approved = await http('POST', `/api/pair/code/${code}`, { agents: [{ agent: 'carlos-laptop', preset: 'codex' }, { agent: 'carlos-claude', preset: 'claude' }] });
    assert.deepEqual(approved.body.agents.map((a: { name: string; created: boolean }) => `${a.name}:${a.created}`), ['carlos-laptop:true', 'carlos-claude:false']);
    const result = await running;
    assert.deepEqual(result.agents, ['carlos-laptop', 'carlos-claude']);

    const config = parseBridgeConfig(JSON.parse(readFileSync(join(dir, 'bridge.json'), 'utf8')));
    assert.equal(config.server, baseUrl);
    assert.deepEqual(config.agents.map((a) => [a.name, a.preset, a.cwd]), [
      ['carlos-laptop', 'codex', resolve('/home/carlos/code/api')],
      ['carlos-claude', 'claude', resolve('/home/carlos/code/api')],
    ]);
    const token = readFileSync(config.agents[0]!.token_file!, 'utf8').trim();
    assert.equal(store.authenticate(token)!.name, 'carlos-laptop');
    assert.ok(!readFileSync(join(dir, 'bridge.json'), 'utf8').includes('orco_a_'), 'the config holds no tokens');
    if (process.platform !== 'win32') assert.equal(statSync(config.agents[0]!.token_file!).mode & 0o777, 0o600);
    assert.equal((await http('GET', `/api/pair/code/${code}`)).status, 404, 'a code is used once');
  });

  it('stops when the code is declined, and only people approve', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orco-connect-'));
    const lines: string[] = [];
    const running = connect(
      { server: baseUrl, dir, config: join(dir, 'bridge.json'), tokenDir: join(dir, 'tokens'), service: false, probe: () => false, pollMs: 20 },
      { out: (text) => lines.push(text) },
    );
    let code = '';
    for (let i = 0; i < 100 && !code; i++) {
      code = /enter ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(lines.join('\n'))?.[1] ?? '';
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const agent = store.participantByName('carlos-laptop')!;
    assert.throws(() => store.onboarding.approve(agent, code, [{ agent: 'x', preset: 'claude' }]), /Only people/);
    assert.equal((await http('POST', `/api/pair/code/${code}`, { decision: 'deny' })).status, 204);
    await assert.rejects(running, /declined/);
  });

  it('detects tools by running them, once per program', () => {
    const asked: string[] = [];
    const found = detectTools((bin) => {
      asked.push(bin);
      return bin === 'gemini';
    });
    assert.deepEqual(found, ['gemini']);
    assert.equal(asked.length, new Set(asked).size);
  });
});

describe('the Orco package for joining computers', () => {
  it('is served for npx when the server has one, and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orco-pkg-'));
    const file = join(dir, 'orco.tgz');
    writeFileSync(file, 'not really a tarball');
    const local = createApp(new Store(openDatabase(':memory:')), { packageFile: file });
    const server = local.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}${PACKAGE_PATH}`);
      assert.equal(res.status, 200, 'npx cannot sign in, so the package needs none');
      assert.equal(res.headers.get('content-type'), 'application/gzip');
      assert.equal(await res.text(), 'not really a tarball');
      assert.equal((await fetch(`${base}/install/orco-0.0.1.tgz`)).status, 404);
    } finally {
      await local.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    // The main test server was made without one in its folder: the UI offers `orco connect` instead.
    const info = (await http('GET', '/api/client')).body;
    assert.equal(typeof info.version, 'string');
  });

  it('can be turned off', async () => {
    const none = createApp(new Store(openDatabase(':memory:')), { packageFile: null });
    const server = none.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      assert.equal((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${PACKAGE_PATH}`)).status, 404);
    } finally {
      await none.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('sign-in links', () => {
  it('invites a person with a link that signs them in once, without a token', async () => {
    const added = await http('POST', '/api/users', { name: 'bea' });
    assert.equal(added.status, 201);
    const code = added.body.signin.code as string;
    const res = await fetch(`${baseUrl}/api/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: 'bea', firstTime: true });
    const session = res.headers.get('set-cookie')!.split(';')[0]!;
    assert.ok(session.includes('orco_s_'), 'the cookie holds a session, not her token');
    assert.equal((await http('GET', '/api/me', undefined, { Cookie: session })).body.name, 'bea');
    // The session is only a browser cookie: not a bearer token, and not for MCP.
    const value = decodeURIComponent(session.split('=')[1]!);
    assert.equal((await http('GET', '/api/me', undefined, { Cookie: '', Authorization: `Bearer ${value}` })).status, 401);
    assert.equal((await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { Cookie: session, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' })).status, 401);
    // Used once.
    const again = await fetch(`${baseUrl}/api/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(again.status, 404);
    // Signing out ends the session.
    await http('DELETE', '/api/session', undefined, { Cookie: session });
    assert.equal((await http('GET', '/api/me', undefined, { Cookie: session })).status, 401);
  });

  it('lets anyone make a short link for their own other device, and nobody for someone else', async () => {
    const own = await http('POST', '/api/signin-links', {});
    assert.equal(own.status, 201);
    assert.ok(new Date(own.body.expiresAt).getTime() - Date.now() <= 15 * 60_000 + 5_000, 'a link for yourself lasts minutes');
    const bea = store.participantByName('bea')!;
    assert.throws(() => store.signins.createLink(bea, 'carlos'), /only make a sign-in link for yourself/);
    // Not even an org admin: a link for an existing person would let them act as that person.
    assert.throws(() => store.signins.createLink(store.participantByName('carlos')!, 'bea'), /only make a sign-in link for yourself/);
    assert.equal((await http('POST', '/api/signin-links', { user: 'bea' })).status, 201, 'the body cannot pick someone else');
    const agent = store.participantByName('carlos-claude')!;
    assert.throws(() => store.signins.createLink(agent, 'carlos'), /Only people/);
  });

  it('expires', () => {
    let clock = Date.parse('2026-11-02T12:00:00Z');
    const timed = new Store(openDatabase(':memory:'), { now: () => clock });
    timed.createUser('dee');
    const { code } = timed.signins.createLink(null, 'dee');
    clock += 8 * 24 * 3600_000;
    assert.throws(() => timed.signins.use(code), /expired/);
  });
});
