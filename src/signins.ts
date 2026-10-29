import { randomBytes } from 'node:crypto';
import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';
import { hashToken } from './tokens.js';

/** A link someone else made (an invite, or a way back in) lasts a week; one you make for another device, 15 minutes. */
const INVITE_TTL_MS = 7 * 24 * 3600_000;
const SELF_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
const SESSION_PREFIX = 'orco_s_';

/**
 * Sign-in links: a person opens one and is signed in, without ever handling a token. Adding a person
 * (an org admin, in the browser) makes one as their invite; anyone makes one for themselves to sign in
 * on another device; the server's operator makes one for anyone (`orco user link`), as a way back in.
 * Nobody else can make one for an existing person: that would let them act as that person. Each works once. Opening one starts a browser session with its own token, kept
 * only in the cookie (Orco stores its hash), so the person's own token is never shown or changed.
 */
export class SignIns {
  constructor(private readonly store: Store) {}

  /**
   * `actor` null is the server's operator (`orco user link`); `invite` is for the person an org admin
   * has just added (the caller vouches for that).
   */
  createLink(actor: Participant | null, userName: string, options: { invite?: boolean } = {}): { code: string; expiresAt: string } {
    if (actor && (actor.kind !== 'user' || actor.scope)) throw new OrcoError('forbidden', 'Only people make sign-in links');
    const user = this.store.participantByName(userName.trim().toLowerCase());
    if (!user || user.kind !== 'user' || this.store.isSystem(user)) throw new OrcoError('not_found', `No person named ${userName}`);
    const self = actor?.id === user.id;
    if (actor && !self && !(options.invite && this.store.isOrgAdmin(actor))) {
      throw new OrcoError('forbidden', 'You can only make a sign-in link for yourself; for someone who lost access, the server operator runs orco user link');
    }
    const code = randomBytes(24).toString('base64url');
    const expiresAt = new Date(this.store.now() + (self ? SELF_TTL_MS : INVITE_TTL_MS)).toISOString();
    this.store.db
      .prepare('INSERT INTO signin_links (user_id, code_hash, created_by, expires_at) VALUES (?, ?, ?, ?)')
      .run(user.id, hashToken(code), actor?.id ?? null, expiresAt);
    this.store.audit.record(actor, 'signin_link.create', { subject: `user:${user.name}`, detail: { expiresAt } });
    return { code, expiresAt };
  }

  /** Spends a link: the person it is for, a new session token for the cookie, and whether this is their first sign-in. */
  use(code: string): { participant: Participant; session: string; firstTime: boolean } {
    const now = new Date(this.store.now()).toISOString();
    const row = this.store.db
      .prepare('SELECT id, user_id, expires_at, used_at FROM signin_links WHERE code_hash = ?')
      .get(hashToken(code)) as { id: number; user_id: number; expires_at: string; used_at: string | null } | undefined;
    if (!row || row.used_at || row.expires_at <= now) {
      throw new OrcoError('not_found', 'This sign-in link has been used or has expired; ask for a new one');
    }
    const participant = this.store.participantById(row.user_id);
    if (!participant) throw new OrcoError('not_found', 'This sign-in link has been used or has expired; ask for a new one');
    const firstTime = this.store.db.prepare('SELECT 1 FROM web_sessions WHERE user_id = ? LIMIT 1').get(row.user_id) === undefined;
    this.store.db.prepare('UPDATE signin_links SET used_at = ? WHERE id = ?').run(now, row.id);
    const session = `${SESSION_PREFIX}${randomBytes(32).toString('base64url')}`;
    this.store.db
      .prepare('INSERT INTO web_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
      .run(row.user_id, hashToken(session), new Date(this.store.now() + SESSION_TTL_MS).toISOString());
    this.store.audit.record(participant, 'signin_link.use', { subject: `user:${participant.name}` });
    return { participant, session, firstTime };
  }

  /** The person a browser session belongs to; sessions only ever come from the cookie. */
  session(token: string): Participant | null {
    if (!token.startsWith(SESSION_PREFIX)) return null;
    const row = this.store.db
      .prepare('SELECT user_id FROM web_sessions WHERE token_hash = ? AND expires_at > ?')
      .get(hashToken(token), new Date(this.store.now()).toISOString()) as { user_id: number } | undefined;
    const participant = row ? this.store.participantById(row.user_id) : null;
    return participant && !this.store.isSystem(participant) ? participant : null;
  }

  isSession(token: string): boolean {
    return token.startsWith(SESSION_PREFIX);
  }

  end(token: string): void {
    this.store.db.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(hashToken(token));
  }
}
