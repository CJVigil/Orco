import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { Store } from '../src/store.js';

/* A new personal token from the web app (#151). */
let base: string;
let stop: () => Promise<void>;
let store: Store;
const tokens: Record<string, string> = {};

before(async () => {
  store = new Store(openDatabase(':memory:'));
  tokens.ana = store.createUser('ana').token; // the first person: an org admin
  tokens.ben = store.createUser('ben').token;
  tokens.cara = store.createUser('cara').token;
  tokens['ben-bot'] = store.createAgent('ben', 'ben-bot').token;
  const { app, close } = createApp(store);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stop = async () => {
    await close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
});
after(() => stop());

async function login(token: string): Promise<string> {
  const res = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}
const post = (path: string, auth: { cookie?: string; bearer?: string }) =>
  fetch(`${base}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth.cookie ? { cookie: auth.cookie } : {}), ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}) },
    body: '{}',
  });
const whoami = (auth: { cookie?: string; bearer?: string }) =>
  fetch(`${base}/api/me`, { headers: { ...(auth.cookie ? { cookie: auth.cookie } : {}), ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}) } });

describe('a new personal token from the web app (#151)', () => {
  it('replaces your own from a browser session: the new one works, the old one stops, this browser stays signed in, others are signed out', async () => {
    const here = await login(tokens.ben!);
    const elsewhere = await login(tokens.ben!);
    const res = await post('/me/token', { cookie: here });
    assert.equal(res.status, 200);
    const { name, token } = (await res.json()) as { name: string; token: string };
    assert.equal(name, 'ben');
    assert.notEqual(token, tokens.ben);
    assert.equal((await whoami({ bearer: token })).status, 200, 'the new token works');
    assert.equal((await whoami({ bearer: tokens.ben })).status, 401, 'the old one stops at once');
    assert.equal((await whoami({ cookie: here })).status, 200, 'this browser stays signed in');
    assert.equal((await whoami({ cookie: elsewhere })).status, 401, 'other browsers are signed out');
    assert.equal((await whoami({ bearer: tokens['ben-bot'] })).status, 200, 'agents keep their own tokens');
    const entry = store.db.prepare("SELECT a.action, p.name AS actor, a.subject FROM audit a LEFT JOIN participants p ON p.id = a.actor_id WHERE a.action = 'token.rotate' ORDER BY a.id DESC LIMIT 1").get() as { actor: string; subject: string };
    assert.deepEqual({ actor: entry.actor, subject: entry.subject }, { actor: 'ben', subject: 'user:ben' });
    tokens.ben = token;
  });

  it('refuses a request that carries only a token, so a leaked token cannot lock its owner out', async () => {
    const res = await post('/me/token', { bearer: tokens.cara });
    assert.equal(res.status, 403);
    assert.equal((await whoami({ bearer: tokens.cara })).status, 200, 'unchanged');
    assert.equal((await post('/me/token', { bearer: tokens['ben-bot'] })).status, 403, 'nor an agent');
  });

  it('lets an org admin replace a locked-out person\'s token from the web app, and nobody else', async () => {
    const admin = await login(tokens.ana!);
    const res = await post('/users/cara/token', { cookie: admin });
    assert.equal(res.status, 200);
    const { token } = (await res.json()) as { token: string };
    assert.equal((await whoami({ bearer: token })).status, 200);
    assert.equal((await whoami({ bearer: tokens.cara })).status, 401);
    tokens.cara = token;
    const notAdmin = await login(tokens.ben!);
    assert.equal((await post('/users/cara/token', { cookie: notAdmin })).status, 403, 'not an org admin');
    assert.equal((await post('/users/cara/token', { bearer: tokens.ana })).status, 403, 'not from a token');
    assert.equal((await post('/users/ben-bot/token', { cookie: admin })).status, 404, 'people only');
    assert.equal((await whoami({ bearer: tokens.cara })).status, 200);
  });
});
