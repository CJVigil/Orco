import { createHash, randomBytes } from 'node:crypto';
import { sniffImage } from './attachments.js';
import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/*
 * Guest links (#117): one ticket shared with one person who has no Orco account. The link works in
 * one browser (the first to open it, by a cookie), for 24 hours, until Stop sharing, a new link, the
 * ticket closing, or an org admin turning guest links off. The guest sees that ticket only: title,
 * status, next step and its comments. What the guest writes (with a photo if they like) waits as a
 * Request until someone in the project presses Send, which comments it on the ticket and tells its
 * agent, or Dismiss. Every guest action is audited. Tokens and browser keys are stored only hashed.
 */

const TTL_MS = 24 * 3600_000;
const MAX_TEXT = 2000;
const MAX_PHOTO = 5 * 1024 * 1024;
const MAX_PER_HOUR = 20;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');

export interface GuestLink {
  id: number;
  ticket: string;
  by: string;
  expiresAt: string;
  url: string;
}

export interface GuestRequest {
  id: number;
  text: string;
  hasPhoto: boolean;
  state: 'pending' | 'sent' | 'dismissed';
  at: string;
}

interface LinkRow {
  id: number;
  ticket_id: number;
  project_id: number;
  created_by: number;
  expires_at: number;
  revoked_at: number | null;
  browser_hash: string | null;
}

export class Guests {
  constructor(private readonly store: Store) {}

  enabled(): boolean {
    const row = this.store.db.prepare("SELECT value FROM org_settings WHERE key = 'guest_links'").get() as { value: string } | undefined;
    return row?.value !== 'off';
  }

  setEnabled(actor: Participant, on: boolean): void {
    if (actor.kind !== 'user' || !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins turn guest links on or off');
    this.store.db.prepare("INSERT INTO org_settings (key, value) VALUES ('guest_links', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(on ? 'on' : 'off');
    if (!on) this.store.db.prepare('UPDATE guest_links SET revoked_at = ? WHERE revoked_at IS NULL').run(this.store.now());
    this.store.audit.record(actor, 'guest.setting', { projectId: null, subject: 'org', detail: { on } });
  }

  /** A person who can change the ticket shares it: a new link ends the ticket's earlier ones. Shown once. */
  share(actor: Participant, ref: string, origin: string): GuestLink {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people share tickets with guests');
    if (!this.enabled()) throw new OrcoError('forbidden', 'Guest links are turned off on this server');
    const ticket = this.store.tickets.get(actor, ref);
    this.store.assertWrite(actor, ticket.projectId);
    if (ticket.status.category === 'completed' || ticket.status.category === 'canceled') throw new OrcoError('conflict', `${ticket.ref} is closed`);
    const now = this.store.now();
    this.store.db.prepare('UPDATE guest_links SET revoked_at = ? WHERE ticket_id = ? AND revoked_at IS NULL').run(now, ticket.id);
    const token = `orco_g_${randomBytes(24).toString('base64url')}`;
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO guest_links (ticket_id, project_id, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ticket.id, ticket.projectId, hash(token), actor.id, now, now + TTL_MS);
    this.store.audit.record(actor, 'guest.share', { projectId: ticket.projectId, subject: `ticket:${ticket.ref}`, detail: { link: Number(lastInsertRowid) } });
    return { id: Number(lastInsertRowid), ticket: ticket.ref, by: actor.name, expiresAt: new Date(now + TTL_MS).toISOString(), url: `${origin}/guest.html#${token}` };
  }

  stop(actor: Participant, ref: string): void {
    const ticket = this.store.tickets.get(actor, ref);
    this.store.assertWrite(actor, ticket.projectId);
    this.store.db.prepare('UPDATE guest_links SET revoked_at = ? WHERE ticket_id = ? AND revoked_at IS NULL').run(this.store.now(), ticket.id);
    this.store.audit.record(actor, 'guest.stop', { projectId: ticket.projectId, subject: `ticket:${ticket.ref}` });
  }

  /** Whether the ticket has a live link, for the Share button. */
  active(ticketId: number): { expiresAt: string; by: string } | null {
    const row = this.store.db
      .prepare('SELECT l.expires_at, u.name AS by FROM guest_links l JOIN participants u ON u.id = l.created_by WHERE l.ticket_id = ? AND l.revoked_at IS NULL AND l.expires_at > ? ORDER BY l.id DESC LIMIT 1')
      .get(ticketId, this.store.now()) as { expires_at: number; by: string } | undefined;
    return row ? { expiresAt: new Date(row.expires_at).toISOString(), by: row.by } : null;
  }

  /**
   * The link behind a guest's request, if it still works in this browser. The first browser to open
   * it gets a key (returned once, as a cookie); after that only that key opens it.
   */
  open(token: string, browserKey: string | undefined): { link: LinkRow; newKey: string | null } {
    const row = this.store.db.prepare('SELECT * FROM guest_links WHERE token_hash = ?').get(hash(token)) as LinkRow | undefined;
    const gone = new OrcoError('not_found', 'This link has ended. Ask whoever shared it for a new one.');
    if (!row || row.revoked_at !== null || row.expires_at <= this.store.now() || !this.enabled()) throw gone;
    const ticket = this.store.db.prepare('SELECT s.category FROM tickets t JOIN ticket_statuses s ON s.id = t.status_id WHERE t.id = ?').get(row.ticket_id) as { category: string } | undefined;
    if (!ticket || ticket.category === 'completed' || ticket.category === 'canceled') throw gone;
    if (row.browser_hash === null) {
      const key = randomBytes(24).toString('base64url');
      this.store.db.prepare('UPDATE guest_links SET browser_hash = ? WHERE id = ? AND browser_hash IS NULL').run(hash(key), row.id);
      this.store.audit.record(null, 'guest.open', { projectId: row.project_id, subject: `guest_link:${row.id}` });
      return { link: { ...row, browser_hash: hash(key) }, newKey: key };
    }
    if (!browserKey || hash(browserKey) !== row.browser_hash) throw new OrcoError('forbidden', 'This link is open in another browser. Ask whoever shared it for a new one.');
    return { link: row, newKey: null };
  }

  /** What the guest sees: that ticket, and nothing else in the project. */
  view(link: LinkRow): { ref: string; title: string; status: string; nextStep: string | null; waitingOn: string | null; comments: { by: string; kind: 'person' | 'agent' | 'orco'; text: string; at: string }[]; requests: GuestRequest[]; expiresAt: string } {
    const t = this.store.db
      .prepare("SELECT p.ticket_key || '-' || t.number AS ref, t.title, s.name AS status, t.next_step, t.waiting_ask FROM tickets t JOIN projects p ON p.id = t.project_id JOIN ticket_statuses s ON s.id = t.status_id WHERE t.id = ?")
      .get(link.ticket_id) as { ref: string; title: string; status: string; next_step: string | null; waiting_ask: string | null };
    const comments = (
      this.store.db
        .prepare("SELECT p.name AS by, p.kind, ta.body, ta.created_at FROM ticket_activity ta LEFT JOIN participants p ON p.id = ta.actor_id WHERE ta.ticket_id = ? AND ta.kind = 'comment' AND ta.body IS NOT NULL ORDER BY ta.id DESC LIMIT 50")
        .all(link.ticket_id) as { by: string | null; kind: string | null; body: string; created_at: string }[]
    )
      .reverse()
      .map((c) => ({ by: c.by ?? 'Orco', kind: (c.kind === 'agent' ? 'agent' : c.kind === 'user' ? 'person' : 'orco') as 'person' | 'agent' | 'orco', text: c.body, at: c.created_at }));
    return { ref: t.ref, title: t.title, status: t.status, nextStep: t.next_step, waitingOn: t.waiting_ask, comments, requests: this.requests(link.ticket_id, link.id), expiresAt: new Date(link.expires_at).toISOString() };
  }

  /** The guest writes: it waits as a Request for someone in the project to Send or Dismiss. */
  request(link: LinkRow, text: string, photo?: { data: Buffer } | null): GuestRequest {
    const body = text.trim();
    if (!body && !photo) throw new OrcoError('invalid', 'Write something, or add a photo');
    if (body.length > MAX_TEXT) throw new OrcoError('invalid', `Keep it under ${MAX_TEXT} characters`);
    let mime: string | null = null;
    if (photo) {
      if (photo.data.length > MAX_PHOTO) throw new OrcoError('invalid', 'Photos can be at most 5 MB');
      mime = sniffImage(photo.data);
      if (!mime) throw new OrcoError('invalid', 'Photos are PNG, JPEG, GIF or WebP');
    }
    const recent = (this.store.db.prepare('SELECT count(*) AS n FROM guest_requests WHERE link_id = ? AND created_at > ?').get(link.id, this.store.now() - 3600_000) as { n: number }).n;
    if (recent >= MAX_PER_HOUR) throw new OrcoError('rate_limited', 'That is a lot of requests for one hour; try again later');
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO guest_requests (ticket_id, link_id, text, photo, photo_mime, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(link.ticket_id, link.id, body, photo ? photo.data : null, mime, this.store.now());
    this.store.audit.record(null, 'guest.request', { projectId: link.project_id, subject: `guest_link:${link.id}`, detail: { request: Number(lastInsertRowid), text: body.slice(0, 200), photo: !!photo } });
    this.store.events.emit('ticket', { projectId: link.project_id, ref: null });
    return this.requests(link.ticket_id, link.id).find((r) => r.id === Number(lastInsertRowid))!;
  }

  requests(ticketId: number, linkId?: number): GuestRequest[] {
    return (
      this.store.db
        .prepare(`SELECT id, text, photo IS NOT NULL AS has_photo, state, created_at FROM guest_requests WHERE ticket_id = ? ${linkId === undefined ? '' : 'AND link_id = ?'} ORDER BY id`)
        .all(...(linkId === undefined ? [ticketId] : [ticketId, linkId])) as { id: number; text: string; has_photo: number; state: GuestRequest['state']; created_at: number }[]
    ).map((r) => ({ id: r.id, text: r.text, hasPhoto: r.has_photo === 1, state: r.state, at: new Date(r.created_at).toISOString() }));
  }

  photo(actor: Participant | null, link: LinkRow | null, id: number): { data: Buffer; mime: string } {
    const row = this.store.db.prepare('SELECT ticket_id, link_id, photo, photo_mime FROM guest_requests WHERE id = ?').get(id) as { ticket_id: number; link_id: number; photo: Uint8Array | null; photo_mime: string | null } | undefined;
    if (!row || !row.photo) throw new OrcoError('not_found', 'No photo');
    if (link ? link.id !== row.link_id : !actor || !this.store.tickets.sees(actor, row.ticket_id)) throw new OrcoError('not_found', 'No photo');
    if (actor) this.store.tickets.get(actor, this.refOf(row.ticket_id));
    return { data: Buffer.from(row.photo), mime: row.photo_mime! };
  }

  /**
   * Someone in the project sends a guest's request on: a comment on the ticket (with the photo as a
   * ticket file), and a note to its agent; or dismisses it.
   */
  decide(actor: Participant, id: number, send: boolean): GuestRequest {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'People decide guest requests');
    const row = this.store.db.prepare('SELECT * FROM guest_requests WHERE id = ?').get(id) as { id: number; ticket_id: number; text: string; photo: Uint8Array | null; state: string } | undefined;
    if (!row) throw new OrcoError('not_found', `No request ${id}`);
    const ref = this.refOf(row.ticket_id);
    const ticket = this.store.tickets.get(actor, ref);
    this.store.assertWrite(actor, ticket.projectId);
    if (row.state !== 'pending') throw new OrcoError('conflict', `Request ${id} is already ${row.state}`);
    this.store.db.prepare('UPDATE guest_requests SET state = ?, decided_by = ? WHERE id = ?').run(send ? 'sent' : 'dismissed', actor.id, id);
    if (send) {
      const files: number[] = [];
      if (row.photo) files.push(this.store.ticketFiles.upload(actor, ticket.project, Buffer.from(row.photo), `guest-photo-${id}`).id);
      this.store.tickets.comment(actor, ref, `Guest asks: ${row.text || '(a photo)'}`, files);
      if (ticket.assignee?.kind === 'agent') {
        this.store.post(actor, this.store.tickets.workRoom(ticket.projectId), `@${ticket.assignee.name} A guest following ${ref} asks: ${row.text || '(see the photo on the ticket)'}\nAnswer on the ticket with comment_ticket; the guest sees comments there.`, undefined, { skipRateLimit: true });
      }
    }
    this.store.audit.record(actor, send ? 'guest.send' : 'guest.dismiss', { projectId: ticket.projectId, subject: `ticket:${ref}`, detail: { request: id } });
    this.store.events.emit('ticket', { projectId: ticket.projectId, ref });
    return this.requests(row.ticket_id).find((r) => r.id === id)!;
  }

  private refOf(ticketId: number): string {
    return (this.store.db.prepare("SELECT p.ticket_key || '-' || t.number AS ref FROM tickets t JOIN projects p ON p.id = t.project_id WHERE t.id = ?").get(ticketId) as { ref: string }).ref;
  }
}
