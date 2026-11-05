import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { oidcSetting } from '../src/commands.js';
import { openDatabase } from '../src/db.js';
import { createApp, frameAncestors } from '../src/http.js';
import { Oidc } from '../src/oidc.js';
import { Store } from '../src/store.js';

// A company OIDC hub (#143): public client with PKCE, groups decide access and roles.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'h1', alg: 'RS256', use: 'sig' };
let issuer: string;
let nextUser: { sub: string; username: string; groups: string[] } = { sub: 'u-1', username: 'Ana Lima', groups: ['app-orco'] };
const codes = new Map<string, { nonce: string; challenge: string; user: typeof nextUser }>();
let lastTokenRequest: { auth: string | undefined; clientId: string | null; scope: string | null } = { auth: undefined, clientId: null, scope: null };
let lastScope: string | null = null;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function sign(claims: Record<string, unknown>): string {
  const body = `${b64({ alg: 'RS256', kid: 'h1', typ: 'JWT' })}.${b64(claims)}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url')}`;
}

function hub(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, end_session_endpoint: `${issuer}/logout` });
    }
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      lastScope = url.searchParams.get('scope');
      const code = `code-${codes.size + 1}`;
      codes.set(code, { nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')!, user: nextUser });
      res.writeHead(302, { Location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}` });
      return res.end();
    }
    if (url.pathname === '/token') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        lastTokenRequest = { auth: req.headers.authorization, clientId: form.get('client_id'), scope: lastScope };
        // A public client: no secret, the client id in the body, PKCE proves the rest.
        if (req.headers.authorization || form.get('client_id') !== 'orco') return json({ error: 'invalid_client' }, 401);
        const grant = codes.get(form.get('code') ?? '');
        if (!grant || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== grant.challenge) return json({ error: 'invalid_grant' }, 400);
        const now = Math.floor(Date.now() / 1000);
        json({ id_token: sign({ iss: issuer, aud: 'orco', sub: grant.user.sub, preferred_username: grant.user.username, groups: grant.user.groups, nonce: grant.nonce, iat: now, exp: now + 300 }) });
      });
      return;
    }
    json({ error: 'not found' }, 404);
  });
}

let store: Store;
let base: string;
let stop: () => Promise<void>;

async function signIn(jar: Map<string, string>): Promise<string> {
  const send = (url: string, init: RequestInit = {}) => fetch(url, { redirect: 'manual', ...init, headers: { ...(init.headers ?? {}), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
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
  res = await send(res.headers.get('location')!);
  res = await send(res.headers.get('location')!);
  keep(res);
  return res.headers.get('location')!;
}

describe('sign in with a company OIDC hub (#143)', () => {
  before(async () => {
    const provider = hub();
    provider.listen(0, '127.0.0.1');
    await new Promise((r) => provider.once('listening', r));
    issuer = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    store = new Store(openDatabase(':memory:'));
    store.createUser('owner');
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    server.close();
    const config = oidcSetting({ ORCO_OIDC_ISSUER: issuer, ORCO_OIDC_APP: 'orco', ORCO_APP_BASE_URL: base }, undefined)!;
    assert.equal(config.clientSecret, '');
    const { app, close } = createApp(store, { publicUrl: base, oidc: new Oidc(config) });
    const orco = app.listen(Number(new URL(base).port), '127.0.0.1');
    await new Promise((r) => orco.once('listening', r));
    stop = async () => {
      await close();
      orco.closeAllConnections();
      provider.closeAllConnections();
      await Promise.all([new Promise((r) => orco.close(r)), new Promise((r) => provider.close(r))]);
    };
  });
  after(() => stop());

  it('signs a member in as a new person keyed on sub, with no secret sent', async () => {
    const jar = new Map<string, string>();
    nextUser = { sub: 'u-1', username: 'Ana Lima', groups: ['app-orco', 'app-other'] };
    assert.equal(await signIn(jar), '/');
    assert.equal(lastTokenRequest.auth, undefined);
    assert.equal(lastTokenRequest.clientId, 'orco');
    assert.match(lastTokenRequest.scope ?? '', /groups/);
    const me = (await (await fetch(`${base}/api/me`, { headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } })).json()) as { name: string };
    assert.equal(me.name, 'ana-lima');
    assert.equal(store.isOrgAdmin(store.participantByName('ana-lima')!), false);
    // Same subject, new username: still the same person.
    nextUser = { sub: 'u-1', username: 'Ana L.', groups: ['app-orco', 'app-orco-admin'] };
    await signIn(new Map());
    assert.equal(store.participantByName('ana-l'), null);
    assert.equal(store.isOrgAdmin(store.participantByName('ana-lima')!), true, 'app-orco-admin makes an org admin');
  });

  it('refuses someone without app-orco', async () => {
    nextUser = { sub: 'u-2', username: 'Ben', groups: ['app-other'] };
    assert.equal(await signIn(new Map()), '/#!signin-error=group');
    assert.equal(store.participantByName('ben'), null);
  });

  it('signs out of the hub too, with id_token_hint', async () => {
    const jar = new Map<string, string>();
    nextUser = { sub: 'u-3', username: 'Cara', groups: ['app-orco'] };
    await signIn(jar);
    const res = await fetch(`${base}/api/session`, { method: 'DELETE', headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    const body = (await res.json()) as { redirect: string };
    const url = new URL(body.redirect);
    assert.equal(`${url.origin}${url.pathname}`, `${issuer}/logout`);
    assert.ok((url.searchParams.get('id_token_hint') ?? '').split('.').length === 3);
    assert.equal(url.searchParams.get('post_logout_redirect_uri'), `${base}/`);
  });

  it('lets only listed https origins frame the app', () => {
    assert.equal(frameAncestors(undefined), "'none'");
    assert.equal(frameAncestors('https://hub.example.com, http://evil.test javascript:x'), "'self' https://hub.example.com");
  });
});
