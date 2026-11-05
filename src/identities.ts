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

  /**
   * Hub sign-in (#143): the person behind a provider account, keyed on the account's subject (never an
   * email, which can move between accounts). Someone the hub lets in for the first time gets an Orco
   * account, named after their username. Their org-admin role follows the hub's groups on every
   * sign-in, except that the last org admin is never demoted by it.
   */
  hubSignIn(account: { issuer: string; subject: string; name: string | null; email: string | null; role: 'admin' | 'member' }): { user: Participant; created: boolean } {
    const key = `oidc:${account.issuer}#${account.subject}`.slice(0, 254);
    const row = this.store.db.prepare('SELECT user_id FROM identities WHERE issuer = ? AND subject = ?').get(account.issuer, account.subject) as { user_id: number } | undefined;
    let user = row ? this.store.participantById(row.user_id) : null;
    let created = false;
    if (!user) {
      const base =
        (account.name ?? account.email?.split('@')[0] ?? 'person')
          .toLowerCase()
          .normalize('NFKD')
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 28) || 'person';
      let name = /^[a-z0-9]/.test(base) ? base : `p-${base}`.slice(0, 28);
      for (let n = 2; this.store.participantByName(name); n++) name = `${base.slice(0, 26)}-${n}`;
      user = this.store.createUser(name, { orgAdmin: account.role === 'admin' }).participant;
      this.store.db.prepare('INSERT INTO identities (identity, user_id, created_by, issuer, subject) VALUES (?, ?, NULL, ?, ?)').run(key, user.id, account.issuer, account.subject);
      this.store.audit.record(null, 'identity.hub_create', { subject: `user:${name}`, detail: { issuer: account.issuer, role: account.role } });
      created = true;
    } else if (user.kind !== 'user' || this.store.isSystem(user)) {
      throw new OrcoError('forbidden', 'That account is not a person here');
    }
    const isAdmin = this.store.isOrgAdmin(user);
    if (account.role === 'admin' && !isAdmin) this.store.setOrgAdmin(user.name, true);
    if (account.role === 'member' && isAdmin) {
      const others = this.store.db.prepare("SELECT count(*) AS n FROM participants WHERE kind = 'user' AND org_admin = 1 AND id != ?").get(user.id) as { n: number };
      if (others.n > 0) this.store.setOrgAdmin(user.name, false);
    }
    return { user, created };
  }

  /** The person a login belongs to, if any. */
  userFor(identity: string): Participant | null {
    const row = this.store.db.prepare('SELECT user_id FROM identities WHERE identity = ?').get(identity) as { user_id: number } | undefined;
    const user = row ? this.store.participantById(row.user_id) : null;
    return user && user.kind === 'user' && !this.store.isSystem(user) ? user : null;
  }

  /**
   * Whether a provider account may sign in with a login: only the account the login is tied to. A
   * login nobody has signed in with that way yet (an org admin added it, or a proxy linked it) is
   * 'unbound': it is tied only once its person confirms from a sign-in of their own (see bind), never
   * by whoever reaches the provider first. An email alone can move between accounts (a self-hosted
   * Gitea without email confirmation lets anyone claim an address); the provider's account id cannot.
   */
  accountStatus(identity: string, issuer: string, subject: string): 'ok' | 'mismatch' | 'unbound' {
    const row = this.store.db.prepare('SELECT issuer, subject FROM identities WHERE identity = ?').get(identity) as { issuer: string | null; subject: string | null } | undefined;
    if (!row || row.subject === null) return 'unbound';
    return row.issuer === issuer && row.subject === subject ? 'ok' : 'mismatch';
  }

  /** Ties an unbound login to a provider account, for its person, who is signed in right now. */
  bind(person: Participant, identity: string, account: { issuer: string; subject: string }): void {
    if (this.userFor(identity)?.id !== person.id) throw new OrcoError('forbidden', 'That login is not yours');
    const { changes } = this.store.db.prepare('UPDATE identities SET issuer = ?, subject = ? WHERE identity = ? AND subject IS NULL').run(account.issuer, account.subject, identity);
    if (changes) this.store.audit.record(person, 'identity.bind', { subject: `user:${person.name}`, detail: { identity, issuer: account.issuer } });
  }

  of(userId: number): string[] {
    return (this.store.db.prepare('SELECT identity FROM identities WHERE user_id = ? ORDER BY identity').all(userId) as { identity: string }[]).map((r) => r.identity);
  }

  /**
   * Links a login to a person. `actor` null is the server's operator; `invite` is an org admin adding
   * that person right now; otherwise a person links a login (vouched for by the proxy) to themselves.
   */
  link(actor: Participant | null, userName: string, raw: string, options: { invite?: boolean; account?: { issuer: string; subject: string } } = {}): string {
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
    this.store.db
      .prepare('INSERT INTO identities (identity, user_id, created_by, issuer, subject) VALUES (?, ?, ?, ?, ?)')
      .run(identity, user.id, actor?.id ?? null, options.account?.issuer ?? null, options.account?.subject ?? null);
    this.store.audit.record(actor, 'identity.link', { subject: `user:${user.name}`, detail: { identity } });
    return identity;
  }

  /** Removes a login: the person themselves, or the server's operator. */
  unlink(actor: Participant | null, userName: string, raw: string): void {
    const identity = normalizeIdentity(raw);
    const user = this.store.participantByName(userName.trim().toLowerCase());
    if (!identity || !user) throw new OrcoError('not_found', 'No such login');
    if (actor && actor.id !== user.id && !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'You can only remove your own logins');
    const { changes } = this.store.db.prepare('DELETE FROM identities WHERE identity = ? AND user_id = ?').run(identity, user.id);
    if (!changes) throw new OrcoError('not_found', `${identity} is not linked to ${user.name}`);
    this.store.audit.record(actor, 'identity.unlink', { subject: `user:${user.name}`, detail: { identity } });
  }
}
