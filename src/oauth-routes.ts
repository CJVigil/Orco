import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { OAuth, OAuthError, type PendingRequest } from './oauth.js';
import type { RateLimiter } from './ratelimit.js';
import type { Participant, Store } from './store.js';

const COOKIE = 'orco_token';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light"><title>${escape(title)} · Orco</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/style.css"></head>
<body><main class="login"><div class="login-card oauth-card">
<div class="brand"><span class="logo" aria-hidden="true"></span>Orco</div>
${body}
</div></main></body></html>`;
}

function errorPage(message: string): string {
  return page('Cannot connect', `<h1 class="oauth-title">Cannot connect</h1><p>${escape(message)}</p>
<p class="muted small">Close this window and start again from the app.</p>`);
}

function noStore(res: Response): void {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return req.headers['sec-fetch-site'] === 'same-origin';
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === COOKIE) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

function sendOAuthError(res: Response, err: unknown, next: NextFunction): void {
  if (!(err instanceof OAuthError)) return next(err);
  noStore(res);
  if (err.status === 401) res.set('WWW-Authenticate', 'Basic realm="orco"');
  res.status(err.status).json({ error: err.error, error_description: err.description });
}

export function oauthRouter(store: Store, oauth: OAuth, logins: RateLimiter, registrations: RateLimiter): Router {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '16kb' });
  const currentUser = (req: Request): Participant | null => {
    const token = readCookie(req.headers.cookie);
    const participant = token ? store.authenticate(token) : null;
    return participant?.kind === 'user' ? participant : null;
  };

  router.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.json(oauth.protectedResourceMetadata());
  });

  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.json(oauth.authorizationServerMetadata());
  });

  router.post('/oauth/register', express.json({ limit: '16kb' }), (req, res, next) => {
    try {
      const ip = req.ip ?? 'unknown';
      if (registrations.blocked(ip)) throw new OAuthError('too_many_requests', 'Too many client registrations; try again later', 429);
      registrations.hit(ip);
      noStore(res);
      res.status(201).json(oauth.register((req.body ?? {}) as Record<string, unknown>));
    } catch (err) {
      sendOAuthError(res, err, next);
    }
  });

  router.get('/oauth/authorize', (req, res) => {
    noStore(res);
    const params = new URLSearchParams(req.url.split('?')[1] ?? '');
    let checked: ReturnType<OAuth['checkClientAndRedirect']>;
    try {
      checked = oauth.checkClientAndRedirect(params);
    } catch (err) {
      res.status(400).type('html').send(errorPage((err as Error).message));
      return;
    }
    try {
      const id = oauth.startAuthorization(params, checked.client, checked.redirectUri);
      res.redirect(303, `/oauth/consent?request=${encodeURIComponent(id)}`);
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      const redirect = new URL(checked.redirectUri);
      redirect.searchParams.set('error', err.error);
      redirect.searchParams.set('error_description', err.description);
      const state = params.get('state');
      if (state !== null) redirect.searchParams.set('state', state);
      redirect.searchParams.set('iss', oauth.issuer);
      res.redirect(303, redirect.toString());
    }
  });

  router.get('/oauth/consent', (req, res) => {
    noStore(res);
    res.set('X-Frame-Options', 'DENY');
    const pending = oauth.pending(String(req.query.request ?? ''));
    if (!pending) {
      res.status(400).type('html').send(errorPage('This sign-in request expired. Start again from the app.'));
      return;
    }
    const user = currentUser(req);
    if (!user) {
      res.type('html').send(loginPage(pending));
      return;
    }
    const agents = store.myAgents(user);
    const nonce = oauth.bindViewer(pending.id, user);
    res.type('html').send(consentPage(pending, user, agents.map((a) => a.name), nonce));
  });

  router.post('/oauth/login', form, (req, res) => {
    noStore(res);
    const requestId = String(req.body?.request ?? '');
    const pending = oauth.pending(requestId);
    if (!sameOrigin(req) || !pending) {
      res.status(400).type('html').send(errorPage('This sign-in request expired. Start again from the app.'));
      return;
    }
    const ip = req.ip ?? 'unknown';
    if (logins.blocked(ip)) {
      res.status(429).type('html').send(loginPage(pending, 'Too many failed sign-ins. Wait 15 minutes and try again.'));
      return;
    }
    const token = String(req.body?.token ?? '').trim();
    const user = store.authenticate(token);
    if (!user || user.kind !== 'user') {
      logins.hit(ip);
      res.status(401).type('html').send(loginPage(pending, 'That is not a valid user token.'));
      return;
    }
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/', maxAge: 30 * 24 * 3600 * 1000 });
    res.redirect(303, `/oauth/consent?request=${encodeURIComponent(requestId)}`);
  });

  router.post('/oauth/consent', form, (req, res) => {
    noStore(res);
    const user = currentUser(req);
    if (!sameOrigin(req) || !user) {
      res.status(403).type('html').send(errorPage('Your Orco session was not found. Sign in again from the app.'));
      return;
    }
    try {
      const approve = req.body?.decision === 'approve';
      const location = oauth.decide(user, String(req.body?.request ?? ''), String(req.body?.nonce ?? ''), {
        approve,
        agent: String(req.body?.agent ?? ''),
      });
      res.redirect(303, location);
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      res.status(400).type('html').send(errorPage(err.description));
    }
  });

  router.post('/oauth/token', form, (req, res, next) => {
    try {
      noStore(res);
      res.json(oauth.token(new URLSearchParams(req.body as Record<string, string>), req.headers.authorization));
    } catch (err) {
      sendOAuthError(res, err, next);
    }
  });

  router.post('/oauth/revoke', form, (req, res, next) => {
    try {
      oauth.revoke(new URLSearchParams(req.body as Record<string, string>), req.headers.authorization);
      noStore(res);
      res.status(200).end();
    } catch (err) {
      sendOAuthError(res, err, next);
    }
  });

  return router;
}

function clientSummary(pending: PendingRequest): string {
  const redirect = new URL(pending.redirectUri);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname);
  return `<p><strong>${escape(pending.client.name)}</strong> wants to connect to Orco as one of your agents.</p>
<p class="muted small">It will send you back to <strong>${escape(redirect.host)}</strong>.${
    local ? ' That is an app on the computer you are using; only continue if you started this from that app.' : ''
  }</p>`;
}

function loginPage(pending: PendingRequest, error?: string): string {
  return page(
    'Sign in',
    `<h1 class="oauth-title">Sign in to connect an app</h1>
${clientSummary(pending)}
<form method="post" action="/oauth/login" class="oauth-form">
<input type="hidden" name="request" value="${escape(pending.id)}">
<label for="token">Your user token</label>
<input id="token" name="token" type="password" autocomplete="current-password" required placeholder="orco_u_…">
${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}
<button type="submit" class="primary">Sign in</button>
</form>`,
  );
}

function consentPage(pending: PendingRequest, user: Participant, agents: string[], nonce: string): string {
  if (agents.length === 0) {
    return page(
      'No agents',
      `<h1 class="oauth-title">You have no agents yet</h1>
${clientSummary(pending)}
<p>An app connects as one of your agents. Ask a server admin to run
<code>orco agent add ${escape(user.name)} &lt;name&gt;</code>, then start again from the app.</p>`,
    );
  }
  const options = agents.map((name) => `<option value="${escape(name)}">${escape(name)}</option>`).join('');
  return page(
    'Connect an app',
    `<h1 class="oauth-title">Connect an app</h1>
${clientSummary(pending)}
<form method="post" action="/oauth/consent" class="oauth-form">
<input type="hidden" name="request" value="${escape(pending.id)}">
<input type="hidden" name="nonce" value="${escape(nonce)}">
<label for="agent">Act as</label>
<select id="agent" name="agent">${options}</select>
<p class="muted small">The app gets that agent's access: the same projects, task rules, locks and approvals.
It cannot change settings, decide approvals or read the audit log. You can revoke it any time under
<em>My agents</em>. Signed in as ${escape(user.name)}.</p>
<div class="row-end">
<button type="submit" name="decision" value="deny" class="ghost">Deny</button>
<button type="submit" name="decision" value="approve" class="primary">Allow</button>
</div>
</form>`,
  );
}
