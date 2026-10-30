import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { oidcSetting } from '../src/commands.js';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { Oidc } from '../src/oidc.js';
import { Store } from '../src/store.js';

// "Sign in with Gitea" (#41): Orco as an OpenID Connect client, against a fake provider.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
let issuer: string;
/** Who the fake provider signs in next. */
let nextUser = { email: 'ana@example.com', verified: true };
const codes = new Map<string, { nonce: string; challenge: string; email: string; verified: boolean }>();

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function sign(claims: Record<string, unknown>, kid = 'k1'): string {
  const body = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64(claims)}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url')}`;
}

function provider(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    }
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      // The person signs in at the provider; it sends them back with a code.
      const code = `code-${codes.size + 1}`;
      codes.set(code, { nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')!, ...nextUser });
      res.writeHead(302, { Location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}` });
      return res.end();
    }
    if (url.pathname === '/token') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        const grant = codes.get(form.get('code') ?? '');
        if (req.headers.authorization !== `Basic ${Buffer.from('orco:shh').toString('base64')}`) return json({ error: 'invalid_client' }, 401);
        if (!grant || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== grant.challenge) return json({ error: 'invalid_grant' }, 400);
        const now = Math.floor(Date.now() / 1000);
        json({ id_token: sign({ iss: issuer, aud: 'orco', sub: grant.email.toLowerCase(), email: grant.email, email_verified: grant.verified, nonce: grant.nonce, iat: now, exp: now + 300 }) });
      });
      return;
    }
    json({ error: 'not found' }, 404);
  });
}

let store: Store;
let base: string;
let stop: () => Promise<void>;

/** A browser: follows Orco's redirects by hand, keeping cookies. */
async function signInWithProvider(jar: Map<string, string>): Promise<string> {
  const send = (url: string) => fetch(url, { redirect: 'manual', headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  const keep = (res: Response) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const [k, ...v] = pair!.split('=');
      if (/Expires=Thu, 01 Jan 1970/.test(line)) jar.delete(k!);
      else jar.set(k!, v.join('='));
    }
  };
  let res = await send(`${base}/auth/oidc/start`);
  keep(res);
  res = await send(res.headers.get('location')!); // the provider
  res = await send(res.headers.get('location')!); // back to Orco
  keep(res);
  return res.headers.get('location')!;
}

before(async () => {
  const idp = provider().listen(0, '127.0.0.1');
  await new Promise((resolve) => idp.once('listening', resolve));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  store = new Store(openDatabase(':memory:'));
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oidc = new Oidc({ issuer, clientId: 'orco', clientSecret: 'shh', redirectUri: `${base}/auth/oidc/callback`, label: 'Gitea', domains: ['example.com'] });
  const { app, close } = createApp(store, { oidc });
  server.on('request', app);
  const carlos = store.createUser('carlos').participant;
  store.identities.link(null, 'carlos', 'carlos@example.com');
  store.createProject(carlos, 'api');
  stop = async () => {
    await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    idp.closeAllConnections();
    await new Promise((resolve) => idp.close(resolve));
  };
});

after(async () => {
  await stop();
});

describe('sign in with an OpenID provider', () => {
  it('signs a linked person in with a session, once they confirmed the login themselves (#51)', async () => {
    nextUser = { email: 'Carlos@Example.com', verified: true };
    // Added for carlos but never used with the provider: whoever signs in first does not get it.
    const first = new Map<string, string>();
    assert.equal(await signInWithProvider(first), '/#!signin=unlinked');
    assert.equal((store.db.prepare("SELECT subject FROM identities WHERE identity = 'carlos@example.com'").get() as { subject: string | null }).subject, null);
    const { code } = store.signins.createLink(null, 'carlos');
    const cookie = [...first].map(([k, v]) => `${k}=${v}`).join('; ');
    const signed = await fetch(`${base}/api/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ code }) });
    assert.equal(signed.status, 200);
    const jar = new Map<string, string>();
    assert.equal(await signInWithProvider(jar), '/');
    const me = await fetch(`${base}/api/me`, { headers: { Cookie: `orco_token=${jar.get('orco_token')}` } });
    assert.equal(((await me.json()) as { name: string }).name, 'carlos');
    assert.ok(jar.get('orco_token')!.startsWith('orco_s_'));
  });

  it('remembers an unknown login briefly, and links it only when its person signs in and confirms', async () => {
    store.createUser('ana');
    nextUser = { email: 'ana@example.com', verified: true };
    const jar = new Map<string, string>();
    assert.equal(await signInWithProvider(jar), '/#!signin=unlinked');
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const setup = (await (await fetch(`${base}/api/setup`, { headers: { Cookie: cookie } })).json()) as { oidc: { pending: string } };
    assert.equal(setup.oidc.pending, 'ana@example.com');
    const { code } = store.signins.createLink(null, 'ana');
    const signed = await fetch(`${base}/api/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ code, link: true }) });
    assert.equal(signed.status, 200);
    assert.equal(store.identities.userFor('ana@example.com')?.name, 'ana');
    assert.equal(await signInWithProvider(new Map()), '/', 'next time, straight in');
  });

  it('refuses a sign-in that did not start in this browser (login CSRF)', async () => {
    nextUser = { email: 'carlos@example.com', verified: true };
    const start = await fetch(`${base}/auth/oidc/start`, { redirect: 'manual' });
    const back = await fetch((await fetch(start.headers.get('location')!, { redirect: 'manual' })).headers.get('location')!, { redirect: 'manual' });
    assert.equal(back.headers.get('location'), '/#!signin-error=state', 'a fixed code, never text');
    assert.equal(back.headers.getSetCookie().some((c) => c.startsWith('orco_token=orco_s_')), false);
  });

  it('refuses unverified emails and other domains', async () => {
    nextUser = { email: 'carlos@example.com', verified: false };
    assert.equal(await signInWithProvider(new Map()), '/#!signin-error=unverified');
    nextUser = { email: 'eve@elsewhere.org', verified: true };
    assert.equal(await signInWithProvider(new Map()), '/#!signin-error=domain');
  });

  it('checks the ID token itself: signature, audience, issuer, expiry and nonce', async () => {
    const oidc = new Oidc({ issuer, clientId: 'orco', clientSecret: 'shh', redirectUri: 'x', label: 'Gitea', domains: [] });
    const now = Math.floor(Date.now() / 1000);
    const good = { iss: issuer, aud: 'orco', sub: 's', email: 'a@b.c', email_verified: true, nonce: 'n', iat: now, exp: now + 300 };
    assert.equal((await oidc.verify(sign(good), 'n')).sub, 's');
    const [h, p] = sign(good).split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...good, email: 'admin@b.c' })).toString('base64url')}.${sign(good).split('.')[2]}`;
    await assert.rejects(oidc.verify(forged, 'n'), /signature/);
    await assert.rejects(oidc.verify(`${h}.${p}.`, 'n'), /signature|malformed/);
    await assert.rejects(oidc.verify(sign({ ...good, aud: 'someone-else' }), 'n'), /another app/);
    await assert.rejects(oidc.verify(sign({ ...good, iss: 'https://evil.example' }), 'n'), /another issuer/);
    await assert.rejects(oidc.verify(sign({ ...good, exp: now - 3600 }), 'n'), /expired/);
    await assert.rejects(oidc.verify(sign(good), 'other'), /does not belong/);
    await assert.rejects(oidc.verify(sign(good, 'unknown-key'), 'n'), /key the issuer does not publish/);
    const none = `${b64({ alg: 'none' })}.${b64(good)}.`;
    await assert.rejects(oidc.verify(none, 'n'), /does not accept/);
    await assert.rejects(oidc.verify(sign({ ...good, nbf: now + 86_400 }), 'n'), /not valid yet/);
    await assert.rejects(oidc.verify(sign({ ...good, aud: ['orco', 'other'] }), 'n'), /another app/, 'several audiences need azp');
    assert.equal((await oidc.verify(sign({ ...good, aud: ['orco', 'other'], azp: 'orco' }), 'n')).sub, 's');
  });

  it('ties a login to the provider account it first signed in with (#47)', async () => {
    nextUser = { email: 'carlos@example.com', verified: true };
    assert.equal(await signInWithProvider(new Map()), '/');
    assert.equal((store.db.prepare("SELECT subject FROM identities WHERE identity = 'carlos@example.com'").get() as { subject: string }).subject, 'carlos@example.com');
    // Someone else's account at the provider now claims the same address.
    store.db.prepare("UPDATE identities SET subject = 'the-real-carlos' WHERE identity = 'carlos@example.com'").run();
    assert.equal(await signInWithProvider(new Map()), '/#!signin-error=account');
  });

  it('does not let stray callbacks lock everyone out (#46)', async () => {
    for (let i = 0; i < 15; i++) await fetch(`${base}/auth/oidc/callback?error=access_denied`, { redirect: 'manual' });
    for (let i = 0; i < 15; i++) await fetch(`${base}/auth/oidc/callback?code=x&state=forged`, { redirect: 'manual' });
    for (let i = 0; i < 600; i++) await fetch(`${base}/auth/oidc/start`, { redirect: 'manual' });
    nextUser = { email: 'ana@example.com', verified: true };
    assert.equal(await signInWithProvider(new Map()), '/', 'a real sign-in still works');
  });
});

describe('ORCO_OIDC_*', () => {
  it('needs a client, a public address and https', () => {
    assert.equal(oidcSetting({}, 'https://orco.example.com'), undefined);
    const env = { ORCO_OIDC_ISSUER: 'https://git.example.com', ORCO_OIDC_CLIENT_ID: 'id', ORCO_OIDC_CLIENT_SECRET: 'secret', ORCO_OIDC_LABEL: 'Gitea', ORCO_OIDC_DOMAINS: 'example.com, @corp.example' };
    assert.deepEqual(oidcSetting(env, 'https://orco.example.com/'), {
      issuer: 'https://git.example.com',
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'https://orco.example.com/auth/oidc/callback',
      label: 'Gitea',
      domains: ['example.com', 'corp.example'],
    });
    assert.throws(() => oidcSetting(env, undefined), /ORCO_PUBLIC_URL/);
    assert.throws(() => oidcSetting({ ...env, ORCO_OIDC_CLIENT_SECRET: '' }, 'https://o.example'), /CLIENT_SECRET/);
    assert.throws(() => oidcSetting({ ...env, ORCO_OIDC_ISSUER: 'http://git.example.com' }, 'https://o.example'), /https/);
  });
});
