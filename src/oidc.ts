import { createHash, createPublicKey, type JsonWebKey, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { OrcoError } from './errors.js';
import { normalizeIdentity } from './identities.js';

/** How long a sign-in may take between leaving for the provider and coming back. */
const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 500;
const JWKS_TTL_MS = 60 * 60_000;
const SKEW_S = 120;

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Where the provider sends people back: <ORCO_PUBLIC_URL>/auth/oidc/callback. */
  redirectUri: string;
  /** What the sign-in button says ("Gitea"). */
  label: string;
  /** Only emails in these domains may sign in (empty: any the provider vouches for). */
  domains: string[];
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Pending {
  nonce: string;
  verifier: string;
  binding: string;
  expiresAt: number;
}

type Fetch = typeof fetch;

const b64url = (data: Buffer) => data.toString('base64url');
const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** RS*, PS*, ES* and EdDSA: what OpenID providers sign ID tokens with. */
const ALGS: Record<string, { hash: string | null; pss?: boolean; ecdsa?: boolean }> = {
  RS256: { hash: 'sha256' },
  RS384: { hash: 'sha384' },
  RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: true },
  PS384: { hash: 'sha384', pss: true },
  PS512: { hash: 'sha512', pss: true },
  ES256: { hash: 'sha256', ecdsa: true },
  ES384: { hash: 'sha384', ecdsa: true },
  ES512: { hash: 'sha512', ecdsa: true },
  EdDSA: { hash: null },
};

/**
 * Sign in with an OpenID Connect provider (Gitea or Forgejo, Google, Microsoft, Keycloak, ...). Orco is
 * the client: authorization code with PKCE, and it checks the ID token itself: signature against the
 * issuer's keys, issuer, audience, expiry and nonce. A cookie ties each sign-in to the browser that
 * started it, so nobody can finish a sign-in someone else began. The issuer an org admin configured
 * (and the endpoints it publishes) are the only places this calls.
 */
export class Oidc {
  private discovery: Discovery | null = null;
  private jwks: { keys: (JsonWebKey & { kid?: string; alg?: string; use?: string })[]; at: number } | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(
    readonly config: OidcConfig,
    private readonly now: () => number = Date.now,
    private readonly fetcher: Fetch = fetch,
  ) {}

  /**
   * Starts a sign-in: where to send the browser, and a value for a cookie that must come back with it.
   */
  async start(): Promise<{ url: string; binding: string }> {
    const d = await this.discover();
    this.sweep();
    if (this.pending.size >= MAX_PENDING) throw new OrcoError('rate_limited', 'Too many sign-ins in progress; try again in a few minutes');
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const binding = b64url(randomBytes(24));
    this.pending.set(state, { nonce, verifier, binding, expiresAt: this.now() + PENDING_TTL_MS });
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: b64url(sha256(verifier)),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), binding: `${state}.${binding}` };
  }

  /** Finishes a sign-in: checks it belongs to this browser, swaps the code, checks the ID token. Returns the login. */
  async finish(params: { code?: unknown; state?: unknown; error?: unknown }, cookie: string | undefined): Promise<{ identity: string; name: string | null }> {
    if (typeof params.error === 'string') throw new OrcoError('forbidden', `${this.config.label} did not sign you in (${params.error.slice(0, 60)})`);
    const state = typeof params.state === 'string' ? params.state : '';
    const pending = this.pending.get(state);
    this.pending.delete(state);
    const [cookieState, cookieBinding] = (cookie ?? '').split('.');
    if (!pending || pending.expiresAt <= this.now() || cookieState !== state || !cookieBinding || !equal(cookieBinding, pending.binding)) {
      throw new OrcoError('forbidden', 'That sign-in did not start in this browser, or took too long; try again');
    }
    if (typeof params.code !== 'string' || !params.code) throw new OrcoError('invalid', `${this.config.label} sent no code`);
    const d = await this.discover();
    const res = await this.fetcher(d.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: params.code, redirect_uri: this.config.redirectUri, code_verifier: pending.verifier }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const tokens = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!res.ok || typeof tokens.id_token !== 'string') throw new OrcoError('forbidden', `${this.config.label} refused the sign-in${tokens.error ? ` (${String(tokens.error).slice(0, 60)})` : ''}`);
    const claims = await this.verify(tokens.id_token, pending.nonce);
    if (claims.email_verified !== true || typeof claims.email !== 'string') {
      throw new OrcoError('forbidden', `${this.config.label} did not vouch for an email address; Orco signs people in by verified email`);
    }
    const identity = normalizeIdentity(claims.email);
    if (!identity) throw new OrcoError('forbidden', `${this.config.label} sent an email Orco cannot use`);
    const domain = identity.split('@')[1] ?? '';
    if (this.config.domains.length && !this.config.domains.includes(domain)) throw new OrcoError('forbidden', `${identity} is not in a domain allowed to sign in here`);
    return { identity, name: typeof claims.preferred_username === 'string' ? claims.preferred_username : typeof claims.name === 'string' ? claims.name : null };
  }

  /** Checks an ID token: signature (against the issuer's published keys), issuer, audience, time and nonce. */
  async verify(token: string, nonce: string): Promise<Record<string, unknown>> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new OrcoError('forbidden', 'The ID token is malformed');
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      throw new OrcoError('forbidden', 'The ID token is malformed');
    }
    const alg = ALGS[header.alg ?? ''];
    if (!alg) throw new OrcoError('forbidden', `The ID token is signed with ${header.alg ?? 'nothing'}, which Orco does not accept`);
    const jwk = await this.key(header.kid, header.alg!);
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const ok = verifySignature(
      alg.hash,
      Buffer.from(`${h}.${p}`),
      alg.pss ? { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: -1 } : alg.ecdsa ? { key, dsaEncoding: 'ieee-p1363' } : key,
      Buffer.from(s, 'base64url'),
    );
    if (!ok) throw new OrcoError('forbidden', 'The ID token’s signature does not check out');
    const d = await this.discover();
    const now = Math.floor(this.now() / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== d.issuer) throw new OrcoError('forbidden', 'The ID token is from another issuer');
    if (!aud.includes(this.config.clientId)) throw new OrcoError('forbidden', 'The ID token is for another app');
    if (aud.length > 1 && claims.azp !== undefined && claims.azp !== this.config.clientId) throw new OrcoError('forbidden', 'The ID token is for another app');
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < now) throw new OrcoError('forbidden', 'The ID token has expired');
    if (typeof claims.iat === 'number' && claims.iat - SKEW_S > now) throw new OrcoError('forbidden', 'The ID token is from the future');
    if (typeof claims.nonce !== 'string' || !equal(claims.nonce, nonce)) throw new OrcoError('forbidden', 'The ID token does not belong to this sign-in');
    return claims;
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const issuer = this.config.issuer.replace(/\/+$/, '');
    const data = (await this.getJson(`${issuer}/.well-known/openid-configuration`)) as Partial<Discovery>;
    for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (typeof data[field] !== 'string') throw new OrcoError('conflict', `${this.config.label}'s OpenID configuration has no ${field}`);
    }
    if (data.issuer!.replace(/\/+$/, '') !== issuer) throw new OrcoError('conflict', `${this.config.label} calls itself ${data.issuer}, not ${issuer}`);
    // The endpoints come from the issuer an admin chose; still, keep them on https when it is.
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (issuer.startsWith('https://') && !data[field]!.startsWith('https://')) throw new OrcoError('conflict', `${this.config.label}'s ${field} is not https`);
    }
    this.discovery = data as Discovery;
    return this.discovery;
  }

  /** The issuer's signing key: from the cached key set, fetched again (at most once a minute) for a new key id. */
  private async key(kid: string | undefined, alg: string): Promise<JsonWebKey> {
    const pick = () => this.jwks?.keys.find((k) => (kid === undefined || k.kid === kid) && (k.use === undefined || k.use === 'sig') && (k.alg === undefined || k.alg === alg));
    const stale = !this.jwks || this.now() - this.jwks.at > JWKS_TTL_MS;
    if (stale || (!pick() && this.now() - (this.jwks?.at ?? 0) > 60_000)) {
      const d = await this.discover();
      const data = (await this.getJson(d.jwks_uri)) as { keys?: unknown };
      if (!Array.isArray(data.keys)) throw new OrcoError('conflict', `${this.config.label} publishes no signing keys`);
      this.jwks = { keys: data.keys as never, at: this.now() };
    }
    const key = pick();
    if (!key) throw new OrcoError('forbidden', 'The ID token is signed with a key the issuer does not publish');
    return key;
  }

  private async getJson(url: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new OrcoError('conflict', `Cannot reach ${this.config.label} (${new URL(url).host}): ${(err as Error).message}`);
    }
    if (!res.ok) throw new OrcoError('conflict', `${this.config.label} answered ${res.status} for ${new URL(url).pathname}`);
    return res.json();
  }

  private sweep(): void {
    const now = this.now();
    for (const [state, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(state);
  }
}

function equal(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}
