import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { proxyAuthSetting } from '../src/commands.js';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { Store } from '../src/store.js';

// "Sign in with Google" through a proxy in front of Orco (oauth2-proxy, Cloudflare Access, Tailscale).
const HEADER = 'X-Forwarded-Email';
const SECRET = 'proxy-and-orco-only-know-this-0123456789';
const PROXY = { 'X-Orco-Auth-Secret': SECRET };

async function serve(store: Store, trust: string, options: { setupCode?: string } = {}) {
  const { app, close } = createApp(store, { proxyAuth: { header: HEADER, label: 'Google', secret: SECRET }, ...options });
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
  /** What the real proxy sends: the login, and the secret that proves it is the proxy. */
  const as = (login: string, extra: Record<string, string> = {}) => ({ [HEADER]: login, ...PROXY, ...extra });

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
    const setup = await proxied.request('POST', '/api/setup', as('Carlos@Example.com'), { code: 'first', name: 'carlos' });
    assert.equal(setup.status, 201);
    assert.deepEqual(store.identities.of(store.participantByName('carlos')!.id), ['carlos@example.com']);
  });

  it('signs a known login in with a session, and refuses unknown ones', async () => {
    const info = await proxied.request('GET', '/api/setup', as('carlos@example.com'));
    assert.deepEqual(info.body.proxy, { label: 'Google', identity: 'carlos@example.com', user: 'carlos' });
    const signed = await proxied.request('POST', '/api/signin/proxy', as('carlos@example.com'), {});
    assert.equal(signed.status, 200);
    assert.ok(signed.cookie!.includes('orco_s_'));
    assert.equal((await proxied.request('GET', '/api/me', { Cookie: signed.cookie!, ...as('carlos@example.com') })).body.name, 'carlos');
    const stranger = await proxied.request('POST', '/api/signin/proxy', as('eve@example.com'), {});
    assert.equal(stranger.status, 403);
    assert.match(stranger.body.error, /not linked to anyone/);
  });

  it('believes the header only with the proxy secret, from a trusted address, without Authorization (#38, #39)', async () => {
    // Anything else on the host: right address, no secret.
    assert.equal((await proxied.request('POST', '/api/signin/proxy', { [HEADER]: 'carlos@example.com' }, {})).status, 403);
    assert.equal((await proxied.request('POST', '/api/signin/proxy', { [HEADER]: 'carlos@example.com', 'X-Orco-Auth-Secret': 'guess' }, {})).status, 403);
    assert.equal((await proxied.request('GET', '/api/setup', { [HEADER]: 'carlos@example.com' })).body.proxy.user, null, 'nothing learned either');
    // A route that lets requests with Authorization skip the proxy's login.
    assert.equal((await proxied.request('POST', '/api/signin/proxy', as('carlos@example.com', { Authorization: 'Bearer x' }), {})).status, 403);
    // The right secret from an untrusted address.
    assert.equal((await direct.request('POST', '/api/signin/proxy', as('carlos@example.com'), {})).status, 403);
  });

  it('lets org admins invite by email, and nobody link a login to someone else', async () => {
    const admin = (await proxied.request('POST', '/api/signin/proxy', as('carlos@example.com'), {})).cookie!;
    const headers = { Cookie: admin, ...as('carlos@example.com') };
    assert.equal((await proxied.request('POST', '/api/users', headers, { name: 'ana', email: 'ana@example.com' })).status, 201);
    assert.equal((await proxied.request('POST', '/api/users', headers, { name: 'ana2', email: 'ANA@example.com' })).status, 409, 'a login is one person');
    assert.equal(store.participantByName('ana2'), null, 'nothing half done');
    assert.equal((await proxied.request('POST', '/api/signin/proxy', as('ana@example.com'), {})).body.name, 'ana');
    assert.throws(() => store.identities.link(store.participantByName('carlos')!, 'ana', 'mallory@example.com'), /only link a login to yourself/);
  });

  it('links an unknown login only when someone signs in another way and confirms it (#40)', async () => {
    store.createUser('ben');
    const { code } = store.signins.createLink(null, 'ben');
    const unconfirmed = await proxied.request('POST', '/api/signin', as('ben@example.com'), { code });
    assert.equal(unconfirmed.status, 409);
    assert.match(unconfirmed.body.error, /links ben@example\.com to ben/);
    const ben = await proxied.request('POST', '/api/signin', as('ben@example.com'), { code, link: true });
    assert.equal(ben.status, 200, 'the link was not spent by the refusal');
    assert.deepEqual(store.identities.of(store.participantByName('ben')!.id), ['ben@example.com']);
    // Someone else's login cannot sign in as ben, even with ben's link.
    const another = store.signins.createLink(null, 'ben');
    assert.equal((await proxied.request('POST', '/api/signin', as('ana@example.com'), { code: another.code, link: true })).status, 403);
  });

  it('refuses a browser session unless the proxy login is that person’s (#40)', async () => {
    const ana = (await proxied.request('POST', '/api/signin/proxy', as('ana@example.com'), {})).cookie!;
    assert.equal((await proxied.request('GET', '/api/me', { Cookie: ana, ...as('ana@example.com') })).status, 200);
    assert.equal((await proxied.request('GET', '/api/me', { Cookie: ana, ...as('carlos@example.com') })).status, 401, 'someone else');
    assert.equal((await proxied.request('GET', '/api/me', { Cookie: ana, ...as('newcomer@example.com') })).status, 401, 'a login linked to nobody');
  });

  it('lets org admins remove someone’s login', async () => {
    const admin = (await proxied.request('POST', '/api/signin/proxy', as('carlos@example.com'), {})).cookie!;
    const removed = await proxied.request('DELETE', '/api/users/ana/logins', { Cookie: admin, ...as('carlos@example.com') }, { login: 'ana@example.com' });
    assert.equal(removed.status, 204);
    assert.equal(store.identities.userFor('ana@example.com'), null);
  });
});

describe('ORCO_AUTH_HEADER', () => {
  it('needs trusted proxy addresses and a secret', () => {
    const secret = 'x'.repeat(40);
    assert.equal(proxyAuthSetting(undefined, undefined, 'loopback'), undefined);
    assert.deepEqual(proxyAuthSetting('X-Forwarded-Email', 'Google', 'loopback', secret), { header: 'X-Forwarded-Email', label: 'Google', secret });
    assert.throws(() => proxyAuthSetting('X-Forwarded-Email', 'Google', 'loopback'), /ORCO_AUTH_SECRET/);
    assert.throws(() => proxyAuthSetting('X-Forwarded-Email', 'Google', 'loopback', 'short'), /ORCO_AUTH_SECRET/);
    assert.throws(() => proxyAuthSetting('X-Forwarded-Email', 'Google', 1, secret), /not a hop count/);
    assert.throws(() => proxyAuthSetting('X-Forwarded-Email', 'Google', undefined, secret), /ORCO_TRUST_PROXY/);
    assert.throws(() => proxyAuthSetting('Cookie', 'Google', 'loopback', secret), /cannot be/);
  });
});
