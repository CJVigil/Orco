import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

const MAX = 254;

/** A login as a proxy reports it: an email (Google, Cloudflare Access) or a login name (Tailscale), compared case-blind. */
export function normalizeIdentity(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > MAX || /[\s\u0000-\u001f\u007f,;<>]/.test(value)) return null;
  return value;
}

/**
 * Sign-in through a proxy ("Sign in with Google"): the proxy in front of Orco signs people in and
 * passes who they are in a header; Orco maps that login to a person. A login is linked to a person
 * when an org admin adds them, on the server (`orco user email`), or by the person themselves while
 * signed in, for the login the proxy vouches for. Nobody links a login to someone else's existing
 * account: that would let them sign in as that person.
 */
export class Identities {
  constructor(private readonly store: Store) {}

  /** The person a login belongs to, if any. */
  userFor(identity: string): Participant | null {
    const row = this.store.db.prepare('SELECT user_id FROM identities WHERE identity = ?').get(identity) as { user_id: number } | undefined;
    const user = row ? this.store.participantById(row.user_id) : null;
    return user && user.kind === 'user' && !this.store.isSystem(user) ? user : null;
  }

  of(userId: number): string[] {
    return (this.store.db.prepare('SELECT identity FROM identities WHERE user_id = ? ORDER BY identity').all(userId) as { identity: string }[]).map((r) => r.identity);
  }

  /**
   * Links a login to a person. `actor` null is the server's operator; `invite` is an org admin adding
   * that person right now; otherwise a person links a login (vouched for by the proxy) to themselves.
   */
  link(actor: Participant | null, userName: string, raw: string, options: { invite?: boolean } = {}): string {
    const identity = normalizeIdentity(raw);
    if (!identity) throw new OrcoError('invalid', 'That is not a valid email or login');
    const user = this.store.participantByName(userName.trim().toLowerCase());
    if (!user || user.kind !== 'user' || this.store.isSystem(user)) throw new OrcoError('not_found', `No person named ${userName}`);
    if (actor) {
      if (actor.kind !== 'user' || actor.scope) throw new OrcoError('forbidden', 'Only people link logins');
      const self = actor.id === user.id;
      if (!self && !(options.invite && this.store.isOrgAdmin(actor))) {
        throw new OrcoError('forbidden', 'You can only link a login to yourself; the server operator runs orco user email for someone else');
      }
    }
    const taken = this.userFor(identity);
    if (taken && taken.id !== user.id) throw new OrcoError('conflict', `${identity} already signs in as ${taken.name}`);
    if (taken) return identity;
    this.store.db.prepare('INSERT INTO identities (identity, user_id, created_by) VALUES (?, ?, ?)').run(identity, user.id, actor?.id ?? null);
    this.store.audit.record(actor, 'identity.link', { subject: `user:${user.name}`, detail: { identity } });
    return identity;
  }

  /** Removes a login: the person themselves, or the server's operator. */
  unlink(actor: Participant | null, userName: string, raw: string): void {
    const identity = normalizeIdentity(raw);
    const user = this.store.participantByName(userName.trim().toLowerCase());
    if (!identity || !user) throw new OrcoError('not_found', 'No such login');
    if (actor && actor.id !== user.id) throw new OrcoError('forbidden', 'You can only remove your own logins');
    const { changes } = this.store.db.prepare('DELETE FROM identities WHERE identity = ? AND user_id = ?').run(identity, user.id);
    if (!changes) throw new OrcoError('not_found', `${identity} is not linked to ${user.name}`);
    this.store.audit.record(actor, 'identity.unlink', { subject: `user:${user.name}`, detail: { identity } });
  }
}
