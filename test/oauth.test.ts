import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { OAuth, OAuthError, validPublicUrl } from '../src/oauth.js';
import { OrcoError, type Participant, Store } from '../src/store.js';

let now: number;
let store: Store;
let oauth: OAuth;
let carlos: Participant;
let ana: Participant;

const REDIRECT = 'https://connector.example.com/callback';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function oauthCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof OAuthError) return err.error;
    throw err;
  }
  return undefined;
}

function register(extra: Record<string, unknown> = {}) {
  return oauth.register({ redirect_uris: [REDIRECT], client_name: 'Grok Bot', token_endpoint_auth_method: 'none', ...extra });
}

function authorize(clientId: string, overrides: Record<string, string> = {}) {
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: 'https://orco.example.com/mcp',
    ...overrides,
  });
  const { client, redirectUri } = oauth.checkClientAndRedirect(params);
  const id = oauth.startAuthorization(params, client, redirectUri);
  return { id, verifier };
}

function approve(user: Participant, id: string, agent: string) {
  const nonce = oauth.bindViewer(id, user);
  return new URL(oauth.decide(user, id, nonce, { approve: true, agent }));
}

function connect(agent = 'carlos-grok') {
  const client = register();
  const { id, verifier } = authorize(client.client_id);
  const callback = approve(carlos, id, agent);
  const tokens = oauth.token(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: callback.searchParams.get('code')!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      resource: 'https://orco.example.com/mcp',
    }),
  );
  return { client, tokens, callback };
}

beforeEach(() => {
  now = Date.parse('2026-10-27T15:00:00Z');
  store = new Store(openDatabase(':memory:'), { now: () => now });
  carlos = store.createUser('carlos').participant;
  ana = store.createUser('ana').participant;
  store.createAgent('carlos', 'carlos-grok');
  store.createAgent('ana', 'ana-duet');
  oauth = new OAuth(store, 'https://orco.example.com/');
});

describe('configuration and discovery', () => {
  it('requires an https origin, or http on localhost', () => {
    assert.equal(validPublicUrl('https://orco.example.com/'), 'https://orco.example.com');
    assert.equal(validPublicUrl('http://127.0.0.1:7420'), 'http://127.0.0.1:7420');
    assert.throws(() => validPublicUrl('http://orco.office.lan'), OrcoError);
    assert.throws(() => validPublicUrl('https://example.com/orco'), OrcoError);
  });

  it('publishes metadata that MCP clients require', () => {
    const as = oauth.authorizationServerMetadata();
    assert.equal(as.issuer, 'https://orco.example.com');
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.equal(as.authorization_response_iss_parameter_supported, true);
    assert.equal(as.client_id_metadata_document_supported, false);
    const pr = oauth.protectedResourceMetadata();
    assert.equal(pr.resource, 'https://orco.example.com/mcp');
    assert.deepEqual(pr.authorization_servers, ['https://orco.example.com']);
  });
});

describe('client registration', () => {
  it('accepts https and loopback redirects only', () => {
    assert.ok(register().client_id.startsWith('orco_c_'));
    assert.ok(register({ redirect_uris: ['http://127.0.0.1:33418/callback'] }).client_id);
    assert.equal(oauthCode(() => register({ redirect_uris: ['http://evil.example/cb'] })), 'invalid_redirect_uri');
    assert.equal(oauthCode(() => register({ redirect_uris: ['https://x.example/cb#frag'] })), 'invalid_redirect_uri');
    assert.equal(oauthCode(() => register({ redirect_uris: ['myapp://cb'] })), 'invalid_redirect_uri');
    assert.equal(oauthCode(() => register({ redirect_uris: [] })), 'invalid_redirect_uri');
  });

  it('gives confidential clients a secret and requires it at the token endpoint', () => {
    const client = register({ token_endpoint_auth_method: 'client_secret_post' });
    assert.ok(client.client_secret?.startsWith('orco_cs_'));
    const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: 'x' });
    assert.equal(oauthCode(() => oauth.token(form)), 'invalid_client');
    form.set('client_secret', client.client_secret!);
    assert.equal(oauthCode(() => oauth.token(form)), 'invalid_grant');
  });
});

describe('authorization requests', () => {
  it('refuses unknown clients and redirect URIs that were not registered', () => {
    const client = register();
    assert.equal(oauthCode(() => authorize('orco_c_nope')), 'invalid_client');
    assert.equal(oauthCode(() => authorize(client.client_id, { redirect_uri: 'https://connector.example.com/other' })), 'invalid_request');
  });

  it('requires S256 PKCE, this resource and the orco scope', () => {
    const { client_id } = register();
    assert.equal(oauthCode(() => authorize(client_id, { code_challenge_method: 'plain' })), 'invalid_request');
    assert.equal(oauthCode(() => authorize(client_id, { resource: 'https://other.example.com/mcp' })), 'invalid_target');
    assert.equal(oauthCode(() => authorize(client_id, { scope: 'admin' })), 'invalid_scope');
    assert.ok(authorize(client_id, { scope: 'orco offline_access' }).id);
    assert.ok(authorize(client_id, { resource: 'HTTPS://ORCO.EXAMPLE.COM/mcp/' }).id);
  });

  it('binds consent to the person who saw the page', () => {
    const { client_id } = register();
    const { id } = authorize(client_id);
    const nonce = oauth.bindViewer(id, carlos);
    assert.equal(oauthCode(() => oauth.decide(ana, id, nonce, { approve: true, agent: 'ana-duet' })), 'invalid_request');
    assert.equal(oauthCode(() => oauth.decide(carlos, id, 'wrong', { approve: true, agent: 'carlos-grok' })), 'invalid_request');
  });

  it('only lets people pick their own agents', () => {
    const { client_id } = register();
    const { id } = authorize(client_id);
    const nonce = oauth.bindViewer(id, carlos);
    assert.equal(oauthCode(() => oauth.decide(carlos, id, nonce, { approve: true, agent: 'ana-duet' })), 'invalid_request');
  });

  it('redirects with iss and state, including on denial', () => {
    const { client_id } = register();
    const { id } = authorize(client_id);
    const denied = new URL(oauth.decide(carlos, id, oauth.bindViewer(id, carlos), { approve: false }));
    assert.equal(denied.origin + denied.pathname, REDIRECT);
    assert.equal(denied.searchParams.get('error'), 'access_denied');
    assert.equal(denied.searchParams.get('state'), 'xyz');
    assert.equal(denied.searchParams.get('iss'), 'https://orco.example.com');
    const ok = approve(carlos, authorize(client_id).id, 'carlos-grok');
    assert.ok(ok.searchParams.get('code')?.startsWith('orco_ac_'));
    assert.equal(ok.searchParams.get('iss'), 'https://orco.example.com');
  });

  it('expires pending requests after ten minutes', () => {
    const { id } = authorize(register().client_id);
    now += 11 * 60_000;
    assert.equal(oauth.pending(id), null);
  });
});

describe('tokens', () => {
  it('issues tokens that act as the chosen agent', () => {
    const { tokens } = connect();
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.expires_in, 3600);
    assert.equal(oauth.verifyAccessToken(tokens.access_token)?.name, 'carlos-grok');
    assert.equal(store.authenticate(tokens.access_token), null, 'not usable as a static token');
  });

  it('rejects a wrong PKCE verifier', () => {
    const client = register();
    const { id } = authorize(client.client_id);
    const code = approve(carlos, id, 'carlos-grok').searchParams.get('code')!;
    const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: pkce().verifier });
    assert.equal(oauthCode(() => oauth.token(form)), 'invalid_grant');
  });

  it('revokes everything when an authorization code is replayed', () => {
    const client = register();
    const { id, verifier } = authorize(client.client_id);
    const code = approve(carlos, id, 'carlos-grok').searchParams.get('code')!;
    const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier });
    const tokens = oauth.token(form);
    assert.equal(oauthCode(() => oauth.token(form)), 'invalid_grant');
    assert.equal(oauth.verifyAccessToken(tokens.access_token), null);
  });

  it('expires codes after five minutes and access tokens after an hour', () => {
    const client = register();
    const { id, verifier } = authorize(client.client_id);
    const code = approve(carlos, id, 'carlos-grok').searchParams.get('code')!;
    now += 6 * 60_000;
    const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier });
    assert.equal(oauthCode(() => oauth.token(form)), 'invalid_grant');
    const { tokens } = connect();
    now += 3601_000;
    assert.equal(oauth.verifyAccessToken(tokens.access_token), null);
  });

  it('rotates refresh tokens and revokes the grant on replay', () => {
    const { client, tokens } = connect();
    const refresh = (token: string) =>
      oauth.token(new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token }));
    const second = refresh(tokens.refresh_token);
    assert.notEqual(second.refresh_token, tokens.refresh_token);
    assert.equal(oauth.verifyAccessToken(second.access_token)?.name, 'carlos-grok');
    assert.equal(oauthCode(() => refresh(tokens.refresh_token)), 'invalid_grant');
    assert.equal(oauth.verifyAccessToken(second.access_token), null, 'replay revoked the whole connection');
  });

  it('lets the owner see and revoke connections', () => {
    const { tokens } = connect();
    const [connection] = oauth.connections(carlos);
    assert.equal(connection?.agent, 'carlos-grok');
    assert.equal(connection?.client, 'Grok Bot');
    assert.throws(() => oauth.revokeConnection(ana, connection!.id), OrcoError);
    oauth.revokeConnection(carlos, connection!.id);
    assert.equal(oauth.verifyAccessToken(tokens.access_token), null);
    assert.deepEqual(oauth.connections(carlos), []);
  });

  it('lets a client revoke its own token', () => {
    const { client, tokens } = connect();
    oauth.revoke(new URLSearchParams({ client_id: client.client_id, token: tokens.refresh_token }));
    assert.equal(oauth.verifyAccessToken(tokens.access_token), null);
  });

  it('records registration, grants and revocations in the audit log', () => {
    const { tokens } = connect();
    oauth.revokeConnection(carlos, oauth.connections(carlos)[0]!.id);
    assert.equal(oauth.verifyAccessToken(tokens.access_token), null);
    const actions = store.audit.all().map((e) => `${e.actor ?? '-'} ${e.action}`);
    assert.ok(actions.includes('- oauth.client_register'));
    assert.ok(actions.includes('carlos oauth.grant'));
    assert.ok(actions.includes('carlos oauth.revoke'));
  });
});
