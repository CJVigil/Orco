import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/*
 * Area owners (#111). A folder or a label can have owners (people). A ticket in an owned area needs
 * an approving review from an owner of each such area (or the person an owner delegated to for
 * today) before it can go Done, and a deploy or push approval on it is not granted until then. The
 * card says whose review it needs, and a refused Done asks the owner for it, so it lands in their
 * Needs you.
 */

export type AreaKind = 'folder' | 'label';

export interface AreaOwner {
  id: number;
  project: string;
  kind: AreaKind;
  area: string;
  owner: string;
}

export interface Delegation {
  id: number;
  owner: string;
  delegate: string;
  from: string;
  until: string;
}

const DEPLOY = /\b(deploy(s|ing|ment)?|push(es|ing)?|release|ship(ping)?)\b/i;

export class Owners {
  constructor(private readonly store: Store) {}

  list(actor: Participant, project: string): AreaOwner[] {
    const p = this.store.visibleProject(actor, project);
    return this.forProject(p.id);
  }

  private forProject(projectId: number): AreaOwner[] {
    return this.store.db
      .prepare(
        `SELECT o.id, p.name AS project, o.kind, o.area, u.name AS owner FROM area_owners o JOIN projects p ON p.id = o.project_id
         JOIN participants u ON u.id = o.user_id WHERE o.project_id = ? ORDER BY o.kind, o.area, u.name`,
      )
      .all(projectId) as unknown as AreaOwner[];
  }

  /** Project admins name an area's owners. Owners are people who can see the project. */
  add(actor: Participant, project: string, kind: AreaKind, area: string, owner: string): AreaOwner {
    const p = this.admin(actor, project);
    if (kind !== 'folder' && kind !== 'label') throw new OrcoError('invalid', 'An area is a folder or a label');
    const name = area.trim();
    if (!name) throw new OrcoError('invalid', 'Name the folder or label');
    if (kind === 'folder' && !this.store.db.prepare('SELECT 1 FROM ticket_folders WHERE project_id = ? AND lower(name) = lower(?)').get(p.id, name)) {
      throw new OrcoError('not_found', `No folder ${name} in ${project}`);
    }
    const person = this.store.participantByName(owner.replace(/^@/, ''));
    if (!person || person.kind !== 'user' || !this.store.canSee(person, p.id)) throw new OrcoError('invalid', `An owner is a person in ${project}`);
    this.store.db.prepare('INSERT OR IGNORE INTO area_owners (project_id, kind, area, user_id) VALUES (?, ?, ?, ?)').run(p.id, kind, kind === 'label' ? name.toLowerCase() : name, person.id);
    this.store.audit.record(actor, 'owner.add', { projectId: p.id, subject: `${kind}:${name}`, detail: { owner: person.name } });
    this.store.events.emit('ticket', { projectId: p.id, ref: null });
    return this.forProject(p.id).find((o) => o.kind === kind && o.area.toLowerCase() === name.toLowerCase() && o.owner === person.name)!;
  }

  remove(actor: Participant, id: number): void {
    const row = this.store.db.prepare('SELECT o.project_id, p.name FROM area_owners o JOIN projects p ON p.id = o.project_id WHERE o.id = ?').get(id) as { project_id: number; name: string } | undefined;
    if (!row) throw new OrcoError('not_found', `No owner entry ${id}`);
    this.admin(actor, row.name);
    this.store.db.prepare('DELETE FROM area_owners WHERE id = ?').run(id);
    this.store.audit.record(actor, 'owner.remove', { projectId: row.project_id, subject: `owner:${id}` });
    this.store.events.emit('ticket', { projectId: row.project_id, ref: null });
  }

  /** An owner hands their reviews to another person for a date range (inclusive, YYYY-MM-DD). */
  delegate(actor: Participant, delegate: string, from: string, until: string): Delegation {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Owners are people');
    const person = this.store.participantByName(delegate.replace(/^@/, ''));
    if (!person || person.kind !== 'user' || person.id === actor.id) throw new OrcoError('invalid', 'Delegate to another person');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(until) || until < from) throw new OrcoError('invalid', 'from and until are dates (YYYY-MM-DD), until not before from');
    const { lastInsertRowid } = this.store.db.prepare('INSERT INTO area_delegations (owner_id, delegate_id, from_day, until_day) VALUES (?, ?, ?, ?)').run(actor.id, person.id, from, until);
    this.store.audit.record(actor, 'owner.delegate', { projectId: null, subject: `user:${actor.name}`, detail: { delegate: person.name, from, until } });
    return { id: Number(lastInsertRowid), owner: actor.name, delegate: person.name, from, until };
  }

  delegations(actor: Participant): Delegation[] {
    return this.store.db
      .prepare(
        `SELECT d.id, o.name AS owner, u.name AS delegate, d.from_day AS "from", d.until_day AS until FROM area_delegations d
         JOIN participants o ON o.id = d.owner_id JOIN participants u ON u.id = d.delegate_id WHERE d.owner_id = ? OR d.delegate_id = ? ORDER BY d.from_day`,
      )
      .all(actor.id, actor.id) as unknown as Delegation[];
  }

  /**
   * What a ticket's owned areas still need: per area, its owners (and today's delegates), and whether
   * an approving review from one of them is in.
   */
  needs(ticketId: number): { area: string; owners: string[]; reviewers: number[] }[] {
    const t = this.store.db.prepare('SELECT t.project_id, f.name AS folder FROM tickets t LEFT JOIN ticket_folders f ON f.id = t.folder_id WHERE t.id = ?').get(ticketId) as
      | { project_id: number; folder: string | null }
      | undefined;
    if (!t) return [];
    const labels = (this.store.db.prepare('SELECT lower(l.name) AS name FROM ticket_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.ticket_id = ?').all(ticketId) as { name: string }[]).map((r) => r.name);
    const areas = this.forProject(t.project_id).filter((o) => (o.kind === 'folder' ? t.folder !== null && o.area.toLowerCase() === t.folder.toLowerCase() : labels.includes(o.area)));
    if (!areas.length) return [];
    const today = new Date(this.store.now()).toISOString().slice(0, 10);
    const approvedBy = new Set((this.store.db.prepare("SELECT reviewer_id FROM reviews WHERE ticket_id = ? AND state = 'approved'").all(ticketId) as { reviewer_id: number }[]).map((r) => r.reviewer_id));
    const byArea = new Map<string, { area: string; owners: string[]; reviewers: number[] }>();
    for (const o of areas) {
      const key = `${o.kind}:${o.area.toLowerCase()}`;
      const entry = byArea.get(key) ?? { area: o.kind === 'folder' ? o.area : `label ${o.area}`, owners: [], reviewers: [] };
      const owner = this.store.participantByName(o.owner)!;
      entry.owners.push(o.owner);
      entry.reviewers.push(owner.id);
      for (const d of this.store.db.prepare('SELECT delegate_id FROM area_delegations WHERE owner_id = ? AND from_day <= ? AND until_day >= ?').all(owner.id, today, today) as { delegate_id: number }[]) {
        entry.reviewers.push(d.delegate_id);
      }
      byArea.set(key, entry);
    }
    return [...byArea.values()].filter((a) => !a.reviewers.some((id) => approvedBy.has(id)));
  }

  /** The people whose review a ticket still needs, for its card: "ana (Infrastructure)". */
  waitingFor(ticketId: number): string[] {
    return this.needs(ticketId).map((a) => `${a.owners.join(' or ')} (${a.area})`);
  }

  /**
   * Refuses Done without the owners' approving review, and asks the first owner (or today's
   * delegate) for it if nobody has been asked, so it lands in their Needs you.
   */
  assertMayFinish(actor: Participant, ticketId: number, ref: string): void {
    const missing = this.needs(ticketId);
    if (!missing.length) return;
    for (const area of missing) {
      const asked = this.store.db
        .prepare(`SELECT 1 FROM reviews WHERE ticket_id = ? AND state = 'pending' AND reviewer_id IN (${area.reviewers.map(() => '?').join(', ')})`)
        .get(ticketId, ...area.reviewers);
      if (asked) continue;
      const reviewer = this.store.participantById(area.reviewers.find((id) => id !== actor.id && id !== this.store.humanOf(actor)) ?? -1);
      if (!reviewer) continue;
      try {
        this.store.reviews.request(actor, { ticket: ref, reviewer: reviewer.name, summary: `${ref} is in ${area.area}, which needs an owner's review before Done.` });
      } catch {
        // Asked already, or the reviewer cannot see it: the refusal below still says whose review it needs.
      }
    }
    throw new OrcoError('conflict', `${ref} needs an approving review from ${missing.map((a) => `${a.owners.join(' or ')} (owner of ${a.area})`).join(' and ')} before Done. They have been asked.`);
  }

  /** A deploy or push approval on a ticket in an owned area waits for the owners' review. */
  assertMayApprove(ticketId: number | null, text: string, ref: string): void {
    if (ticketId === null || !DEPLOY.test(text)) return;
    const missing = this.needs(ticketId);
    if (missing.length) throw new OrcoError('conflict', `Not yet: ${ref} needs ${missing.map((a) => `${a.owners.join(' or ')}'s review (${a.area})`).join(' and ')} before a deploy or push is approved`);
  }

  private admin(actor: Participant, project: string) {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people name owners');
    const p = this.store.visibleProject(actor, project);
    if (this.store.roleIn(actor, p.id) !== 'admin' && !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', `Only admins of ${project} name area owners`);
    return p;
  }
}
