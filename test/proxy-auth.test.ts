import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { proxyAuthSetting } from '../src/commands.js';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { Store } from '../src/store.js';

// "Sign in with Google" through a proxy in front of Orco (oauth2-proxy, Cloudflare Access, Tailscale).
const HEADER = 'X-Forwarded-Email';

async function serve(store: Store, trust: string, options: { setupCode?: string } = {}) {
  const { app, close } = createApp(store, { proxyAuth: { header: HEADER, label: 'Google' }, ...options });
  app.set('trust proxy', trust);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Origin: base, ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? null };
  };
  return {
    request,
    stop: async () => {
      await close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('sign-in through a proxy', () => {
  let store: Store;
  let proxied: Awaited<ReturnType<typeof serve>>;
  let direct: Awaited<ReturnType<typeof serve>>;

  before(async () => {
    store = new Store(openDatabase(':memory:'));
    // Requests in these tests come from 127.0.0.1: trusted as "loopback", untrusted when only 10.9.9.9 is.
    proxied = await serve(store, 'loopback', { setupCode: 'first' });
    direct = await serve(store, '10.9.9.9');
  });
  after(async () => {
    await proxied.stop();
    await direct.stop();
  });

  it('links the first person to the login they set Orco up through', async () => {
    const setup = await proxied.request('POST', '/api/setup', { [HEADER]: 'Carlos@Example.com' }, { code: 'first', name: 'carlos' });
    assert.equal(setup.status, 201);
    assert.deepEqual(store.identities.of(store.participantByName('carlos')!.id), ['carlos@example.com']);
  });

  it('signs a known login in with a session, and refuses unknown ones', async () => {
    const info = await proxied.request('GET', '/api/setup', { [HEADER]: 'carlos@example.com' });
    assert.deepEqual(info.body.proxy, { label: 'Google', identity: 'carlos@example.com', user: 'carlos' });
    const signed = await proxied.request('POST', '/api/signin/proxy', { [HEADER]: 'carlos@example.com' }, {});
    assert.equal(signed.status, 200);
    assert.ok(signed.cookie!.includes('orco_s_'));
    assert.equal((await proxied.request('GET', '/api/me', { Cookie: signed.cookie!, [HEADER]: 'carlos@example.com' })).body.name, 'carlos');
    const stranger = await proxied.request('POST', '/api/signin/proxy', { [HEADER]: 'eve@example.com' }, {});
    assert.equal(stranger.status, 403);
    assert.match(stranger.body.error, /not linked to anyone/);
  });

  it('ignores the header from anywhere but a trusted proxy', async () => {
    const forged = await direct.request('POST', '/api/signin/proxy', { [HEADER]: 'carlos@example.com' }, {});
    assert.equal(forged.status, 403);
    assert.equal((await direct.request('GET', '/api/setup', { [HEADER]: 'carlos@example.com' })).body.proxy.identity, null);
  });

  it('lets org admins invite by email, and nobody link a login to someone else', async () => {
    const admin = (await proxied.request('POST', '/api/signin/proxy', { [HEADER]: 'carlos@example.com' }, {})).cookie!;
    const as = { Cookie: admin, [HEADER]: 'carlos@example.com' };
    assert.equal((await proxied.request('POST', '/api/users', as, { name: 'ana', email: 'ana@example.com' })).status, 201);
    assert.equal((await proxied.request('POST', '/api/users', as, { name: 'ana2', email: 'ANA@example.com' })).status, 409, 'a login is one person');
    assert.equal(store.participantByName('ana2'), null, 'nothing half done');
    assert.equal((await proxied.request('POST', '/api/signin/proxy', { [HEADER]: 'ana@example.com' }, {})).body.name, 'ana');
    // Not even an org admin links a login to an existing person: that would be signing in as them.
    assert.throws(() => store.identities.link(store.participantByName('carlos')!, 'ana', 'mallory@example.com'), /only link a login to yourself/);
  });

  it('lets a signed-in person link the login the proxy vouches for, and only that one', async () => {
    store.createUser('ben');
    const { code } = store.signins.createLink(null, 'ben');
    const ben = (await proxied.request('POST', '/api/signin', {}, { code })).cookie!;
    const linked = await proxied.request('POST', '/api/me/logins', { Cookie: ben, [HEADER]: 'ben@example.com' }, {});
    assert.equal(linked.status, 201);
    assert.equal((await proxied.request('GET', '/api/me', { Cookie: ben, [HEADER]: 'ben@example.com' })).body.logins[0], 'ben@example.com');
    assert.equal((await direct.request('POST', '/api/me/logins', { Cookie: ben, [HEADER]: 'carlos@example.com' }, {})).status, 400, 'a forged header links nothing');
  });

  it('refuses a browser session when the proxy says someone else is at the keyboard', async () => {
    const ana = (await proxied.request('POST', '/api/signin/proxy', { [HEADER]: 'ana@example.com' }, {})).cookie!;
    assert.equal((await proxied.request('GET', '/api/me', { Cookie: ana, [HEADER]: 'carlos@example.com' })).status, 401);
    assert.equal((await proxied.request('GET', '/api/me', { Cookie: ana, [HEADER]: 'ana@example.com' })).status, 200);
  });
});

describe('ORCO_AUTH_HEADER', () => {
  it('needs trusted proxy addresses, not a hop count or nothing', () => {
    assert.equal(proxyAuthSetting(undefined, undefined, 'loopback'), undefined);
    assert.deepEqual(proxyAuthSetting('X-Forwarded-Email', 'Google', 'loopback'), { header: 'X-Forwarded-Email', label: 'Google' });
    assert.throws(() => proxyAuthSetting('X-Forwarded-Email', 'Google', 1), /not a hop count/);
    assert.throws(() => proxyAuthSetting('X-Forwarded-Email', 'Google', undefined), /ORCO_TRUST_PROXY/);
    assert.throws(() => proxyAuthSetting('Cookie', 'Google', 'loopback'), /cannot be/);
  });
});
