import { OrcoError } from './errors.js';
import { riskyKinds } from './safety.js';
import type { Participant, Store } from './store.js';

/*
 * Permission modes (#119): how much a ticket's agent may do on its own, on the card.
 *   supervised  ask before any change
 *   auto_edits  code and docs go ahead; anything outward-facing asks
 *   auto        routine actions go ahead; risky ones (safety filter, checked rules) ask
 *   full        everything goes ahead
 * A ticket takes its project's default unless it sets its own. Org and project admins can cap the
 * mode, and a cap names who set it. Deploys and pushes always ask, whatever the mode (#100).
 */

export const MODES = ['supervised', 'auto_edits', 'auto', 'full'] as const;
export type Mode = (typeof MODES)[number];
export const MODE_LABEL: Record<Mode, string> = { supervised: 'Supervised', auto_edits: 'Auto-accept edits', auto: 'Auto', full: 'Full access' };

const OUTWARD = /\b(deploy|push|release|publish|send|email|post|tweet|merge|migrate|delete|drop|payment|charge|invoice|production|prod)\b/i;
const DEPLOY = /\b(deploy(s|ing|ment)?|push(es|ing)?|release|ship(ping)?|roll ?out)\b/i;
const EDIT = /\b(edit|change|fix|refactor|rename|update|write|add|docs?|readme|comment|test|lint|format|code)\b/i;

export interface ModeInfo {
  mode: Mode;
  label: string;
  /** Where it comes from: the ticket, or the project's default. */
  source: 'ticket' | 'project';
  /** The cap that narrowed it, if any: "Supervised, capped by ana (project)". */
  cappedBy: string | null;
}

const rank = (m: Mode) => MODES.indexOf(m);
const check = (m: string): Mode => {
  if (!(MODES as readonly string[]).includes(m)) throw new OrcoError('invalid', `A mode is one of ${MODES.join(', ')}`);
  return m as Mode;
};

export class Modes {
  constructor(private readonly store: Store) {}

  private orgCap(): { mode: Mode; by: string } | null {
    const row = this.store.db.prepare("SELECT value FROM org_settings WHERE key = 'mode_cap'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as { mode: Mode; by: string }) : null;
  }

  /** A ticket's mode: its own or the project's default, narrowed by the project's and the org's caps. */
  forTicket(ticketId: number): ModeInfo {
    const row = this.store.db
      .prepare('SELECT t.mode, p.default_mode, p.mode_cap, u.name AS cap_by FROM tickets t JOIN projects p ON p.id = t.project_id LEFT JOIN participants u ON u.id = p.mode_cap_by WHERE t.id = ?')
      .get(ticketId) as { mode: Mode | null; default_mode: Mode; mode_cap: Mode | null; cap_by: string | null };
    let mode: Mode = row.mode ?? row.default_mode;
    let cappedBy: string | null = null;
    if (row.mode_cap && rank(row.mode_cap) < rank(mode)) {
      mode = row.mode_cap;
      cappedBy = `${row.cap_by ?? 'an admin'} (project)`;
    }
    const org = this.orgCap();
    if (org && rank(org.mode) < rank(mode)) {
      mode = org.mode;
      cappedBy = `${org.by} (org)`;
    }
    return { mode, label: MODE_LABEL[mode], source: row.mode ? 'ticket' : 'project', cappedBy };
  }

  /** People who can change the ticket set its mode, never past a cap. null goes back to the project's default. */
  setTicket(actor: Participant, ref: string, mode: string | null): ModeInfo {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people set a ticket\'s mode');
    const ticket = this.store.tickets.get(actor, ref);
    this.store.assertWrite(actor, ticket.projectId);
    if (mode !== null) this.assertUnderCaps(ticket.projectId, check(mode));
    this.store.db.prepare('UPDATE tickets SET mode = ? WHERE id = ?').run(mode, ticket.id);
    this.store.tickets.note(ticket.id, actor, 'change', null, { changes: [{ field: 'mode', from: null, to: mode ? MODE_LABEL[mode as Mode] : 'project default' }] });
    this.store.audit.record(actor, 'mode.ticket', { projectId: ticket.projectId, subject: `ticket:${ticket.ref}`, detail: { mode } });
    this.store.events.emit('ticket', { projectId: ticket.projectId, ref: ticket.ref });
    return this.forTicket(ticket.id);
  }

  /** Project admins set the default for new and unset tickets, and the project's cap. */
  setProject(actor: Participant, project: string, input: { defaultMode?: string; cap?: string | null }): { defaultMode: Mode; cap: Mode | null } {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people set modes');
    const p = this.store.visibleProject(actor, project);
    if (this.store.roleIn(actor, p.id) !== 'admin' && !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', `Only admins of ${project} set its modes`);
    if (input.cap !== undefined) {
      this.store.db.prepare('UPDATE projects SET mode_cap = ?, mode_cap_by = ? WHERE id = ?').run(input.cap === null ? null : check(input.cap), input.cap === null ? null : actor.id, p.id);
    }
    if (input.defaultMode !== undefined) {
      const mode = check(input.defaultMode);
      this.assertUnderCaps(p.id, mode);
      this.store.db.prepare('UPDATE projects SET default_mode = ? WHERE id = ?').run(mode, p.id);
    }
    this.store.audit.record(actor, 'mode.project', { projectId: p.id, subject: `project:${project}`, detail: input });
    this.store.events.emit('ticket', { projectId: p.id, ref: null });
    return this.project(p.id);
  }

  /** Org admins cap every project (null lifts it). */
  setOrgCap(actor: Participant, cap: string | null): void {
    if (actor.kind !== 'user' || !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins cap modes for every project');
    if (cap === null) this.store.db.prepare("DELETE FROM org_settings WHERE key = 'mode_cap'").run();
    else this.store.db.prepare("INSERT INTO org_settings (key, value) VALUES ('mode_cap', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ mode: check(cap), by: actor.name }));
    this.store.audit.record(actor, 'mode.org_cap', { projectId: null, subject: 'org', detail: { cap } });
  }

  project(projectId: number): { defaultMode: Mode; cap: Mode | null; orgCap: Mode | null } {
    const row = this.store.db.prepare('SELECT default_mode, mode_cap FROM projects WHERE id = ?').get(projectId) as { default_mode: Mode; mode_cap: Mode | null };
    return { defaultMode: row.default_mode, cap: row.mode_cap, orgCap: this.orgCap()?.mode ?? null };
  }

  private assertUnderCaps(projectId: number, mode: Mode): void {
    const { cap } = this.project(projectId);
    const org = this.orgCap();
    if (cap && rank(mode) > rank(cap)) throw new OrcoError('forbidden', `This project caps the mode at ${MODE_LABEL[cap]}`);
    if (org && rank(mode) > rank(org.mode)) throw new OrcoError('forbidden', `${org.by} caps every project at ${MODE_LABEL[org.mode]}`);
  }

  /**
   * Whether an agent's approval request on a ticket goes ahead without asking under the ticket's
   * mode. Deploys and pushes always ask; so does anything a checked rule or the safety filter calls risky
   * below Full access.
   */
  allows(ticketId: number, text: string): { yes: boolean; info: ModeInfo } {
    const info = this.forTicket(ticketId);
    if (DEPLOY.test(text)) return { yes: false, info };
    switch (info.mode) {
      case 'supervised':
        return { yes: false, info };
      case 'auto_edits':
        return { yes: EDIT.test(text) && !OUTWARD.test(text) && riskyKinds(text).length === 0, info };
      case 'auto':
        return { yes: riskyKinds(text).length === 0 && !OUTWARD.test(text), info };
      case 'full':
        return { yes: true, info };
    }
  }
}
