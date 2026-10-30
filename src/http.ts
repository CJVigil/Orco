import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import express, { type NextFunction, type Request, type Response } from 'express';
import { MAX_ATTACHMENT_BYTES } from './attachments.js';
import { buildMcpServer } from './mcp.js';
import { OAUTH_SCOPE, OAuth } from './oauth.js';
import { oauthRouter } from './oauth-routes.js';
import { Presence } from './presence.js';
import { RateLimiter } from './ratelimit.js';
import { type Message, OrcoError, type Participant, type Store } from './store.js';
import { parsePolicy } from './policies.js';
import type { Task, TaskState } from './tasks.js';
import type { Approval } from './approvals.js';
import type { Question, QuestionTarget } from './questions.js';
import { byWorkOrder, type Priority, type StatusCategory, type TicketFilter, type TicketInput } from './tickets.js';
import { importTickets, parseImport } from './import.js';
import { SESSION_TTL_MS } from './signins.js';
import { normalizeIdentity } from './identities.js';
import { TEMPLATES } from './hosted.js';
import { type Oidc, OidcError } from './oidc.js';
import { SEARCH_KINDS, type SearchKind, searchAll } from './search.js';
import { catchUp } from './catchup.js';
import type { Wake } from './reminders.js';
import type { Review } from './reviews.js';
import type { ScheduleInput } from './schedules.js';
import type { TaskResult } from './tasks.js';
import { myWork } from './work.js';

declare module 'express-serve-static-core' {
  interface Request {
    participant?: Participant;
    viaCookie?: boolean;
  }
}

const STATUS: Record<OrcoError['code'], number> = {
  invalid: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  rate_limited: 429,
};
const OIDC_COOKIE = 'orco_oidc';
const OIDC_PENDING_COOKIE = 'orco_oidc_login';
/** The header in which the sign-in proxy proves itself to Orco (ORCO_AUTH_SECRET). */
const PROXY_SECRET_HEADER = 'x-orco-auth-secret';
const COOKIE = 'orco_token';
const TASK_STATES = new Set(['accepted', 'declined', 'done', 'failed', 'cancelled']);
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = join(APP_DIR, 'web');
const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
/** Where computers joining this server download Orco from, so `npx` can run it without an install. */
export const PACKAGE_PATH = `/install/orco-${VERSION}.tgz`;

/**
 * The Orco package this server hands out: `ORCO_PACKAGE`, or one made by `npm pack` in the app folder
 * (the Docker image has one). Looked up on each request, so packing after the server starts works.
 */
function packageFile(configured: string | null | undefined): string | undefined {
  if (configured === null) return undefined;
  const candidates = configured ? [resolve(configured)] : [join(APP_DIR, 'orco.tgz'), join(APP_DIR, `orco-${VERSION}.tgz`)];
  return candidates.find((path) => existsSync(path));
}
const HEARTBEAT_MS = 25_000;

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

const STALL_SWEEP_MS = 60_000;

function authenticate(store: Store, presence: Presence, oauth?: OAuth, proxyIdentity?: (req: Request) => string | null) {
  return (req: Request, res: Response, next: NextFunction) => {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const token = bearer ?? readCookie(req.headers.cookie, COOKIE);
    // Browser sessions from sign-in links work only as the cookie, and only for the web app's API.
    const session = bearer === undefined && token !== undefined && store.signins.isSession(token);
    let participant = !token
      ? null
      : session
        ? req.originalUrl.startsWith('/api/')
          ? store.signins.session(token)
          : null
        : oauth && bearer
          ? (oauth.verifyAccessToken(bearer) ?? store.authenticate(bearer))
          : store.authenticate(token);
    // Behind a sign-in proxy, the proxy says who is at the keyboard: a browser session counts only if
    // the proxy's login is that person's (not someone else's, and not a login linked to nobody, as on a
    // shared computer where the last person's session is still there).
    if (participant && session && proxyIdentity) {
      const identity = proxyIdentity(req);
      const owner = identity ? store.identities.userFor(identity) : null;
      if (identity && owner?.id !== participant.id) participant = null;
    }
    if (!token || !participant) {
      const challenge = oauth
        ? `Bearer resource_metadata="${oauth.issuer}/.well-known/oauth-protected-resource/mcp", scope="${OAUTH_SCOPE}"`
        : 'Bearer';
      res.status(401).set('WWW-Authenticate', challenge).json({ error: 'Missing or invalid token' });
      return;
    }
    req.participant = participant;
    req.viaCookie = bearer === undefined;
    // The bridge uses the agent's token, but its calls say nothing about whether the agent is alive.
    if (req.headers['x-orco-bridge'] !== '1') {
      presence.touch(participant.id);
      store.tasks.touch(participant);
    }
    Object.assign(req, { auth: { token, clientId: participant.name, scopes: [], extra: { participant } } });
    next();
  };
}

function rejectCrossSite(req: Request, res: Response, next: NextFunction) {
  if (!req.viaCookie || req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  const sameOrigin = !origin || new URL(origin).host === req.headers.host;
  if (!sameOrigin || !req.is('application/json')) {
    res.status(403).json({ error: 'Cross-site or non-JSON request refused' });
    return;
  }
  next();
}

function rejectCrossSiteUpload(req: Request, res: Response, next: NextFunction) {
  if (!req.viaCookie) return next();
  const origin = req.headers.origin;
  const sameOrigin = origin ? new URL(origin).host === req.headers.host : req.headers['sec-fetch-site'] === 'same-origin';
  if (!sameOrigin) {
    res.status(403).json({ error: 'Cross-site upload refused' });
    return;
  }
  next();
}

function str(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new OrcoError('invalid', `${field} must be a string`);
  return value;
}

function nullableStr(value: unknown, field: string): string | null | undefined {
  return value === null ? null : str(value, field);
}

function ticketInput(body: Record<string, unknown> | undefined): TicketInput {
  const b = body ?? {};
  const num = (value: unknown, field: string): number | null | undefined => {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'number') throw new OrcoError('invalid', `${field} must be a number`);
    return value;
  };
  const list = <T extends 'string' | 'number'>(value: unknown, field: string, type: T) => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((v) => typeof v !== type || (type === 'number' && !Number.isInteger(v)))) {
      throw new OrcoError('invalid', `${field} must be a list of ${type === 'number' ? 'ids' : 'strings'}`);
    }
    return value as (T extends 'number' ? number : string)[];
  };
  if (b.labels !== undefined && (!Array.isArray(b.labels) || b.labels.some((l) => typeof l !== 'string'))) {
    throw new OrcoError('invalid', 'labels must be a list of names');
  }
  const cycle = b.cycle === 'current' ? 'current' : num(b.cycle, 'cycle');
  return {
    title: str(b.title, 'title'),
    description: str(b.description, 'description'),
    status: str(b.status, 'status'),
    priority: str(b.priority, 'priority') as Priority | undefined,
    estimate: num(b.estimate, 'estimate'),
    dueDate: nullableStr(b.dueDate, 'dueDate'),
    assignee: nullableStr(b.assignee, 'assignee'),
    labels: b.labels as string[] | undefined,
    milestone: nullableStr(b.milestone, 'milestone'),
    cycle,
    parent: nullableStr(b.parent, 'parent'),
    sort: num(b.sort, 'sort') ?? undefined,
    handoff: str(b.handoff, 'handoff'),
    criteriaAdd: list(b.criteriaAdd, 'criteriaAdd', 'string'),
    criteriaDone: list(b.criteriaDone, 'criteriaDone', 'number'),
    criteriaUndone: list(b.criteriaUndone, 'criteriaUndone', 'number'),
    criteriaRemove: list(b.criteriaRemove, 'criteriaRemove', 'number'),
    blockedByAdd: list(b.blockedByAdd, 'blockedByAdd', 'string'),
    blockedByRemove: list(b.blockedByRemove, 'blockedByRemove', 'string'),
    blockedReason: str(b.blockedReason, 'blockedReason'),
  };
}

/** A retry-safe key from the Idempotency-Key header or an idempotency_key body field. */
function idempotencyKey(req: Request): string | undefined {
  const header = req.headers['idempotency-key'];
  if (typeof header === 'string') return header;
  return str(req.body?.idempotency_key, 'idempotency_key');
}

function nullableInt(value: unknown, field: string): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new OrcoError('invalid', `${field} must be a whole number`);
  return value;
}

function objectList<T>(value: unknown, field: string): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'object' || v === null)) throw new OrcoError('invalid', `${field} must be a list of objects`);
  return value as T[];
}

function taskResult(body: Record<string, unknown> | undefined): TaskResult {
  const links = objectList<{ url: unknown; title?: unknown }>(body?.links, 'links')?.map((l) => ({ url: str(l.url, 'links.url') ?? '', title: str(l.title, 'links.title') }));
  const followups = objectList<{ title: unknown; description?: unknown }>(body?.followups, 'followups')?.map((f) => ({
    title: str(f.title, 'followups.title') ?? '',
    description: str(f.description, 'followups.description'),
  }));
  return { links, followups };
}

function scheduleInput(body: Record<string, unknown> | undefined): Partial<ScheduleInput> & { enabled?: boolean } {
  const b = body ?? {};
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') throw new OrcoError('invalid', 'enabled must be true or false');
  return {
    room: str(b.room, 'room'),
    agent: str(b.agent, 'agent'),
    request: str(b.request, 'request'),
    cron: str(b.cron, 'cron'),
    tz: str(b.tz, 'tz'),
    budgetMinutes: nullableInt(b.budgetMinutes, 'budgetMinutes'),
    budgetCents: nullableInt(b.budgetCents, 'budgetCents'),
    enabled: b.enabled as boolean | undefined,
  };
}

function optionalInt(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new OrcoError('invalid', `Expected an integer, got ${String(value)}`);
  return n;
}

export interface AppOptions {
  presence?: Presence;
  publicUrl?: string;
  now?: () => number;
  /** While no one has an account: the code that lets the first person set up Orco in the browser. */
  setupCode?: string;
  /** The package file to hand to joining computers (default: ORCO_PACKAGE or a packed one); null for none. */
  packageFile?: string | null;
  /**
   * Sign-in through a proxy: the header in which a trusted proxy (ORCO_TRUST_PROXY, by address) passes
   * the signed-in login, and what to call that login on the sign-in page ("Google").
   */
  proxyAuth?: { header: string; label: string; secret: string };
  /** Sign-in with an OpenID Connect provider (ORCO_OIDC_*). */
  oidc?: Oidc;
}

/** Cookies are Secure on HTTPS, and whenever Orco's public address is HTTPS (a proxy may speak HTTP to it). */
export function secureCookies(req: Request, publicUrl?: string): boolean {
  return req.secure || (publicUrl ?? process.env.ORCO_PUBLIC_URL ?? '').startsWith('https://');
}

export function createApp(store: Store, options: AppOptions = {}) {
  const presence = options.presence ?? new Presence();
  const oauth = options.publicUrl ? new OAuth(store, options.publicUrl) : undefined;
  const logins = new RateLimiter(10, 15 * 60_000, options.now);
  const registrations = new RateLimiter(20, 3600_000, options.now);
  const pairings = new RateLimiter(20, 3600_000, options.now);
  const app = express();
  app.disable('x-powered-by');
  // Behind a proxy without ORCO_TRUST_PROXY, every request looks like it comes from the proxy: sign-in
  // limits are then shared by everyone, and cookies may lose their Secure flag. Say so once.
  let warnedProxy = false;
  app.use((req, _res, next) => {
    if (!warnedProxy && !app.get('trust proxy') && req.headers['x-forwarded-for']) {
      warnedProxy = true;
      console.warn(
        'Requests are arriving through a proxy (X-Forwarded-For), but ORCO_TRUST_PROXY is not set: sign-in limits apply to the proxy ' +
          'as a whole. Set ORCO_TRUST_PROXY to the number of proxies in front of Orco (like 1), or to loopback, uniquelocal or their addresses.',
      );
    }
    next();
  });
  const mcp = createMcpHandler(
    ({ requestInfo, authInfo }) => {
      // The authenticated participant, scope and all (a task token sees one project only).
      const participant = (authInfo?.extra?.participant as Participant | undefined) ?? null;
      if (!participant) throw new Error(`Unauthenticated MCP request to ${requestInfo?.url ?? 'unknown'}`);
      return buildMcpServer(store, presence, participant);
    },
    { maxRequestBodySize: 16 * 1024 * 1024 },
  );
  const mcpNode = toNodeHandler(mcp);
  /**
   * The login the sign-in proxy vouches for, or null. Only a request that came straight from a trusted
   * proxy counts; from anywhere else the header is whatever the client made up, and is ignored.
   */
  const proxyAuth = options.proxyAuth;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const proxySecret = proxyAuth ? digest(proxyAuth.secret) : null;
  const proxyIdentity = (req: Request): string | null => {
    if (!proxyAuth || !proxySecret || !app.get('trust proxy')) return null;
    // Requests with their own credentials (agents, the command line) never sign in through the proxy:
    // a proxy route that lets them skip its login may not strip the identity header either (#39).
    if (req.headers.authorization) return null;
    const trusted = app.get('trust proxy fn') as (address: string, hop: number) => boolean;
    if (!trusted(req.socket.remoteAddress ?? '', 0)) return null;
    // The address alone is not enough: anything else on that host or network could send the header.
    // The proxy also proves itself with a secret only it and Orco know (#38).
    const given = req.headers[PROXY_SECRET_HEADER];
    if (typeof given !== 'string' || !timingSafeEqual(digest(given), proxySecret)) return null;
    return normalizeIdentity(req.headers[proxyAuth.header.toLowerCase()]);
  };
  // A login an OpenID provider vouched for that is linked to nobody yet: kept briefly, for this browser
  // only, so signing in another way (and confirming) can link it.
  const oidc = options.oidc;
  const oidcPending = new Map<string, { identity: string; issuer: string; subject: string; expiresAt: number }>();
  const now = () => (options.now ?? Date.now)();
  const pendingEntry = (req: Request) => {
    const id = readCookie(req.headers.cookie, OIDC_PENDING_COOKIE);
    const entry = id ? oidcPending.get(id) : undefined;
    return entry && entry.expiresAt > now() ? entry : null;
  };
  const pendingLogin = (req: Request): string | null => pendingEntry(req)?.identity ?? null;
  /** The login this browser brings (the proxy's, or one an OpenID provider just vouched for), if any. */
  const vouchedLogin = (req: Request): { identity: string; label: string } | null => {
    const proxied = proxyIdentity(req);
    if (proxied && proxyAuth) return { identity: proxied, label: proxyAuth.label };
    const pending = pendingLogin(req);
    return pending && oidc ? { identity: pending, label: oidc.config.label } : null;
  };

  /**
   * Signing in another way (a token, a sign-in link) behind the proxy must agree with it. A login that
   * belongs to someone else is refused; one linked to nobody is linked to this person, but only when
   * the sign-in asked for that (the person confirmed it), so nobody is tied to an account by surprise.
   */
  const agreeWithProxy = (req: Request, person: Participant, link: boolean): void => {
    const vouched = vouchedLogin(req);
    if (!vouched) return;
    const { identity, label } = vouched;
    // Behind a proxy every sign-in must agree with it; a login an OpenID provider vouched for a moment
    // ago is only offered for linking, and never stands in the way of signing in.
    const binding = proxyIdentity(req) !== null;
    const owner = store.identities.userFor(identity);
    if (owner?.id === person.id) {
      // Their own login, added for them but never used with the provider: signing in themselves
      // confirms it, and ties it to the provider account that just vouched for it in this browser.
      const pending = binding ? null : pendingEntry(req);
      if (pending) {
        store.identities.bind(person, identity, { issuer: pending.issuer, subject: pending.subject });
        oidcPending.delete(readCookie(req.headers.cookie, OIDC_PENDING_COOKIE)!);
      }
      return;
    }
    if (owner) {
      if (binding) throw new OrcoError('forbidden', `${label} says you are ${identity}, which signs in as ${owner.name}, not ${person.name}`);
      return;
    }
    if (!link) {
      if (!binding) return;
      throw new OrcoError('conflict', `link needed: signing in as ${person.name} here links ${identity} to ${person.name}`);
    }
    const pending = binding ? null : pendingEntry(req);
    store.identities.link(person, person.name, identity, pending ? { account: { issuer: pending.issuer, subject: pending.subject } } : {});
    const pendingId = readCookie(req.headers.cookie, OIDC_PENDING_COOKIE);
    if (pendingId) oidcPending.delete(pendingId);
  };
  const auth = authenticate(store, presence, undefined, proxyIdentity);
  const mcpAuth = authenticate(store, presence, oauth);

  const withStatus = (viewer: Participant, people: (Participant & { owner: string | null })[]) => {
    const activity = store.tasks.activity(viewer);
    return people.map((p) => ({
      name: p.name,
      kind: p.kind,
      owner: p.owner,
      status: presence.status(p.id),
      working: activity.get(p.id) ?? null,
      profile: p.kind === 'agent' ? store.profileOf(p) : null,
    }));
  };

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // The same code anyone can get from the repository; served so a new computer needs only Node.
  const configuredPackage = options.packageFile === undefined ? process.env.ORCO_PACKAGE : options.packageFile;
  app.get(PACKAGE_PATH, (_req, res) => {
    const file = packageFile(configuredPackage);
    if (!file) {
      res.status(404).json({ error: 'This server has no Orco package to hand out; run npm pack in its folder, or install orco on this computer' });
      return;
    }
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(file);
  });

  if (oauth) {
    app.use((req, res, next) => {
      if (req.path.startsWith('/oauth/')) {
        res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
        res.setHeader('Referrer-Policy', 'same-origin');
      }
      next();
    });
    app.use(oauthRouter(store, oauth, logins, registrations));
  }

  app.all('/mcp', mcpAuth, (req, res) => {
    void mcpNode(req, res);
  });

  // First run: the first person sets Orco up in the browser with the code the server printed.
  app.get('/api/setup', (req, res) => {
    const identity = proxyIdentity(req);
    res.json({
      needed: store.onboarding.setupNeeded(),
      // Sign-in through a proxy: whether it is on, what to call it, and who the proxy says you are.
      ...(proxyAuth ? { proxy: { label: proxyAuth.label, identity, user: identity ? (store.identities.userFor(identity)?.name ?? null) : null } } : {}),
      // Sign-in with an OpenID provider, and a login it vouched for that is linked to nobody yet.
      ...(oidc ? { oidc: { label: oidc.config.label, pending: pendingLogin(req) } } : {}),
    });
  });

  // Sign-in with an OpenID Connect provider: off to the provider, then back with a code.
  app.get('/auth/oidc/start', async (_req, res) => {
    if (!oidc) throw new OrcoError('not_found', 'Sign-in with an OpenID provider is not set up on this Orco');
    const { url, cookie } = await oidc.start();
    res.cookie(OIDC_COOKIE, cookie, { httpOnly: true, sameSite: 'lax', secure: secureCookies(_req, options.publicUrl), path: '/auth/oidc', maxAge: 10 * 60_000 });
    res.redirect(302, url);
  });
  app.get('/auth/oidc/callback', async (req, res) => {
    if (!oidc) throw new OrcoError('not_found', 'Sign-in with an OpenID provider is not set up on this Orco');
    res.clearCookie(OIDC_COOKIE, { path: '/auth/oidc' });
    const ip = req.ip ?? 'unknown';
    try {
      if (logins.blocked(ip)) throw new OidcError('provider', 'Too many failed sign-ins. Wait 15 minutes and try again.', false);
      const { identity, issuer, subject } = await oidc.finish(req.query, readCookie(req.headers.cookie, OIDC_COOKIE));
      const user = store.identities.userFor(identity);
      const status = user ? store.identities.accountStatus(identity, issuer, subject) : 'unbound';
      if (status === 'mismatch') {
        throw new OidcError('account', `${identity} now belongs to a different ${oidc.config.label} account than the one linked to ${user!.name}`);
      }
      if (status === 'unbound') {
        // Known to the provider, not yet tied in Orco (unknown, or added but never used this way):
        // remember it briefly, so its person signing in another way can confirm it. The page says
        // the same either way, so it tells nobody whether an address was invited.
        for (const [key, entry] of oidcPending) if (entry.expiresAt <= now()) oidcPending.delete(key);
        if (oidcPending.size >= 1000) oidcPending.delete(oidcPending.keys().next().value!);
        const id = randomBytes(24).toString('base64url');
        oidcPending.set(id, { identity, issuer, subject, expiresAt: now() + 10 * 60_000 });
        res.cookie(OIDC_PENDING_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: secureCookies(req, options.publicUrl), path: '/', maxAge: 10 * 60_000 });
        res.redirect(302, '/#!signin=unlinked');
        return;
      }
      res.cookie(COOKIE, store.signins.startSession(user!), { httpOnly: true, sameSite: 'strict', secure: secureCookies(req, options.publicUrl), path: '/', maxAge: SESSION_TTL_MS });
      store.audit.record(user!, 'signin.oidc', { subject: `user:${user!.name}`, detail: { identity, issuer: oidc.config.issuer } });
      res.redirect(302, '/');
    } catch (err) {
      // Only a sign-in that really came back to this browser counts against it: stray callbacks
      // (no state, someone else's) cannot lock everyone behind a shared address out.
      const bound = err instanceof OidcError ? err.bound : true;
      if (bound) logins.hit(ip);
      const reason = err instanceof OidcError ? err.reason : 'provider';
      store.audit.record(null, 'signin.oidc_failed', { detail: { reason, error: (err as Error).message.slice(0, 200) } });
      // The page shows its own words for the reason: nothing the provider (or a crafted link) wrote.
      res.redirect(302, `/#!signin-error=${reason}`);
    }
  });
  app.post('/api/signin/proxy', express.json({ limit: '1kb' }), (req, res) => {
    const identity = proxyIdentity(req);
    if (!proxyAuth) throw new OrcoError('not_found', 'Sign-in through a proxy is not set up on this Orco');
    if (!identity) throw new OrcoError('forbidden', `${proxyAuth.label} did not say who you are; open Orco through its sign-in page`);
    const user = store.identities.userFor(identity);
    if (!user) throw new OrcoError('forbidden', `${identity} is not linked to anyone on this Orco yet. Ask an org admin to add you with it, or sign in another way once and link it.`);
    res.cookie(COOKIE, store.signins.startSession(user), { httpOnly: true, sameSite: 'strict', secure: secureCookies(req, options.publicUrl), path: '/', maxAge: SESSION_TTL_MS });
    store.audit.record(user, 'signin.proxy', { subject: `user:${user.name}`, detail: { identity } });
    res.json({ name: user.name });
  });
  app.post('/api/setup', express.json({ limit: '4kb' }), (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (logins.blocked(ip)) {
      res.status(429).json({ error: 'Too many tries. Wait 15 minutes and try again.' });
      return;
    }
    try {
      const { participant, token } = store.onboarding.setup(options.setupCode, String(req.body?.code ?? ''), String(req.body?.name ?? ''));
      // Set up through the sign-in proxy (or right after an OpenID sign-in): that login becomes this person's.
      const identity = vouchedLogin(req)?.identity;
      const pending = proxyIdentity(req) ? null : pendingEntry(req);
      if (identity) store.identities.link(participant, participant.name, identity, pending ? { account: { issuer: pending.issuer, subject: pending.subject } } : {});
      res.cookie(COOKIE, store.signins.startSession(participant), { httpOnly: true, sameSite: 'strict', secure: secureCookies(req, options.publicUrl), path: '/', maxAge: SESSION_TTL_MS });
      res.status(201).json({ name: participant.name, token });
    } catch (err) {
      if (err instanceof OrcoError && err.code === 'forbidden') logins.hit(ip);
      throw err;
    }
  });

  // A computer asks to join with `orco connect`; a person approves its code in the browser.
  app.post('/api/pair', express.json({ limit: '8kb' }), (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (pairings.blocked(ip)) {
      res.status(429).json({ error: 'Too many pairing requests from here. Wait a while and try again.' });
      return;
    }
    pairings.hit(ip);
    res.status(201).json(store.onboarding.start(req.body ?? {}, ip));
  });
  // The secret travels in the body, never the URL, so proxy access logs cannot leak it.
  app.post('/api/pair/:id/poll', express.json({ limit: '4kb' }), (req, res) => {
    res.json(store.onboarding.poll(String(req.params.id), String(req.body?.secret ?? '')));
  });

  app.post('/api/session', express.json({ limit: '4kb' }), (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (logins.blocked(ip)) {
      res.status(429).json({ error: 'Too many failed sign-ins. Wait 15 minutes and try again.' });
      return;
    }
    const token = String(req.body?.token ?? '');
    const participant = store.authenticate(token);
    if (!participant || participant.kind !== 'user') {
      logins.hit(ip);
      res.status(401).json({ error: 'That is not a valid user token' });
      return;
    }
    agreeWithProxy(req, participant, req.body?.link === true);
    // The browser gets a session of its own, not the token: rotating the token or signing out
    // everywhere then reaches it too.
    res.cookie(COOKIE, store.signins.startSession(participant), {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookies(req, options.publicUrl),
      path: '/',
      maxAge: SESSION_TTL_MS,
    });
    res.json({ name: participant.name });
  });

  // Opening a sign-in link: no token to handle, and the link works once.
  app.post('/api/signin', express.json({ limit: '4kb' }), (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (logins.blocked(ip)) {
      res.status(429).json({ error: 'Too many failed sign-ins. Wait 15 minutes and try again.' });
      return;
    }
    let used: ReturnType<typeof store.signins.use>;
    try {
      // Check against the proxy before the link is spent, so a refusal leaves it usable.
      const person = store.participantByName(store.signins.peek(String(req.body?.code ?? '')).name)!;
      agreeWithProxy(req, person, req.body?.link === true);
      used = store.signins.use(String(req.body?.code ?? ''));
    } catch (err) {
      logins.hit(ip);
      throw err;
    }
    res.cookie(COOKIE, used.session, { httpOnly: true, sameSite: 'strict', secure: secureCookies(req, options.publicUrl), path: '/', maxAge: SESSION_TTL_MS });
    res.json({ name: used.participant.name, firstTime: used.firstTime });
  });

  // Sign out everywhere: every browser session of yours, and any sign-in link not yet used.
  app.post('/api/signin/peek', express.json({ limit: '4kb' }), (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (logins.blocked(ip)) {
      res.status(429).json({ error: 'Too many failed sign-ins. Wait 15 minutes and try again.' });
      return;
    }
    try {
      res.json(store.signins.peek(String(req.body?.code ?? '')));
    } catch (err) {
      logins.hit(ip);
      throw err;
    }
  });

  app.delete('/api/sessions', auth, rejectCrossSite, (req, res) => {
    const me = req.participant!;
    if (me.kind !== 'user' || me.scope) throw new OrcoError('forbidden', 'Only people have browser sessions');
    const ended = store.signins.endAll(me.id);
    store.audit.record(me, 'session.end_all', { subject: `user:${me.name}`, detail: { ended } });
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ended });
  });

  app.delete('/api/session', (req, res) => {
    const token = readCookie(req.headers.cookie, COOKIE);
    if (token && store.signins.isSession(token)) store.signins.end(token);
    res.clearCookie(COOKIE, { path: '/' });
    res.status(204).end();
  });

  // The REST half of the choke point: what an agent sends is stored with leased secrets hidden.
  // Every authenticated JSON body goes through jsonBody (test/http-routes.test.ts checks).
  const maskBody = (req: Request, _res: Response, next: NextFunction) => {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) req.body = store.maskInput(req.participant!, req.body);
    next();
  };
  const jsonBody = (limit: string) => [express.json({ limit }), maskBody];
  const api = express.Router();
  api.use(auth, ...jsonBody('64kb'), rejectCrossSite);

  api.get('/me', (req, res) => {
    const me = req.participant!;
    res.json({
      name: me.name,
      kind: me.kind,
      owner: store.ownerName(me),
      orgAdmin: store.isOrgAdmin(me),
      onyx: store.onyx.enabled,
      ...(me.kind === 'user' && !me.scope ? { logins: store.identities.of(me.id) } : {}),
    });
  });
  api.delete('/me/logins', (req, res) => {
    store.identities.unlink(req.participant!, req.participant!.name, String(req.body?.login ?? ''));
    res.status(204).end();
  });
  // Org admins remove someone's login (removing never lets anyone in; adding stays with the server).
  api.delete('/users/:name/logins', (req, res) => {
    store.identities.unlink(req.participant!, String(req.params.name), String(req.body?.login ?? ''));
    res.status(204).end();
  });
  api.get('/participants', (req, res) => {
    const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined;
    res.json(withStatus(req.participant!, store.members(req.participant!, project)));
  });
  api.get('/client', (_req, res) => {
    res.json({ version: VERSION, package: packageFile(configuredPackage) ? PACKAGE_PATH : null });
  });
  api.get('/getting-started', (req, res) => {
    res.json(store.onboarding.steps(req.participant!, (id) => presence.status(id) !== 'offline'));
  });
  api.get('/pair/code/:code', (req, res) => {
    res.json(store.onboarding.view(req.participant!, String(req.params.code), req.ip));
  });
  api.post('/pair/code/:code', (req, res) => {
    const b = req.body ?? {};
    if (b.decision === 'deny') {
      store.onboarding.deny(req.participant!, String(req.params.code));
      res.status(204).end();
      return;
    }
    res.json(store.onboarding.approve(req.participant!, String(req.params.code), Array.isArray(b.agents) ? b.agents : []));
  });
  // People add their own agents, and org admins add people, from the browser. Tokens are shown once.
  // Agents that run on Orco itself, and the model providers they run on (see hosted.ts).
  api.get('/models', (req, res) => {
    res.json({ providers: store.hosted.providers(req.participant!), templates: TEMPLATES, secrets: store.secrets.enabled });
  });
  api.post('/models', (req, res) => {
    const b = req.body ?? {};
    const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));
    res.status(201).json(
      store.hosted.saveProvider(req.participant!, {
        name: String(b.name ?? ''),
        baseUrl: String(b.base_url ?? ''),
        model: String(b.model ?? ''),
        apiKey: typeof b.api_key === 'string' ? b.api_key : undefined,
        priceIn: num(b.price_in),
        priceOut: num(b.price_out),
        shared: b.shared === true,
      }),
    );
  });
  // Onyx knowledge search: one server, connected by an org admin (see onyx.ts).
  api.get('/onyx', (req, res) => {
    res.json({ settings: store.onyx.settings(req.participant!), secrets: store.secrets.enabled });
  });
  api.post('/onyx', (req, res) => {
    const b = req.body ?? {};
    res.json(
      store.onyx.save(req.participant!, {
        baseUrl: String(b.base_url ?? ''),
        apiKey: typeof b.api_key === 'string' ? b.api_key : undefined,
        persona: b.persona === undefined || b.persona === null || b.persona === '' ? null : Number(b.persona),
        documentSets: b.document_sets,
        sources: b.sources,
        brief: typeof b.brief === 'boolean' ? b.brief : undefined,
      }),
    );
  });
  api.delete('/onyx', (req, res) => {
    store.onyx.remove(req.participant!);
    res.status(204).end();
  });
  api.get('/onyx/search', async (req, res) => {
    const sources = typeof req.query.sources === 'string' && req.query.sources ? req.query.sources.split(',') : undefined;
    res.json(await store.onyx.search(req.participant!, String(req.query.q ?? ''), { limit: optionalInt(req.query.limit), sources }));
  });
  api.delete('/models/:name', (req, res) => {
    store.hosted.removeProvider(req.participant!, String(req.params.name));
    res.status(204).end();
  });
  api.post('/agents/:name/hosted', (req, res) => {
    const b = req.body ?? {};
    res.json(
      store.hosted.update(req.participant!, String(req.params.name), {
        provider: b.model === undefined ? undefined : String(b.model),
        template: b.template === undefined ? undefined : String(b.template),
        instructions: b.instructions === undefined ? undefined : String(b.instructions),
        projects: b.projects,
      }),
    );
  });
  api.delete('/agents/:name/hosted', (req, res) => {
    store.hosted.remove(req.participant!, String(req.params.name));
    res.status(204).end();
  });
  api.post('/agents/:name/try', async (req, res) => {
    res.json(await store.hosted.tryIt(req.participant!, String(req.params.name), String(req.body?.message ?? '')));
  });
  api.post('/agents', (req, res) => {
    const me = req.participant!;
    if (me.kind !== 'user' || me.scope) throw new OrcoError('forbidden', 'Only people add agents');
    // "Runs on Orco": made with a model provider and a template, and started by the hosted runner.
    if (req.body?.hosted) {
      const h = req.body.hosted;
      const budget = h.budget_cents === undefined ? undefined : h.budget_cents === null ? null : Number(h.budget_cents);
      res.status(201).json(
        store.hosted.create(me, {
          name: String(req.body.name ?? ''),
          provider: String(h.model ?? ''),
          template: String(h.template ?? ''),
          instructions: h.instructions === undefined ? undefined : String(h.instructions),
          projects: h.projects,
          policy: h.policy,
          budgetCents: budget,
        }),
      );
      return;
    }
    const { participant, token } = store.createAgent(me.name, String(req.body?.name ?? '').trim().toLowerCase());
    res.status(201).json({ name: participant.name, token });
  });
  api.post('/agents/:name/token', (req, res) => {
    const me = req.participant!;
    const agent = store.participantByName(String(req.params.name));
    if (me.kind !== 'user' || me.scope || !agent || agent.kind !== 'agent' || agent.ownerId !== me.id) throw new OrcoError('not_found', 'You have no agent by that name');
    res.json({ name: agent.name, token: store.rotateToken(agent.name) });
  });
  api.post('/users', (req, res) => {
    const me = req.participant!;
    if (!store.isOrgAdmin(me)) throw new OrcoError('forbidden', 'Only org admins add people');
    // Check the email before making anyone, so a bad or taken one leaves nothing half done.
    if (req.body?.email) {
      const email = normalizeIdentity(req.body.email);
      if (!email) throw new OrcoError('invalid', 'That is not a valid email or login');
      const taken = store.identities.userFor(email);
      if (taken) throw new OrcoError('conflict', `${email} already signs in as ${taken.name}`);
    }
    const { participant, token } = store.createUser(String(req.body?.name ?? '').trim().toLowerCase(), { orgAdmin: req.body?.admin === true });
    const link = store.signins.createLink(me, participant.name, { invite: true });
    // With a sign-in proxy, an email given here signs them in through it; no link needed.
    if (req.body?.email) store.identities.link(me, participant.name, String(req.body.email), { invite: true });
    res.status(201).json({ name: participant.name, token, orgAdmin: store.isOrgAdmin(participant), signin: link });
  });
  api.post('/signin-links', (req, res) => {
    res.status(201).json(store.signins.createLink(req.participant!, req.participant!.name));
  });
  api.get('/projects', (req, res) => {
    res.json(store.listProjects(req.participant!));
  });
  api.post('/projects', (req, res) => {
    res.status(201).json(store.createProject(req.participant!, String(req.body?.name ?? '')));
  });
  api.post('/projects/:project/members', (req, res) => {
    const role = req.body?.role === undefined ? 'member' : req.body.role;
    store.addMember(req.participant!, String(req.params.project), String(req.body?.user ?? ''), role);
    res.status(204).end();
  });
  api.delete('/projects/:project/members/:user', (req, res) => {
    store.removeMember(req.participant!, String(req.params.project), String(req.params.user));
    res.status(204).end();
  });
  api.get('/projects/:project/access', (req, res) => {
    res.json(store.access(req.participant!, String(req.params.project)));
  });
  api.post('/projects/:project/groups', (req, res) => {
    const role = req.body?.role === null ? null : (req.body?.role ?? 'member');
    res.json(store.groups.setProjectRole(req.participant!, String(req.params.project), String(req.body?.group ?? ''), role));
  });
  api.get('/groups', (req, res) => {
    res.json(store.groups.list(req.participant!));
  });
  api.post('/groups', (req, res) => {
    const members = Array.isArray(req.body?.members) ? req.body.members.map(String) : [];
    res.status(201).json(store.groups.create(req.participant!, String(req.body?.name ?? ''), members));
  });
  api.delete('/groups/:name', (req, res) => {
    store.groups.remove(req.participant!, String(req.params.name));
    res.status(204).end();
  });
  api.post('/groups/:name/members', (req, res) => {
    res.json(store.groups.addMember(req.participant!, String(req.params.name), String(req.body?.user ?? '')));
  });
  api.delete('/groups/:name/members/:user', (req, res) => {
    res.json(store.groups.removeMember(req.participant!, String(req.params.name), String(req.params.user)));
  });
  api.get('/rooms', (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : undefined;
    res.json(store.listRooms(req.participant!, project));
  });
  api.post('/projects/:project/rooms', (req, res) => {
    res.status(201).json(store.createRoom(req.participant!, String(req.params.project), String(req.body?.name ?? '')));
  });
  api.get('/messages', (req, res) => {
    const me = req.participant!;
    const threadId = optionalInt(req.query.thread_id);
    const messages = store.read(me, String(req.query.room ?? ''), {
      sinceId: optionalInt(req.query.since_id),
      beforeId: optionalInt(req.query.before_id),
      threadId,
      limit: optionalInt(req.query.limit),
      topLevel: req.query.top_level === '1',
    });
    // Opening a thread counts as seeing the questions in it (and, for an agent, its tasks there).
    if (threadId !== undefined && req.headers['x-orco-bridge'] !== '1') {
      store.questions.markThreadSeen(me, threadId);
      store.tasks.markSeen(me, messages.filter((m) => m.task?.assignee === me.name).map((m) => m.task!.id));
    }
    res.json(messages);
  });
  api.post('/messages', (req, res) => {
    const { room, text, thread_id, attachment_ids, external } = req.body ?? {};
    const ids = Array.isArray(attachment_ids) ? attachment_ids.map((id: unknown) => optionalInt(id) ?? NaN) : [];
    if (ids.some((id) => Number.isNaN(id))) throw new OrcoError('invalid', 'attachment_ids must be integers');
    if (external !== undefined && (typeof external !== 'object' || external === null)) throw new OrcoError('invalid', 'external must be { source, text }');
    const relayed = external ? { source: str(external.source, 'external.source') ?? '', text: str(external.text, 'external.text') ?? '' } : undefined;
    const key = idempotencyKey(req);
    res.status(201).json(
      store.once(req.participant!, key, 'message', (id) => store.message(id), () => {
        const message = store.post(req.participant!, String(room ?? ''), String(text ?? ''), optionalInt(thread_id), { attachmentIds: ids, external: relayed });
        return { id: message.id, result: message };
      }),
    );
  });
  api.get('/attachments/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected an attachment id');
    const image = store.attachments.get(req.participant!, id);
    res.set({
      'Content-Type': image.mime === 'text/plain' ? 'text/plain; charset=utf-8' : image.mime,
      'Content-Length': String(image.size),
      'Content-Disposition': `inline; filename="${image.name.replace(/"/g, '')}"`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: `"${image.sha256}"`,
    });
    res.send(image.data);
  });

  api.post('/tasks/:id/questions', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    const to = str(req.body?.to, 'to') as QuestionTarget | undefined;
    res.status(201).json(store.questions.ask(req.participant!, id, str(req.body?.question, 'question') ?? '', to));
  });
  api.get('/questions', (req, res) => {
    res.json(store.questions.waitingOn(req.participant!));
  });
  api.get('/questions/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a question id');
    res.json(store.questions.get(req.participant!, id));
  });
  api.post('/questions/:id/answer', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a question id');
    res.json(store.questions.answer(req.participant!, id, str(req.body?.answer, 'answer') ?? ''));
  });
  api.post('/questions/:id/resume', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a question id');
    res.json({ resumed: store.questions.claimResume(req.participant!, id) });
  });

  api.get('/projects/:project/notes', (req, res) => {
    res.json(store.notes.list(req.participant!, String(req.params.project)));
  });
  api.post('/projects/:project/notes', (req, res) => {
    const id = req.body?.id === undefined || req.body?.id === null ? undefined : optionalInt(req.body.id);
    res.json(
      store.notes.save(req.participant!, String(req.params.project), { id, title: str(req.body?.title, 'title') ?? '', body: str(req.body?.body, 'body') ?? '' }),
    );
  });
  api.delete('/projects/:project/notes/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a note id');
    store.notes.delete(req.participant!, String(req.params.project), id);
    res.status(204).end();
  });
  api.post('/tasks/:id/progress', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    const percent = req.body?.percent === undefined || req.body?.percent === null ? null : optionalInt(req.body.percent);
    res.json(
      store.tasks.reportProgress(req.participant!, id, str(req.body?.text, 'text') ?? '', percent, {
        costCents: nullableInt(req.body?.spent_cents, 'spent_cents'),
        tokens: nullableInt(req.body?.tokens, 'tokens'),
      }),
    );
  });
  api.post('/tasks/:id/token', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    res.status(201).json(store.tasks.issueToken(req.participant!, id, nullableInt(req.body?.ttl_seconds, 'ttl_seconds') ?? undefined));
  });
  api.post('/tasks/:id/checkpoint', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    res.json(store.tasks.checkpoint(req.participant!, id, str(req.body?.text, 'text') ?? ''));
  });
  api.post('/tasks/:id/feedback', (req, res) => {
    const id = optionalInt(req.params.id);
    const rating = req.body?.rating;
    if (id === undefined || (rating !== 'up' && rating !== 'down')) throw new OrcoError('invalid', 'Expected a task id and rating "up" or "down"');
    res.json(store.tasks.rate(req.participant!, id, rating, str(req.body?.note, 'note')));
  });
  api.get('/feedback', (req, res) => {
    res.json(store.tasks.feedbackFor(req.participant!, typeof req.query.agent === 'string' ? req.query.agent : undefined, optionalInt(req.query.limit)));
  });
  api.post('/tasks/:id/reminders', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    const inMinutes = nullableInt(req.body?.in_minutes, 'in_minutes') ?? undefined;
    res.status(201).json(store.reminders.create(req.participant!, id, { inMinutes, at: str(req.body?.at, 'at') }, str(req.body?.note, 'note') ?? ''));
  });
  api.get('/reminders', (req, res) => {
    res.json(store.reminders.pendingFor(req.participant!));
  });
  api.delete('/reminders/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a reminder id');
    store.reminders.cancel(req.participant!, id);
    res.status(204).end();
  });
  api.get('/catch-up', (req, res) => {
    const room = typeof req.query.room === 'string' && req.query.room ? req.query.room : undefined;
    res.json(catchUp(store, req.participant!, { room, perRoom: optionalInt(req.query.per_room) }));
  });
  api.get('/hooks', (req, res) => {
    const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined;
    res.json(store.hooks.list(req.participant!, project));
  });
  api.post('/hooks', (req, res) => {
    const b = req.body ?? {};
    const { hook, token } = store.hooks.create(req.participant!, {
      room: str(b.room, 'room') ?? '',
      name: str(b.name, 'name') ?? '',
      wakeAgent: nullableStr(b.wakeAgent, 'wakeAgent'),
      wakeMatch: str(b.wakeMatch, 'wakeMatch'),
      confirmTasks: b.confirmTasks !== false,
    });
    res.status(201).json({ hook, token, path: `/hooks/${token}` });
  });
  api.delete('/hooks/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a hook id');
    store.hooks.delete(req.participant!, id);
    res.status(204).end();
  });
  api.get('/projects/:project/files', (req, res) => {
    res.json(store.files.list(req.participant!, String(req.params.project), typeof req.query.prefix === 'string' ? req.query.prefix : ''));
  });
  api.get('/projects/:project/file', (req, res) => {
    const project = String(req.params.project);
    const path = String(req.query.path ?? '');
    if (req.query.history === '1') {
      res.json(store.files.history(req.participant!, project, path));
      return;
    }
    res.json(store.files.read(req.participant!, project, path, optionalInt(req.query.version)));
  });
  api.delete('/projects/:project/file', (req, res) => {
    store.files.delete(req.participant!, String(req.params.project), String(req.query.path ?? ''));
    res.status(204).end();
  });
  api.get('/projects/:project/secrets', (req, res) => {
    res.json({ enabled: store.secrets.enabled, secrets: store.secrets.enabled ? store.secrets.list(req.participant!, String(req.params.project)) : [] });
  });
  api.post('/projects/:project/secrets', (req, res) => {
    const b = req.body ?? {};
    res.status(201).json(store.secrets.set(req.participant!, String(req.params.project), str(b.name, 'name') ?? '', str(b.value, 'value') ?? '', str(b.description, 'description')));
  });
  api.delete('/projects/:project/secrets/:name', (req, res) => {
    store.secrets.delete(req.participant!, String(req.params.project), String(req.params.name));
    res.status(204).end();
  });
  api.post('/tasks/:id/secrets', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    res.status(201).json(store.secrets.request(req.participant!, id, str(req.body?.name, 'name') ?? '', str(req.body?.reason, 'reason') ?? ''));
  });
  api.get('/leases', (req, res) => {
    const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined;
    res.json(store.secrets.leasesFor(req.participant!, project));
  });
  api.post('/leases/:id/use', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a lease id');
    res.set('Cache-Control', 'no-store');
    res.json(store.secrets.reveal(req.participant!, id));
  });
  api.post('/leases/:id/revoke', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a lease id');
    res.json(store.secrets.revoke(req.participant!, id));
  });
  api.get('/memory', (req, res) => {
    res.json(store.memory.list(req.participant!));
  });
  api.post('/memory', (req, res) => {
    res.json(store.memory.save(req.participant!, { title: str(req.body?.title, 'title') ?? '', body: str(req.body?.body, 'body') ?? '' }));
  });
  api.delete('/memory/:id', (req, res) => {
    store.memory.forget(req.participant!, { id: optionalInt(req.params.id) });
    res.status(204).end();
  });
  api.get('/agents/:name/memory', (req, res) => {
    res.json(store.memory.list(req.participant!, String(req.params.name)));
  });
  api.delete('/agents/:name/memory/:id', (req, res) => {
    store.memory.forget(req.participant!, { id: optionalInt(req.params.id) }, String(req.params.name));
    res.status(204).end();
  });
  api.get('/suggestions', (req, res) => {
    res.json(store.suggestions.pendingFor(req.participant!));
  });
  api.post('/suggestions/:id/accept', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a suggestion id');
    res.json(store.suggestions.accept(req.participant!, id, { title: str(req.body?.title, 'title'), description: str(req.body?.description, 'description') }));
  });
  api.post('/suggestions/:id/dismiss', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a suggestion id');
    res.json(store.suggestions.dismiss(req.participant!, id));
  });
  api.get('/reviews', (req, res) => {
    res.json(store.reviews.pendingFor(req.participant!));
  });
  api.get('/reviews/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a review id');
    res.json(store.reviews.get(req.participant!, id));
  });
  api.post('/reviews', (req, res) => {
    const b = req.body ?? {};
    res.status(201).json(
      store.reviews.request(req.participant!, {
        reviewer: str(b.reviewer, 'reviewer') ?? '',
        ticket: str(b.ticket, 'ticket'),
        taskId: nullableInt(b.task_id, 'task_id') ?? undefined,
        summary: str(b.summary, 'summary') ?? '',
      }),
    );
  });
  api.post('/reviews/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    const verdict = req.body?.verdict;
    if (id === undefined || (verdict !== 'approved' && verdict !== 'changes_requested')) {
      throw new OrcoError('invalid', 'Expected a review id and verdict "approved" or "changes_requested"');
    }
    res.json(store.reviews.submit(req.participant!, id, verdict, str(req.body?.note, 'note')));
  });
  api.post('/reviews/:id/withdraw', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a review id');
    res.json(store.reviews.withdraw(req.participant!, id));
  });
  api.get('/schedules', (req, res) => {
    const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined;
    res.json(store.schedules.list(req.participant!, project));
  });
  api.post('/schedules', (req, res) => {
    const input = scheduleInput(req.body);
    res.status(201).json(
      store.schedules.create(req.participant!, {
        ...input,
        room: input.room ?? '',
        agent: input.agent ?? '',
        request: input.request ?? '',
        cron: input.cron ?? '',
      }),
    );
  });
  api.post('/schedules/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a schedule id');
    res.json(store.schedules.update(req.participant!, id, scheduleInput(req.body)));
  });
  api.delete('/schedules/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a schedule id');
    store.schedules.delete(req.participant!, id);
    res.status(204).end();
  });
  api.post('/tasks/:id/reassign', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    res.json(store.tasks.reassign(req.participant!, id, str(req.body?.agent, 'agent') ?? '', str(req.body?.note, 'note')));
  });
  api.get('/tasks/:id/trail', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    res.json(store.audit.trailForTask(req.participant!, id));
  });
  api.post('/tasks/:id/plans', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    const to = str(req.body?.to, 'to') as 'owner' | 'requester' | undefined;
    res.status(201).json(store.questions.proposePlan(req.participant!, id, str(req.body?.plan, 'plan') ?? '', to));
  });
  api.post('/questions/:id/decide', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a question id');
    if (typeof req.body?.approve !== 'boolean') throw new OrcoError('invalid', 'approve must be true or false');
    res.json(store.questions.decidePlan(req.participant!, id, { approve: req.body.approve, plan: str(req.body?.plan, 'plan'), note: str(req.body?.note, 'note') }));
  });
  api.post('/flags', (req, res) => {
    const messageId = req.body?.message_id === undefined ? undefined : optionalInt(req.body.message_id);
    res.status(201).json(store.flags.flag(req.participant!, { messageId, ticket: str(req.body?.ticket, 'ticket') }, str(req.body?.reason, 'reason') ?? ''));
  });
  api.post('/flags/:id/dismiss', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a flag id');
    store.flags.dismiss(req.participant!, id);
    res.status(204).end();
  });
  api.get('/agents/find', (req, res) => {
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    res.json(store.findAgents(req.participant!, { skill: text(req.query.skill), project: text(req.query.project) }));
  });
  api.post('/agents/:name/profile', (req, res) => {
    const skills = req.body?.skills;
    if (skills !== undefined && (!Array.isArray(skills) || skills.some((s: unknown) => typeof s !== 'string'))) {
      throw new OrcoError('invalid', 'skills must be a list of strings');
    }
    res.json(store.setProfile(req.participant!, String(req.params.name), { skills, environment: str(req.body?.environment, 'environment') }));
  });
  api.get('/threads/:id/summary', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a thread id');
    store.read(req.participant!, String(req.query.room ?? ''), { threadId: id, limit: 1 });
    res.json(store.threadSummary(id));
  });
  api.post('/threads/:id/summary', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a thread id');
    res.json(store.setThreadSummary(req.participant!, str(req.body?.room, 'room') ?? '', id, str(req.body?.summary, 'summary') ?? ''));
  });

  api.get('/tickets', (req, res) => {
    const q = req.query;
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    const cycle = q.cycle === 'current' ? 'current' : optionalInt(q.cycle);
    const filter: TicketFilter = {
      project: text(q.project),
      status: text(q.status),
      categories: text(q.category)?.split(',') as StatusCategory[] | undefined,
      open: q.open === '1',
      assignee: text(q.assignee),
      label: text(q.label),
      milestone: text(q.milestone),
      cycle,
      priority: text(q.priority) as Priority | undefined,
      parent: text(q.parent),
      blocked: q.blocked === '1' ? true : q.blocked === '0' ? false : undefined,
      query: text(q.q),
      limit: optionalInt(q.limit),
    };
    res.json(store.tickets.list(req.participant!, filter));
  });
  api.post('/projects/:project/tickets', (req, res) => {
    const input = ticketInput(req.body);
    res.status(201).json(store.tickets.create(req.participant!, String(req.params.project), { ...input, title: input.title ?? '' }));
  });
  api.get('/tickets/:ref', (req, res) => {
    res.json(store.tickets.get(req.participant!, String(req.params.ref), optionalInt(req.query.since)));
  });
  api.post('/tickets/:ref', (req, res) => {
    res.json(store.tickets.update(req.participant!, String(req.params.ref), ticketInput(req.body)));
  });
  api.post('/tickets/:ref/comments', (req, res) => {
    res.status(201).json(store.tickets.comment(req.participant!, String(req.params.ref), str(req.body?.text, 'text') ?? ''));
  });
  api.post('/tickets/:ref/claim', (req, res) => {
    res.json(store.tickets.claim(req.participant!, String(req.params.ref), { start: req.body?.start !== false }));
  });
  api.post('/tickets/:ref/start', (req, res) => {
    res.json(store.tickets.startTask(req.participant!, String(req.params.ref)));
  });
  api.get('/projects/:project/plan', (req, res) => {
    res.json(store.tickets.plan(req.participant!, String(req.params.project)));
  });
  api.post('/projects/:project/statuses', (req, res) => {
    const { name, category, position } = req.body ?? {};
    res.status(201).json(
      store.tickets.addStatus(req.participant!, String(req.params.project), {
        name: str(name, 'name') ?? '',
        category: str(category, 'category') as StatusCategory,
        position: optionalInt(position),
      }),
    );
  });
  api.post('/projects/:project/statuses/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a status id');
    const { name, category, position } = req.body ?? {};
    res.json(
      store.tickets.updateStatus(req.participant!, String(req.params.project), id, {
        name: str(name, 'name'),
        category: str(category, 'category') as StatusCategory | undefined,
        position: optionalInt(position),
      }),
    );
  });
  api.delete('/projects/:project/statuses/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    const moveTo = optionalInt(req.query.move_to);
    if (id === undefined || moveTo === undefined) throw new OrcoError('invalid', 'Expected a status id and move_to');
    res.json(store.tickets.removeStatus(req.participant!, String(req.params.project), id, moveTo));
  });
  api.post('/projects/:project/labels', (req, res) => {
    res.status(201).json(store.tickets.createLabel(req.participant!, String(req.params.project), str(req.body?.name, 'name') ?? '', str(req.body?.color, 'color')));
  });
  api.delete('/projects/:project/labels/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a label id');
    store.tickets.deleteLabel(req.participant!, String(req.params.project), id);
    res.status(204).end();
  });
  api.post('/projects/:project/milestones', (req, res) => {
    const { name, description, targetDate } = req.body ?? {};
    res.status(201).json(
      store.tickets.createMilestone(req.participant!, String(req.params.project), {
        name: str(name, 'name') ?? '',
        description: str(description, 'description'),
        targetDate: nullableStr(targetDate, 'targetDate'),
      }),
    );
  });
  api.post('/projects/:project/milestones/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a milestone id');
    const { name, description, targetDate } = req.body ?? {};
    res.json(
      store.tickets.updateMilestone(req.participant!, String(req.params.project), id, {
        name: str(name, 'name'),
        description: str(description, 'description'),
        targetDate: nullableStr(targetDate, 'targetDate'),
      }),
    );
  });
  api.delete('/projects/:project/milestones/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a milestone id');
    store.tickets.deleteMilestone(req.participant!, String(req.params.project), id);
    res.status(204).end();
  });
  api.post('/projects/:project/cycles', (req, res) => {
    res.status(201).json(
      store.tickets.createCycle(req.participant!, String(req.params.project), {
        startsOn: str(req.body?.startsOn, 'startsOn'),
        endsOn: str(req.body?.endsOn, 'endsOn'),
      }),
    );
  });
  api.post('/projects/:project/cycles/:id/complete', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a cycle id');
    res.json(store.tickets.completeCycle(req.participant!, String(req.params.project), id));
  });

  api.get('/tasks', (req, res) => {
    const room = typeof req.query.room === 'string' && req.query.room ? req.query.room : undefined;
    res.json(
      store.tasks.list(req.participant!, {
        room,
        requestedByMe: req.query.mine === '1',
        assignedToMe: req.query.assigned === '1',
        open: req.query.open === '1',
        limit: optionalInt(req.query.limit),
      }),
    );
  });
  api.get('/tasks/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    const task = store.tasks.get(req.participant!, id);
    if (task.assignee === req.participant!.name && req.headers['x-orco-bridge'] !== '1') store.tasks.markSeen(req.participant!, [id]);
    // For the assignee's bridge: how many of the latest runs in a row ran out of usage. Kept here, not
    // in the bridge, so a restart does not reset the retry limit.
    if (task.assignee === req.participant!.name) {
      const outcomes = store.db.prepare('SELECT outcome FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT 50').all(id) as { outcome: string }[];
      const streak = outcomes.findIndex((r) => !r.outcome.startsWith('out of usage'));
      res.json({ ...task, usageLimitRuns: streak === -1 ? outcomes.length : streak });
      return;
    }
    res.json(task);
  });
  api.post('/tasks', (req, res) => {
    const { agent, room, request } = req.body ?? {};
    const me = req.participant!;
    const budgetMinutes = nullableInt(req.body?.budget_minutes, 'budget_minutes');
    const budgetCents = nullableInt(req.body?.budget_cents, 'budget_cents');
    res.status(201).json(
      store.once(me, idempotencyKey(req), 'task', (id) => store.tasks.get(me, id), () => {
        const task = store.tasks.create(me, { agent: String(agent ?? ''), room: String(room ?? ''), request: String(request ?? ''), budgetMinutes, budgetCents });
        return { id: task.id, result: task };
      }),
    );
  });
  api.get('/tasks/:id/runs', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    res.json(store.runs.list(req.participant!, id));
  });
  api.get('/runs/:id/log', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a run id');
    const { run, log } = store.runs.log(req.participant!, id);
    if (req.query.format === 'json') {
      res.json({ ...run, log });
      return;
    }
    // Agent output is untrusted: plain text, never rendered.
    res.set('Content-Type', 'text/plain; charset=utf-8').set('X-Content-Type-Options', 'nosniff').send(log);
  });
  api.get('/policy', (req, res) => {
    const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : null;
    res.json(store.policies.view(req.participant!, project));
  });
  api.post('/policy', (req, res) => {
    const b = req.body ?? {};
    const project = typeof b.project === 'string' && b.project ? b.project : null;
    res.json(store.policies.set(req.participant!, project, b.policy === null ? null : parsePolicy(b.policy ?? {})));
  });
  // What an agent should know before starting a task: the project's rules and the decisions in force.
  api.get('/tasks/:id/context', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    const task = store.tasks.get(req.participant!, id);
    res.json({ policy: store.policies.rulesFor(task.projectId), decisions: store.decisions.relevantFor(task.projectId, 10) });
  });
  api.get('/decisions', (req, res) => {
    const q = req.query;
    res.json(
      store.decisions.list(req.participant!, {
        project: typeof q.project === 'string' && q.project ? q.project : undefined,
        query: typeof q.q === 'string' ? q.q : undefined,
        tag: typeof q.tag === 'string' && q.tag ? q.tag : undefined,
        all: q.all === '1',
        limit: optionalInt(q.limit),
      }),
    );
  });
  api.post('/decisions', (req, res) => {
    const b = req.body ?? {};
    const input = { project: typeof b.project === 'string' && b.project ? b.project : null, title: b.title, context: b.context, options: b.options, decision: b.decision, tags: b.tags };
    res.status(201).json(store.decisions.record(req.participant!, input, optionalInt(b.supersedes)));
  });
  api.get('/decisions/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a decision id');
    res.json(store.decisions.get(req.participant!, id));
  });
  api.get('/portfolio', (req, res) => {
    res.json(store.portfolios.overview(req.participant!));
  });
  api.get('/roadmap', (req, res) => {
    res.json(store.portfolios.roadmap(req.participant!));
  });
  api.get('/digests', (req, res) => {
    res.json(store.portfolios.digests(req.participant!, optionalInt(req.query.limit) ?? 20));
  });
  // This week's digest so far, without waiting for Monday: one project's, or the roll-up for org admins.
  api.get('/digests/preview', (req, res) => {
    const me = req.participant!;
    const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : null;
    if (project === null) {
      if (!store.isOrgAdmin(me)) throw new OrcoError('forbidden', 'Only org admins get the all-projects digest; name a project');
      res.json({ body: store.portfolios.orgDigest(me) });
      return;
    }
    const target = store.portfolios.projects(me).find((p) => p.name === project);
    if (!target) throw new OrcoError('not_found', `No project ${project}`);
    res.json({ body: store.portfolios.projectDigest(target.id) });
  });
  api.get('/controls', (req, res) => {
    res.json({ budgets: store.controls.budgets(req.participant!), pauses: store.controls.pauses(req.participant!) });
  });
  api.post('/budgets', (req, res) => {
    const b = req.body ?? {};
    const cents = b.monthly_cents === null ? null : optionalInt(b.monthly_cents);
    if (cents === undefined) throw new OrcoError('invalid', 'monthly_cents is a whole number of cents, or null to remove the budget');
    res.json(store.controls.setBudget(req.participant!, b.scope, String(b.target ?? ''), cents));
  });
  api.post('/pauses', (req, res) => {
    const b = req.body ?? {};
    res.status(201).json(store.controls.pause(req.participant!, b.scope, b.scope === 'all' ? null : String(b.target ?? ''), typeof b.reason === 'string' ? b.reason : ''));
  });
  api.post('/pauses/resume', (req, res) => {
    const b = req.body ?? {};
    store.controls.resume(req.participant!, b.scope, b.scope === 'all' ? null : String(b.target ?? ''));
    res.status(204).end();
  });
  // For bridges: is anything stopping this agent from working this task?
  api.get('/pauses/check', (req, res) => {
    const id = optionalInt(req.query.task_id);
    const projectId = id === undefined ? null : store.tasks.get(req.participant!, id).projectId;
    res.json({ paused: store.controls.pausedFor(req.participant!, projectId) });
  });
  api.get('/agents/:name/scorecard', (req, res) => {
    res.json(store.runs.scorecard(req.participant!, String(req.params.name), optionalInt(req.query.days) ?? 30));
  });
  api.post('/tasks/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    const state = String(req.body?.state ?? '');
    if (id === undefined || !TASK_STATES.has(state)) throw new OrcoError('invalid', 'Expected a task id and a valid state');
    res.json(store.tasks.update(req.participant!, id, state as TaskState, str(req.body?.note, 'note'), taskResult(req.body)));
  });

  api.get('/locks', (req, res) => {
    const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined;
    res.json(store.locks.list(req.participant!, project));
  });
  api.post('/locks', (req, res) => {
    const { project, name, ttl_seconds, note } = req.body ?? {};
    res.status(201).json(
      store.locks.acquire(req.participant!, String(project ?? ''), String(name ?? ''), optionalInt(ttl_seconds) ?? 300, note),
    );
  });
  api.post('/locks/release', (req, res) => {
    const { project, name, force } = req.body ?? {};
    store.locks.release(req.participant!, String(project ?? ''), String(name ?? ''), force === true);
    res.status(204).end();
  });

  api.get('/my-work', (req, res) => {
    res.json(myWork(store, req.participant!));
  });
  api.get('/inbox', (req, res) => {
    const me = req.participant!;
    const approvals = store.approvals.list(me, { pending: true, forMe: true });
    const tasks = me.kind === 'user' ? store.tasks.list(me, { forMyAgents: true, open: true }) : store.tasks.list(me, { assignedToMe: true, open: true });
    const mentions = store.recentMentions(me);
    const questions = store.questions.waitingOn(me);
    const flags = store.flags.pendingFor(me);
    const stalled = store.tasks.stalledFor(me).filter((t) => t.assignee !== me.name);
    const tickets = store.tickets.list(me, { assignee: me.name, open: true, limit: 100 }).sort(byWorkOrder);
    const reviews = store.reviews.pendingFor(me);
    const suggestions = store.suggestions.pendingFor(me);
    res.json({
      approvals,
      tasks,
      tickets,
      questions,
      flags,
      stalled,
      reviews,
      suggestions,
      mentions,
      counts: {
        approvals: approvals.length,
        questions: questions.length,
        flags: flags.length,
        stalled: stalled.length,
        reviews: reviews.length,
        suggestions: suggestions.length,
        // Question pings live in `questions` while open and need nothing once answered, so they never count here.
        unseenMentions: mentions.filter((m) => !m.seen && m.approval?.state !== 'pending' && !m.question && m.review?.state !== 'pending').length,
      },
    });
  });
  // Long-poll for new mentions. Each is returned once: the server keeps the caller's seen position,
  // so a restart on either side never hands back a mention that was already delivered.
  api.get('/mentions/wait', async (req, res) => {
    const seconds = Math.min(Math.max(optionalInt(req.query.timeout) ?? 50, 0), 120);
    const stop = new AbortController();
    req.on('close', () => stop.abort());
    const release = presence.hold(req.participant!.id, 'waiting');
    try {
      res.json(await store.waitForMentions(req.participant!, seconds * 1000, stop.signal));
    } finally {
      release();
    }
  });
  api.post('/inbox/seen', (req, res) => {
    const upTo = optionalInt(req.body?.up_to_id);
    if (upTo === undefined) throw new OrcoError('invalid', 'Expected up_to_id');
    store.markMentionsSeen(req.participant!, upTo);
    res.status(204).end();
  });
  api.get('/search', (req, res) => {
    const kinds = typeof req.query.kind === 'string' && req.query.kind ? (req.query.kind.split(',') as SearchKind[]) : undefined;
    if (kinds?.some((k) => !SEARCH_KINDS.includes(k))) throw new OrcoError('invalid', `kind is one or more of ${SEARCH_KINDS.join(', ')}`);
    const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined;
    res.json(searchAll(store, req.participant!, String(req.query.q ?? ''), { project, kinds, limit: optionalInt(req.query.limit) }));
  });

  api.get('/approvals', (req, res) => {
    const room = typeof req.query.room === 'string' && req.query.room ? req.query.room : undefined;
    res.json(
      store.approvals.list(req.participant!, {
        room,
        pending: req.query.pending === '1',
        forMe: req.query.mine === '1',
        limit: optionalInt(req.query.limit),
      }),
    );
  });
  api.post('/approvals', (req, res) => {
    const { room, summary, details, ttl_seconds, approver } = req.body ?? {};
    res.status(201).json(
      store.approvals.request(req.participant!, {
        room: String(room ?? ''),
        summary: String(summary ?? ''),
        details: typeof details === 'string' ? details : undefined,
        approver: approver === 'owner' || approver === 'members' ? approver : undefined,
        ttlSeconds: optionalInt(ttl_seconds),
      }),
    );
  });
  api.post('/approvals/:id', (req, res) => {
    const id = optionalInt(req.params.id);
    const decision = req.body?.decision;
    if (id === undefined || (decision !== 'approved' && decision !== 'denied')) {
      throw new OrcoError('invalid', 'Expected an approval id and decision "approved" or "denied"');
    }
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    res.json(store.approvals.decide(req.participant!, id, decision, note, { alwaysAllow: req.body?.always_allow === true }));
  });

  api.get('/agents', (req, res) => {
    const connections = oauth && req.participant!.kind === 'user' ? oauth.connections(req.participant!) : [];
    res.json(
      store.myAgents(req.participant!).map((agent) => {
        const participant = store.participantByName(agent.name)!;
        return {
          ...agent,
          connections: connections.filter((c) => c.agent === agent.name),
          spend30d: store.tasks.spendOf(participant.id, 30),
          scorecard30d: store.runs.scorecard(req.participant!, agent.name, 30),
          memory: store.memory.list(req.participant!, agent.name).length,
          hosted: store.hosted.of(participant),
          paused: store.controls.pausedFor(participant, null)?.scope === 'agent',
        };
      }),
    );
  });
  api.post('/connections/:id/revoke', (req, res) => {
    const id = optionalInt(req.params.id);
    if (!oauth || id === undefined || req.participant!.kind !== 'user') throw new OrcoError('not_found', 'No such connection');
    oauth.revokeConnection(req.participant!, id);
    res.status(204).end();
  });
  api.post('/agents/:name/policy', (req, res) => {
    res.json(store.setTaskPolicy(req.participant!, String(req.params.name), req.body?.policy));
  });
  api.post('/agents/:name/followups', (req, res) => {
    if (typeof req.body?.auto !== 'boolean') throw new OrcoError('invalid', 'auto must be true or false');
    res.json(store.setAutoFileFollowups(req.participant!, String(req.params.name), req.body.auto));
  });
  api.post('/agents/:name/trust', (req, res) => {
    res.json(store.setTrust(req.participant!, String(req.params.name), String(req.body?.user ?? ''), req.body?.trusted !== false));
  });

  api.get('/audit', (req, res) => {
    const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined;
    const entries = store.audit.list(req.participant!, {
      project,
      sinceId: optionalInt(req.query.since_id),
      limit: optionalInt(req.query.limit),
    });
    if (req.query.format === 'jsonl') {
      const name = `orco-audit-${project ?? 'all'}-${new Date(store.now()).toISOString().slice(0, 10)}.jsonl`;
      res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${name}"`);
      res.send(entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''));
      return;
    }
    res.json(entries);
  });

  api.get('/events', (req, res) => {
    const me = req.participant!;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onMessage = (message: Message) => {
      if (store.canSee(me, message.projectId)) send('message', message);
    };
    const onStructure = () => send('structure', {});
    const onTask = (task: Task) => {
      if (store.canSee(me, task.projectId)) send('task', task);
    };
    const onApproval = (approval: Approval) => {
      if (store.canSee(me, approval.projectId)) send('approval', approval);
    };
    const onQuestion = (question: Question) => {
      if (store.canSee(me, question.projectId)) send('question', question);
    };
    const onLock = ({ projectId }: { projectId: number }) => {
      if (store.canSee(me, projectId)) send('locks', { projectId });
    };
    const onTicket = (event: { projectId: number; ref: string | null }) => {
      if (store.canSee(me, event.projectId)) send('ticket', event);
    };
    const onNotes = ({ projectId }: { projectId: number }) => {
      if (store.canSee(me, projectId)) send('notes', { projectId });
    };
    const onFlag = ({ ownerId }: { ownerId: number | null }) => {
      if (ownerId === me.id) send('flag', {});
    };
    const onSummary = (event: { projectId: number | null; threadId: number }) => {
      if (store.canSee(me, event.projectId)) send('summary', event);
    };
    const onReview = (review: Review) => {
      if (store.canSee(me, review.projectId)) send('review', { id: review.id, messageId: review.messageId, reviewer: review.reviewer, state: review.state });
    };
    const onSuggestion = ({ projectId }: { projectId: number }) => {
      if (store.canSee(me, projectId)) send('suggestion', { projectId });
    };
    const onSchedule = ({ projectId }: { projectId: number | null }) => {
      if (store.canSee(me, projectId)) send('schedule', { projectId });
    };
    const onWake = (wake: Wake) => {
      if (wake.agentId === me.id) send('wake', wake);
    };
    const onFiles = (event: { projectId: number; path: string }) => {
      if (store.canSee(me, event.projectId)) send('files', event);
    };
    const onPresence = () => send('presence', {});
    const onDecision = ({ projectId }: { projectId: number | null }) => {
      if (store.canSee(me, projectId)) send('decision', { projectId });
    };
    const onPause = (event: { scope: string; projectId: number | null; agentId: number | null }) => {
      const mine = event.agentId !== null && (event.agentId === me.id || store.participantById(event.agentId)?.ownerId === me.id);
      if (event.scope === 'all' || (event.projectId !== null && store.canSee(me, event.projectId)) || mine) send('pause', event);
    };
    const onControls = () => {
      if (me.kind === 'user') send('controls', {});
    };
    store.events.on('ticket', onTicket);
    store.events.on('notes', onNotes);
    store.events.on('flag', onFlag);
    store.events.on('summary', onSummary);
    store.events.on('message', onMessage);
    store.events.on('structure', onStructure);
    store.events.on('task', onTask);
    store.events.on('lock', onLock);
    store.events.on('approval', onApproval);
    store.events.on('question', onQuestion);
    store.events.on('review', onReview);
    store.events.on('suggestion', onSuggestion);
    store.events.on('schedule', onSchedule);
    store.events.on('wake', onWake);
    store.events.on('files', onFiles);
    store.events.on('pause', onPause);
    store.events.on('decision', onDecision);
    store.events.on('controls', onControls);
    presence.events.on('change', onPresence);
    const release = presence.hold(me.id, req.query.bridge === '1' && me.kind === 'agent' ? 'bridges' : 'streams');
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    send('ready', { name: me.name });
    req.on('close', () => {
      clearInterval(heartbeat);
      store.events.off('ticket', onTicket);
      store.events.off('notes', onNotes);
      store.events.off('flag', onFlag);
      store.events.off('summary', onSummary);
      store.events.off('message', onMessage);
      store.events.off('structure', onStructure);
      store.events.off('task', onTask);
      store.events.off('lock', onLock);
      store.events.off('approval', onApproval);
      store.events.off('question', onQuestion);
      store.events.off('review', onReview);
      store.events.off('suggestion', onSuggestion);
      store.events.off('schedule', onSchedule);
      store.events.off('wake', onWake);
      store.events.off('files', onFiles);
      store.events.off('pause', onPause);
      store.events.off('decision', onDecision);
      store.events.off('controls', onControls);
      presence.events.off('change', onPresence);
      release();
    });
  });

  app.post(
    '/api/attachments',
    auth,
    rejectCrossSiteUpload,
    express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES + 1 }),
    (req, res) => {
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const name = typeof req.query.name === 'string' ? req.query.name : undefined;
      res.status(201).json(store.attachments.upload(req.participant!, String(req.query.room ?? ''), data, name));
    },
  );

  // Incoming webhooks: no session, the secret in the URL is the credential. Bodies are kept small.
  app.post('/hooks/:token', express.raw({ type: () => true, limit: '256kb' }), (req, res) => {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]));
    const result = store.hooks.deliver(String(req.params.token), Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), headers);
    if (!result) {
      res.status(404).json({ error: 'Unknown hook' });
      return;
    }
    res.status(202).json({ ok: true, message_id: result.messageId, task_id: result.taskId });
  });

  // The bridge reports each run of its agent on a task: how long, how it ended, usage, and a masked log.
  // Logs run up to 256 KB, more than the rest of the API accepts.
  app.post('/api/tasks/:id/runs', auth, ...jsonBody('1mb'), rejectCrossSite, (req, res) => {
    const id = optionalInt(req.params.id);
    if (id === undefined) throw new OrcoError('invalid', 'Expected a task id');
    const b = req.body ?? {};
    res.status(201).json(
      store.runs.record(req.participant!, id, {
        mode: b.mode,
        startedAt: String(b.started_at ?? ''),
        seconds: b.seconds,
        outcome: String(b.outcome ?? ''),
        inputTokens: b.input_tokens,
        outputTokens: b.output_tokens,
        costMicros: b.cost_micros,
        branch: typeof b.branch === 'string' ? b.branch : null,
        workspace: typeof b.workspace === 'string' ? b.workspace : null,
        log: typeof b.log === 'string' ? b.log : null,
      }),
    );
  });
  // Project files can be up to 1 MB, more than the rest of the API accepts.
  app.post('/api/projects/:project/file', auth, ...jsonBody('2mb'), rejectCrossSite, (req, res) => {
    const b = req.body ?? {};
    const base = b.baseVersion === undefined || b.baseVersion === null || b.baseVersion === 0 ? undefined : optionalInt(b.baseVersion);
    res.json(store.files.write(req.participant!, String(req.params.project), str(b.path, 'path') ?? '', str(b.content, 'content') ?? '', { baseVersion: base, note: str(b.note, 'note') }));
  });

  // Imports carry many tickets at once, so they get a larger body limit than the rest of the API.
  app.post('/api/projects/:project/tickets/import', auth, ...jsonBody('4mb'), rejectCrossSite, (req, res) => {
    const body = req.body ?? {};
    const rows = typeof body.csv === 'string' ? parseImport(body.csv, 'csv') : body.tickets;
    if (!Array.isArray(rows)) throw new OrcoError('invalid', 'Send tickets as a JSON array, or csv as text');
    const result = importTickets(store, req.participant!, String(req.params.project), rows, {
      createLabels: body.createLabels === true,
      createMilestones: body.createMilestones === true,
      dryRun: body.dryRun === true,
    });
    res.status(result.dryRun ? 200 : 201).json(result);
  });

  app.use('/api', api);

  app.use(
    express.static(WEB_DIR, {
      setHeaders: (res) => {
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        );
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
      },
    }),
  );

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof OrcoError) {
      res.status(STATUS[err.code]).json({ error: err.message, code: err.code });
      return;
    }
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: status === 413 ? 'That is too large' : 'Bad request' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  // Once a minute: report tasks whose agents have gone quiet or ran past their budget, and start scheduled tasks.
  const stallSweep = setInterval(() => {
    try {
      store.tasks.sweepStalled();
      store.schedules.runDue();
      store.reminders.fireDue();
      store.questions.escalateDue();
      store.approvals.remindDue();
      store.runs.pruneLogs(store.limits.runLogDays);
      store.portfolios.runDue(store.digestSchedule);
    } catch (err) {
      console.error('Sweep failed:', err);
    }
  }, STALL_SWEEP_MS);
  stallSweep.unref();
  return {
    app,
    presence,
    oauth,
    close: () => {
      clearInterval(stallSweep);
      return mcp.close();
    },
  };
}
