import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  Client,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { Store } from '../src/store.js';

const CALLBACK = 'http://127.0.0.1:1/callback';

let base: string;
let carlosToken: string;
let closeServer: () => Promise<void>;
let store: Store;

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  store = new Store(openDatabase(':memory:'));
  carlosToken = store.createUser('carlos').token;
  store.createAgent('carlos', 'carlos-grok');
  const { app, close } = createApp(store, { publicUrl: base });
  const server = app.listen(port, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  closeServer = async () => {
    await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
});

after(async () => {
  await closeServer();
});

class TestProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = '';
  authorizationUrl?: URL;

  get redirectUrl() {
    return CALLBACK;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Test Cloud Agent',
      redirect_uris: [CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() {
    return 'state-123';
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  discovery?: OAuthDiscoveryState;
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

async function actAsUser(authorizationUrl: URL, decision: 'approve' | 'deny'): Promise<URL> {
  const start = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(start.status, 303);
  const consentUrl = new URL(start.headers.get('location')!, base);
  const cookie = `orco_token=${encodeURIComponent(carlosToken)}`;
  const pageHtml = await (await fetch(consentUrl, { headers: { Cookie: cookie } })).text();
  assert.match(pageHtml, /Test Cloud Agent/);
  assert.match(pageHtml, /127\.0\.0\.1:1/);
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(pageHtml)![1]!;
  const decided = await fetch(`${base}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request: field('request'), nonce: field('nonce'), agent: 'carlos-grok', decision }),
  });
  assert.equal(decided.status, 303);
  return new URL(decided.headers.get('location')!);
}

function transport(provider: OAuthClientProvider) {
  return new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
}

describe('OAuth with the official MCP client', () => {
  it('advertises the authorization server on a 401', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  it('registers, gets consent, exchanges the code and calls tools as the chosen agent', async () => {
    const provider = new TestProvider();
    const first = new Client({ name: 'cloud-agent', version: '0.0.0' });
    const firstTransport = transport(provider);
    await assert.rejects(first.connect(firstTransport), UnauthorizedError);
    assert.ok(provider.info?.client_id, 'dynamic client registration happened');
    const authUrl = provider.authorizationUrl!;
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authUrl.searchParams.get('resource')?.endsWith('/mcp'));

    const callback = await actAsUser(authUrl, 'approve');
    assert.equal(callback.searchParams.get('state'), 'state-123');
    assert.equal(callback.searchParams.get('iss'), base);
    await firstTransport.finishAuth(callback.searchParams);
    assert.ok(provider.saved?.access_token.startsWith('orco_at_'));

    const client = new Client({ name: 'cloud-agent', version: '0.0.0' });
    await client.connect(transport(provider));
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    const who = JSON.parse((result.content as { text: string }[])[0]!.text);
    assert.deepEqual([who.name, who.kind, who.owner], ['carlos-grok', 'agent', 'carlos']);
    await client.close();

    const audit = store.audit.all().map((e) => e.action);
    assert.ok(audit.includes('oauth.client_register') && audit.includes('oauth.grant'));
  });

  it('does not accept OAuth access tokens on the REST API', async () => {
    const provider = new TestProvider();
    await assert.rejects(new Client({ name: 'c', version: '0' }).connect(transport(provider)), UnauthorizedError);
    const callback = await actAsUser(provider.authorizationUrl!, 'approve');
    const t = transport(provider);
    await t.finishAuth(callback.searchParams);
    const res = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${provider.saved!.access_token}` } });
    assert.equal(res.status, 401);
  });

  it('sends the user back with access_denied when they deny', async () => {
    const provider = new TestProvider();
    await assert.rejects(new Client({ name: 'c', version: '0' }).connect(transport(provider)), UnauthorizedError);
    const callback = await actAsUser(provider.authorizationUrl!, 'deny');
    assert.equal(callback.searchParams.get('error'), 'access_denied');
    assert.equal(callback.searchParams.get('code'), null);
  });

  it('refuses consent posts without a same-origin Origin header', async () => {
    const res = await fetch(`${base}/oauth/consent`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: `orco_token=${carlosToken}`, Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'request=x&nonce=y&agent=carlos-grok&decision=approve',
    });
    assert.equal(res.status, 403);
  });

  it('refuses consent posts that a browser marks as cross-site', async () => {
    const res = await fetch(`${base}/oauth/consent`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: `orco_token=${carlosToken}`, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'request=x&nonce=y&agent=carlos-grok&decision=approve',
    });
    assert.equal(res.status, 403);
  });

  it('rate limits failed sign-ins', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${base}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'orco_u_wrong' }),
      });
      last = res.status;
    }
    assert.equal(last, 429);
  });
});
