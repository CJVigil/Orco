import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/*
 * Build order rules (#109): "tickets labelled ui wait for milestone Skeleton", or for every open
 * ticket labelled B to close. Org admins set rules for every project; a project's admins add their
 * own, and can never remove an org rule. A waiting ticket cannot be started, claimed to start, or
 * handed to an agent, and its card says what it waits on. The rule lifts by itself once the
 * milestone's tickets are all done.
 */

export interface OrderRule {
  id: number;
  /** null: an org rule, for every project. */
  project: string | null;
  label: string;
  waitsMilestone: string | null;
  waitsLabel: string | null;
  by: string;
}

/** The default Skeleton milestone: steps 1 and 2 of the team's build order (decided 2026-11-03). */
export const SKELETON = 'Skeleton';
export const SKELETON_CHECKLIST = [
  'The backend data path only (a consumer that just logs events, say), and a local dev stack. No UI.',
  'The data model, with migrations',
  'Integrations, behind an API with tests',
  'A health endpoint',
  'Deploy config, and CI green',
].map((line) => `- [ ] ${line}`).join('\n');

/** The build order the README carries, after the Skeleton. */
export const BUILD_ORDER = [
  'The backend data path only, plus a local dev stack. No UI.',
  'Then the data model, integrations and tests.',
  'Then the admin or UI surface.',
  'Hardening before the first deploy: memory limits, log rotation, database auth, pinned image versions.',
  'Deploy files and a deploy runbook last.',
];

interface Row {
  id: number;
  project_id: number | null;
  project: string | null;
  label: string;
  waits_milestone: string | null;
  waits_label: string | null;
  by: string;
}

const toRule = (r: Row): OrderRule => ({ id: r.id, project: r.project, label: r.label, waitsMilestone: r.waits_milestone, waitsLabel: r.waits_label, by: r.by });

export class OrderRules {
  constructor(private readonly store: Store) {}

  /** The rules that apply in a project: the org's, then its own. */
  forProject(projectId: number): OrderRule[] {
    return (
      this.store.db
        .prepare(
          `SELECT r.id, r.project_id, p.name AS project, r.label, r.waits_milestone, r.waits_label, u.name AS by
           FROM order_rules r LEFT JOIN projects p ON p.id = r.project_id JOIN participants u ON u.id = r.created_by
           WHERE r.project_id IS NULL OR r.project_id = ? ORDER BY r.project_id IS NOT NULL, r.id`,
        )
        .all(projectId) as unknown as Row[]
    ).map(toRule);
  }

  list(actor: Participant, project?: string): OrderRule[] {
    if (project) return this.forProject(this.store.visibleProject(actor, project).id);
    return (
      this.store.db
        .prepare('SELECT r.id, r.project_id, NULL AS project, r.label, r.waits_milestone, r.waits_label, u.name AS by FROM order_rules r JOIN participants u ON u.id = r.created_by WHERE r.project_id IS NULL ORDER BY r.id')
        .all() as unknown as Row[]
    ).map(toRule);
  }

  /** Adds a rule: for a project (its admins), or for every project (org admins, project null). */
  add(actor: Participant, input: { project?: string | null; label: string; waitsMilestone?: string | null; waitsLabel?: string | null }): OrderRule {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people set build order rules');
    const label = (input.label ?? '').trim().toLowerCase();
    const milestone = input.waitsMilestone?.trim() || null;
    const waitsLabel = input.waitsLabel?.trim().toLowerCase() || null;
    if (!label || label.length > 40) throw new OrcoError('invalid', 'Name the label that waits (1-40 characters)');
    if ((milestone === null) === (waitsLabel === null)) throw new OrcoError('invalid', 'A rule waits for a milestone or for a label, one of them');
    if (waitsLabel === label) throw new OrcoError('invalid', 'A label cannot wait for itself');
    let projectId: number | null = null;
    if (input.project) {
      const project = this.store.visibleProject(actor, input.project);
      if (this.store.roleIn(actor, project.id) !== 'admin' && !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', `Only admins of ${input.project} add its build order rules`);
      projectId = project.id;
    } else if (!this.store.isOrgAdmin(actor)) {
      throw new OrcoError('forbidden', 'Only org admins set rules for every project; name a project');
    }
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO order_rules (project_id, label, waits_milestone, waits_label, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, label, milestone, waitsLabel, actor.id);
    this.store.audit.record(actor, 'order_rule.add', { projectId, subject: `order_rule:${lastInsertRowid}`, detail: { label, milestone, waitsLabel } });
    this.store.events.emit('ticket', { projectId, ref: null });
    return this.list(actor, input.project ?? undefined).find((r) => r.id === Number(lastInsertRowid))!;
  }

  /** Removes a rule. Org rules only by org admins: a project can tighten the order, never loosen it. */
  remove(actor: Participant, id: number): void {
    const row = this.store.db.prepare('SELECT project_id FROM order_rules WHERE id = ?').get(id) as { project_id: number | null } | undefined;
    if (!row) throw new OrcoError('not_found', `No rule ${id}`);
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people change build order rules');
    if (row.project_id === null) {
      if (!this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'That rule is the org\'s: only org admins remove it');
    } else {
      if (!this.store.canSee(actor, row.project_id)) throw new OrcoError('not_found', `No rule ${id}`);
      if (this.store.roleIn(actor, row.project_id) !== 'admin' && !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only project admins remove its rules');
    }
    this.store.db.prepare('DELETE FROM order_rules WHERE id = ?').run(id);
    this.store.audit.record(actor, 'order_rule.remove', { projectId: row.project_id, subject: `order_rule:${id}` });
    this.store.events.emit('ticket', { projectId: row.project_id, ref: null });
  }

  /**
   * What a ticket with these labels waits on in its project, as a short phrase per rule ("Skeleton"),
   * or [] when nothing holds it. A milestone holds while any of its tickets is open; a missing
   * milestone holds nothing. A label holds while any open ticket other than this one carries it.
   */
  waitsOn(projectId: number, labels: string[], ticketId: number | null, rules = this.forProject(projectId)): string[] {
    const mine = new Set(labels.map((l) => l.toLowerCase()));
    const out: string[] = [];
    for (const rule of rules) {
      if (!mine.has(rule.label)) continue;
      if (rule.waitsMilestone) {
        const open = this.store.db
          .prepare(
            `SELECT count(*) AS n FROM tickets t JOIN milestones m ON m.id = t.milestone_id JOIN ticket_statuses s ON s.id = t.status_id
             WHERE m.project_id = ? AND lower(m.name) = lower(?) AND s.category NOT IN ('completed', 'canceled')`,
          )
          .get(projectId, rule.waitsMilestone) as { n: number };
        if (open.n > 0) out.push(rule.waitsMilestone);
      } else if (rule.waitsLabel) {
        const open = this.store.db
          .prepare(
            `SELECT count(*) AS n FROM tickets t JOIN ticket_labels tl ON tl.ticket_id = t.id JOIN labels l ON l.id = tl.label_id
             JOIN ticket_statuses s ON s.id = t.status_id
             WHERE t.project_id = ? AND lower(l.name) = ? AND s.category NOT IN ('completed', 'canceled') AND t.id IS NOT ?`,
          )
          .get(projectId, rule.waitsLabel, ticketId) as { n: number };
        if (open.n > 0) out.push(`the open "${rule.waitsLabel}" tickets`);
      }
    }
    return [...new Set(out)];
  }

  /** Refuses starting (or handing to an agent) a ticket that waits, saying on what. */
  assertMayStart(projectId: number, labels: string[], ticketId: number | null, ref: string): void {
    const waits = this.waitsOn(projectId, labels, ticketId);
    if (waits.length) throw new OrcoError('conflict', `${ref} waits on ${waits.join(' and ')} (build order rule): finish that first`);
  }

  /** Adds the Skeleton milestone with its checklist, and the rule that ui tickets wait for it. */
  addSkeleton(actor: Participant, project: string): { milestone: string; rule: OrderRule | null } {
    const proj = this.store.visibleProject(actor, project);
    const exists = this.store.db.prepare('SELECT 1 FROM milestones WHERE project_id = ? AND lower(name) = lower(?)').get(proj.id, SKELETON);
    if (!exists) this.store.tickets.createMilestone(actor, project, { name: SKELETON, description: `A working skeleton before any UI:\n${SKELETON_CHECKLIST}` });
    const has = this.forProject(proj.id).some((r) => r.label === 'ui' && r.waitsMilestone?.toLowerCase() === SKELETON.toLowerCase());
    const rule = has ? null : this.add(actor, { project, label: 'ui', waitsMilestone: SKELETON });
    return { milestone: SKELETON, rule };
  }
}
