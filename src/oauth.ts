import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';
import { hashToken } from './tokens.js';

export const OAUTH_SCOPE = 'orco';
const ACCESS_TTL_MS = 3600_000;
const REFRESH_TTL_MS = 30 * 24 * 3600_000;
const CODE_TTL_MS = 5 * 60_000;
const REQUEST_TTL_MS = 10 * 60_000;
const MAX_REDIRECT_URIS = 10;
const LAST_USED_RESOLUTION_MS = 60_000;
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;
type AuthMethod = (typeof AUTH_METHODS)[number];
const IGNORED_SCOPES = new Set(['offline_access']);

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

export interface OAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  authMethod: AuthMethod;
}

export interface PendingRequest {
  id: string;
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  scope: string;
}

export interface Connection {
  id: number;
  agent: string;
  client: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface ClientRow {
  client_id: string;
  secret_hash: string | null;
  name: string;
  redirect_uris: string;
  auth_method: AuthMethod;
}

function random(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function validPublicUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OrcoError('invalid', `ORCO_PUBLIC_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new OrcoError('invalid', 'ORCO_PUBLIC_URL must use https (http is allowed only for localhost)');
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new OrcoError('invalid', 'ORCO_PUBLIC_URL must be just the origin, like https://orco.example.com');
  }
  return url.origin;
}

function validRedirectUri(raw: unknown): string {
  if (typeof raw !== 'string') throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be strings');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OAuthError('invalid_redirect_uri', `Not a URL: ${raw}`);
  }
  if (url.hash) throw new OAuthError('invalid_redirect_uri', 'Redirect URIs must not contain a fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new OAuthError('invalid_redirect_uri', 'Redirect URIs must use https, or http on localhost');
  }
  return raw;
}

function normalizeResource(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return '';
  }
}

export class OAuth {
  readonly issuer: string;
  readonly resource: string;

  constructor(
    private readonly store: Store,
    publicUrl: string,
  ) {
    this.issuer = validPublicUrl(publicUrl);
    this.resource = `${this.issuer}/mcp`;
  }

  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: [...AUTH_METHODS],
      revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
      scopes_supported: [OAUTH_SCOPE],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: false,
    };
  }

  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [OAUTH_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Orco',
    };
  }

  register(body: Record<string, unknown>) {
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
      throw new OAuthError('invalid_redirect_uri', `Send 1-${MAX_REDIRECT_URIS} redirect_uris`);
    }
    const redirectUris = uris.map(validRedirectUri);
    const authMethod = (body.token_endpoint_auth_method ?? 'client_secret_basic') as AuthMethod;
    if (!AUTH_METHODS.includes(authMethod)) {
      throw new OAuthError('invalid_client_metadata', `Unsupported token_endpoint_auth_method ${String(authMethod)}`);
    }
    const grantTypes = (body.grant_types as unknown[] | undefined) ?? ['authorization_code', 'refresh_token'];
    if (!Array.isArray(grantTypes) || grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
      throw new OAuthError('invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported');
    }
    const responseTypes = (body.response_types as unknown[] | undefined) ?? ['code'];
    if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code')) {
      throw new OAuthError('invalid_client_metadata', 'Only the code response type is supported');
    }
    const rawName = typeof body.client_name === 'string' ? body.client_name.trim() : '';
    const name = (rawName || new URL(redirectUris[0]!).host).slice(0, 100);
    const clientId = random('orco_c_', 16);
    const secret = authMethod === 'none' ? null : random('orco_cs_');
    const now = this.store.now();
    this.store.db
      .prepare(
        'INSERT INTO oauth_clients (client_id, secret_hash, name, redirect_uris, auth_method, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(clientId, secret ? hashToken(secret) : null, name, JSON.stringify(redirectUris), authMethod, now);
    this.store.audit.record(null, 'oauth.client_register', {
      subject: `oauth_client:${clientId}`,
      detail: { name, redirectUris, authMethod },
    });
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: authMethod,
      grant_types: grantTypes,
      response_types: ['code'],
    };
  }

  client(clientId: string): OAuthClient | null {
    const row = this.store.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as ClientRow | undefined;
    return row ? this.toClient(row) : null;
  }

  checkClientAndRedirect(params: URLSearchParams): { client: OAuthClient; redirectUri: string } {
    const client = this.client(params.get('client_id') ?? '');
    if (!client) throw new OAuthError('invalid_client', 'Unknown client. Ask the app to register again.');
    const requested = params.get('redirect_uri');
    const redirectUri = requested ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : '');
    if (!client.redirectUris.includes(redirectUri)) {
      throw new OAuthError('invalid_request', 'The redirect URI does not match what this app registered.');
    }
    return { client, redirectUri };
  }

  startAuthorization(params: URLSearchParams, client: OAuthClient, redirectUri: string): string {
    if (params.get('response_type') !== 'code') throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported');
    const challenge = params.get('code_challenge');
    if (!challenge || params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      throw new OAuthError('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    const resource = params.get('resource');
    if (resource !== null && !this.acceptsResource(resource)) {
      throw new OAuthError('invalid_target', `This server only issues tokens for ${this.resource}`);
    }
    const scope = this.grantedScope(params.get('scope'));
    const id = random('orco_rq_', 24);
    this.store.db
      .prepare(
        `INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, state, scope, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, client.clientId, redirectUri, challenge, params.get('state'), scope, this.store.now() + REQUEST_TTL_MS);
    return id;
  }

  pending(id: string): PendingRequest | null {
    const row = this.store.db.prepare('SELECT * FROM oauth_requests WHERE id = ? AND expires_at > ?').get(id, this.store.now()) as
      | { id: string; client_id: string; redirect_uri: string; state: string | null; scope: string }
      | undefined;
    const client = row ? this.client(row.client_id) : null;
    if (!row || !client) return null;
    return { id: row.id, client, redirectUri: row.redirect_uri, state: row.state, scope: row.scope };
  }

  bindViewer(id: string, viewer: Participant): string {
    const nonce = random('', 24);
    this.store.db.prepare('UPDATE oauth_requests SET viewer_id = ?, nonce = ? WHERE id = ?').run(viewer.id, nonce, id);
    return nonce;
  }

  decide(user: Participant, id: string, nonce: string, decision: { approve: boolean; agent?: string }): string {
    const row = this.store.db
      .prepare('SELECT * FROM oauth_requests WHERE id = ? AND expires_at > ?')
      .get(id, this.store.now()) as
      | { client_id: string; redirect_uri: string; code_challenge: string; state: string | null; scope: string; viewer_id: number | null; nonce: string | null }
      | undefined;
    if (!row || row.viewer_id !== user.id || !row.nonce || !sameSecret(row.nonce, nonce)) {
      throw new OAuthError('invalid_request', 'This sign-in request expired or was opened by someone else. Start again from the app.');
    }
    this.store.db.prepare('DELETE FROM oauth_requests WHERE id = ?').run(id);
    const redirect = new URL(row.redirect_uri);
    if (row.state !== null) redirect.searchParams.set('state', row.state);
    redirect.searchParams.set('iss', this.issuer);
    if (!decision.approve) {
      redirect.searchParams.set('error', 'access_denied');
      return redirect.toString();
    }
    const agent = this.store.participantByName(decision.agent ?? '');
    if (!agent || agent.kind !== 'agent' || agent.ownerId !== user.id) {
      throw new OAuthError('invalid_request', 'Choose one of your own agents');
    }
    const code = random('orco_ac_');
    this.store.db
      .prepare(
        `INSERT INTO oauth_codes (code_hash, client_id, agent_id, user_id, scope, redirect_uri, code_challenge, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(hashToken(code), row.client_id, agent.id, user.id, row.scope, row.redirect_uri, row.code_challenge, this.store.now() + CODE_TTL_MS);
    redirect.searchParams.set('code', code);
    return redirect.toString();
  }

  token(form: URLSearchParams, authorization?: string) {
    const client = this.authenticateClient(form, authorization);
    const grantType = form.get('grant_type');
    const resource = form.get('resource');
    if (resource !== null && !this.acceptsResource(resource)) {
      throw new OAuthError('invalid_target', `This server only issues tokens for ${this.resource}`);
    }
    if (grantType === 'authorization_code') return this.exchangeCode(client, form);
    if (grantType === 'refresh_token') return this.refresh(client, form);
    throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
  }

  revoke(form: URLSearchParams, authorization?: string): void {
    const client = this.authenticateClient(form, authorization);
    const token = form.get('token') ?? '';
    const row = this.store.db
      .prepare('SELECT t.grant_id, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ?')
      .get(hashToken(token)) as { grant_id: number; client_id: string } | undefined;
    if (row && row.client_id === client.clientId) this.revokeGrant(row.grant_id, null, 'client');
  }

  verifyAccessToken(token: string): Participant | null {
    if (!token.startsWith('orco_at_')) return null;
    const row = this.store.db
      .prepare(
        `SELECT g.id AS grant_id, g.agent_id, g.last_used_at FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
         WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > ? AND g.revoked_at IS NULL`,
      )
      .get(hashToken(token), this.store.now()) as { grant_id: number; agent_id: number; last_used_at: number | null } | undefined;
    if (!row) return null;
    const now = this.store.now();
    if (row.last_used_at === null || now - row.last_used_at > LAST_USED_RESOLUTION_MS) {
      this.store.db.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(now, row.grant_id);
    }
    return this.store.participantById(row.agent_id);
  }

  connections(user: Participant): Connection[] {
    const rows = this.store.db
      .prepare(
        `SELECT g.id, a.name AS agent, c.name AS client, g.created_at, g.last_used_at FROM oauth_grants g
         JOIN participants a ON a.id = g.agent_id JOIN oauth_clients c ON c.client_id = g.client_id
         WHERE g.user_id = ? AND g.revoked_at IS NULL ORDER BY g.id`,
      )
      .all(user.id) as unknown as { id: number; agent: string; client: string; created_at: number; last_used_at: number | null }[];
    return rows.map((row) => ({
      id: row.id,
      agent: row.agent,
      client: row.client,
      createdAt: new Date(row.created_at).toISOString(),
      lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
    }));
  }

  revokeConnection(user: Participant, grantId: number): void {
    const row = this.store.db.prepare('SELECT user_id FROM oauth_grants WHERE id = ? AND revoked_at IS NULL').get(grantId) as
      | { user_id: number }
      | undefined;
    if (!row || row.user_id !== user.id) throw new OrcoError('not_found', `No connection ${grantId}`);
    this.revokeGrant(grantId, user, 'owner');
  }

  private exchangeCode(client: OAuthClient, form: URLSearchParams) {
    const code = form.get('code') ?? '';
    const row = this.store.db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hashToken(code)) as
      | {
          code_hash: string;
          client_id: string;
          agent_id: number;
          user_id: number;
          scope: string;
          redirect_uri: string;
          code_challenge: string;
          expires_at: number;
          used_at: number | null;
          grant_id: number | null;
        }
      | undefined;
    if (!row || row.client_id !== client.clientId) throw new OAuthError('invalid_grant', 'Unknown authorization code');
    if (row.used_at !== null) {
      if (row.grant_id !== null) this.revokeGrant(row.grant_id, null, 'code_replay');
      throw new OAuthError('invalid_grant', 'This authorization code was already used');
    }
    if (row.expires_at <= this.store.now()) throw new OAuthError('invalid_grant', 'The authorization code expired');
    const redirectUri = form.get('redirect_uri');
    if (redirectUri !== null && redirectUri !== row.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match');
    const verifier = form.get('code_verifier') ?? '';
    const computed = createHash('sha256').update(verifier).digest('base64url');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !sameSecret(computed, row.code_challenge)) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed');
    }
    const now = this.store.now();
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO oauth_grants (client_id, agent_id, user_id, scope, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(client.clientId, row.agent_id, row.user_id, row.scope, now);
    const grantId = Number(lastInsertRowid);
    this.store.db.prepare('UPDATE oauth_codes SET used_at = ?, grant_id = ? WHERE code_hash = ?').run(now, grantId, row.code_hash);
    const agent = this.store.participantById(row.agent_id)!;
    const user = this.store.participantById(row.user_id)!;
    this.store.audit.record(user, 'oauth.grant', {
      subject: `agent:${agent.name}`,
      detail: { client: client.name, clientId: client.clientId, grantId },
    });
    return this.issueTokens(grantId, row.scope);
  }

  private refresh(client: OAuthClient, form: URLSearchParams) {
    const token = form.get('refresh_token') ?? '';
    const row = this.store.db
      .prepare(
        `SELECT t.token_hash, t.expires_at, t.used_at, g.id AS grant_id, g.client_id, g.scope, g.revoked_at
         FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ? AND t.kind = 'refresh'`,
      )
      .get(hashToken(token)) as
      | { token_hash: string; expires_at: number; used_at: number | null; grant_id: number; client_id: string; scope: string; revoked_at: number | null }
      | undefined;
    if (!row || row.client_id !== client.clientId || row.revoked_at !== null) throw new OAuthError('invalid_grant', 'Unknown refresh token');
    if (row.used_at !== null) {
      this.revokeGrant(row.grant_id, null, 'refresh_replay');
      throw new OAuthError('invalid_grant', 'This refresh token was already used; the connection has been revoked');
    }
    if (row.expires_at <= this.store.now()) throw new OAuthError('invalid_grant', 'The refresh token expired');
    this.store.db.prepare('UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ?').run(this.store.now(), row.token_hash);
    return this.issueTokens(row.grant_id, row.scope);
  }

  private issueTokens(grantId: number, scope: string) {
    const access = random('orco_at_');
    const refresh = random('orco_rt_');
    const now = this.store.now();
    const insert = this.store.db.prepare('INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES (?, ?, ?, ?)');
    insert.run(hashToken(access), grantId, 'access', now + ACCESS_TTL_MS);
    insert.run(hashToken(refresh), grantId, 'refresh', now + REFRESH_TTL_MS);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: refresh,
      scope,
    };
  }

  private revokeGrant(grantId: number, actor: Participant | null, reason: string): void {
    const result = this.store.db
      .prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(this.store.now(), grantId);
    if (Number(result.changes) === 0) return;
    this.store.db.prepare('DELETE FROM oauth_tokens WHERE grant_id = ?').run(grantId);
    this.store.audit.record(actor, 'oauth.revoke', { subject: `oauth_grant:${grantId}`, detail: { reason } });
  }

  private authenticateClient(form: URLSearchParams, authorization?: string): OAuthClient {
    let clientId = form.get('client_id') ?? '';
    let secret = form.get('client_secret');
    const basic = /^Basic (.+)$/i.exec(authorization ?? '')?.[1];
    if (basic) {
      const decoded = Buffer.from(basic, 'base64').toString();
      const colon = decoded.indexOf(':');
      if (colon < 0) throw new OAuthError('invalid_client', 'Malformed Basic credentials', 401);
      clientId = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
    }
    const row = this.store.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as ClientRow | undefined;
    if (!row) throw new OAuthError('invalid_client', 'Unknown client', 401);
    if (row.secret_hash !== null) {
      if (!secret || !sameSecret(hashToken(secret), row.secret_hash)) throw new OAuthError('invalid_client', 'Client authentication failed', 401);
    }
    return this.toClient(row);
  }

  private acceptsResource(resource: string): boolean {
    const normalized = normalizeResource(resource);
    return normalized === normalizeResource(this.resource) || normalized === normalizeResource(this.issuer);
  }

  private grantedScope(requested: string | null): string {
    if (requested === null) return OAUTH_SCOPE;
    const scopes = requested.split(/\s+/).filter((s) => s && !IGNORED_SCOPES.has(s));
    if (scopes.some((s) => s !== OAUTH_SCOPE)) throw new OAuthError('invalid_scope', `Only the "${OAUTH_SCOPE}" scope exists`);
    return OAUTH_SCOPE;
  }

  private toClient(row: ClientRow): OAuthClient {
    return { clientId: row.client_id, name: row.name, redirectUris: JSON.parse(row.redirect_uris), authMethod: row.auth_method };
  }
}
