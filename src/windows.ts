import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/*
 * Deploy windows and freezes (#112). A window is a weekly time range for the org or a project:
 * "allow" windows say when production deploys may happen ("Wed 13:00-17:00"), "deny" windows when
 * they never may ("Mon-Fri 06:00-17:00"). Times are in the server's timezone (ORCO_TIMEZONE, or the
 * machine's). A freeze stops deploys and pushes for the org or one project until a time, with a
 * reason. An agent's request_approval of a deploy or push during a freeze is refused with the
 * freeze's reason; outside a window it is flagged on the card for the approver, or refused when the
 * window says so. An admin (a person) can override either with a reason, which is audited.
 */

export const DEPLOY_WORDS = /\b(deploy(s|ing|ment)?|push(es|ing)?|release|ship(ping)?|roll ?out|go live)\b/i;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface DeployWindow {
  id: number;
  project: string | null;
  spec: string;
  mode: 'allow' | 'deny';
  /** Refuse requests outside it (allow) or inside it (deny), instead of flagging them. */
  refuse: boolean;
  by: string;
}

export interface Freeze {
  id: number;
  project: string | null;
  reason: string;
  until: string;
  by: string;
  at: string;
}

interface Parsed {
  days: Set<number>;
  from: number;
  to: number;
}

/** "Wed 13:00-17:00", "Mon-Fri 06:00-17:00", "Sat,Sun 00:00-24:00". */
export function parseWindow(spec: string): Parsed {
  const m = /^\s*([A-Za-z,\- ]+?)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(spec);
  const bad = () => new OrcoError('invalid', 'A window is days and hours, like "Wed 13:00-17:00" or "Mon-Fri 06:00-17:00"');
  if (!m) throw bad();
  const days = new Set<number>();
  for (const part of m[1]!.toLowerCase().split(',').map((p) => p.trim()).filter(Boolean)) {
    const [a, b] = part.split('-').map((d) => DAYS.indexOf(d.trim().slice(0, 3)));
    if (a === undefined || a < 0 || (b !== undefined && b < 0)) throw bad();
    if (b === undefined) days.add(a);
    else for (let d = a; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === b) break;
    }
  }
  const from = Number(m[2]) * 60 + Number(m[3]);
  const to = Number(m[4]) * 60 + Number(m[5]);
  if (!days.size || from >= to || to > 24 * 60) throw bad();
  return { days, from, to };
}

/** The weekday (0 = Sunday) and minute of the day at a moment, in a timezone. */
export function localTime(ms: number, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { day: DAYS.indexOf(get('weekday').toLowerCase().slice(0, 3)), minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

const inside = (w: Parsed, t: { day: number; minute: number }) => w.days.has(t.day) && t.minute >= w.from && t.minute < w.to;

export class DeployWindows {
  constructor(private readonly store: Store) {}

  get timeZone(): string {
    return process.env.ORCO_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  windows(projectId: number | null): DeployWindow[] {
    return this.store.db
      .prepare(
        `SELECT w.id, p.name AS project, w.spec, w.mode, w.refuse, u.name AS by FROM deploy_windows w LEFT JOIN projects p ON p.id = w.project_id
         JOIN participants u ON u.id = w.created_by WHERE w.project_id IS NULL OR w.project_id IS ? ORDER BY w.project_id IS NOT NULL, w.id`,
      )
      .all(projectId)
      .map((r) => {
        const row = r as unknown as Omit<DeployWindow, 'refuse'> & { refuse: number };
        return { id: row.id, project: row.project, spec: row.spec, mode: row.mode, refuse: row.refuse === 1, by: row.by };
      });
  }

  /** Freezes in force now for a project (the org's and its own), or all of them for the org view. */
  freezes(projectId?: number | null): Freeze[] {
    const now = new Date(this.store.now()).toISOString();
    const rows = this.store.db
      .prepare(
        `SELECT f.id, p.name AS project, f.reason, f.until, u.name AS by, f.created_at AS at FROM freezes f LEFT JOIN projects p ON p.id = f.project_id
         JOIN participants u ON u.id = f.set_by WHERE f.ended_at IS NULL AND f.until > ? ${projectId === undefined ? '' : 'AND (f.project_id IS NULL OR f.project_id IS ?)'} ORDER BY f.until`,
      )
      .all(...(projectId === undefined ? [now] : [now, projectId])) as unknown as Freeze[];
    return rows;
  }

  /** Freezes the actor can see: the org's and their projects'. */
  visibleFreezes(actor: Participant): Freeze[] {
    return this.freezes().filter((f) => f.project === null || (() => {
      try {
        this.store.visibleProject(actor, f.project);
        return true;
      } catch {
        return false;
      }
    })());
  }

  addWindow(actor: Participant, input: { project?: string | null; spec: string; mode?: 'allow' | 'deny'; refuse?: boolean }): DeployWindow {
    const projectId = this.admin(actor, input.project);
    parseWindow(input.spec);
    const mode = input.mode === 'deny' ? 'deny' : 'allow';
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO deploy_windows (project_id, spec, mode, refuse, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, input.spec.trim(), mode, input.refuse ? 1 : 0, actor.id);
    this.store.audit.record(actor, 'deploy_window.add', { projectId, subject: `deploy_window:${lastInsertRowid}`, detail: { spec: input.spec, mode, refuse: !!input.refuse } });
    return this.windows(projectId).find((w) => w.id === Number(lastInsertRowid))!;
  }

  removeWindow(actor: Participant, id: number): void {
    const row = this.store.db.prepare('SELECT w.project_id, p.name FROM deploy_windows w LEFT JOIN projects p ON p.id = w.project_id WHERE w.id = ?').get(id) as { project_id: number | null; name: string | null } | undefined;
    if (!row) throw new OrcoError('not_found', `No window ${id}`);
    this.admin(actor, row.name);
    this.store.db.prepare('DELETE FROM deploy_windows WHERE id = ?').run(id);
    this.store.audit.record(actor, 'deploy_window.remove', { projectId: row.project_id, subject: `deploy_window:${id}` });
  }

  freeze(actor: Participant, input: { project?: string | null; reason: string; until: string }): Freeze {
    const projectId = this.admin(actor, input.project);
    const reason = (input.reason ?? '').trim().replace(/\s+/g, ' ');
    if (!reason || reason.length > 200) throw new OrcoError('invalid', 'Give the freeze a one-line reason');
    const until = Date.parse(input.until);
    if (Number.isNaN(until) || until <= this.store.now()) throw new OrcoError('invalid', 'until is a time in the future');
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO freezes (project_id, reason, until, set_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, reason, new Date(until).toISOString(), actor.id, new Date(this.store.now()).toISOString());
    this.store.audit.record(actor, 'freeze.start', { projectId, subject: `freeze:${lastInsertRowid}`, detail: { reason, until: new Date(until).toISOString() } });
    this.store.events.emit('controls', { kind: 'freeze' });
    return this.freezes().find((f) => f.id === Number(lastInsertRowid))!;
  }

  unfreeze(actor: Participant, id: number): void {
    const row = this.store.db.prepare('SELECT f.project_id, p.name FROM freezes f LEFT JOIN projects p ON p.id = f.project_id WHERE f.id = ?').get(id) as { project_id: number | null; name: string | null } | undefined;
    if (!row) throw new OrcoError('not_found', `No freeze ${id}`);
    this.admin(actor, row.name);
    this.store.db.prepare('UPDATE freezes SET ended_at = ? WHERE id = ?').run(new Date(this.store.now()).toISOString(), id);
    this.store.audit.record(actor, 'freeze.end', { projectId: row.project_id, subject: `freeze:${id}` });
    this.store.events.emit('controls', { kind: 'freeze' });
  }

  /**
   * Checks a deploy or push request against freezes and windows. Returns a warning for the card, or
   * throws when it is refused. An admin's override (a reason) lets it through, and is audited.
   */
  check(actor: Participant, projectId: number | null, text: string, override?: string | null): string | null {
    if (!DEPLOY_WORDS.test(text)) return null;
    const reason = override?.trim().replace(/\s+/g, ' ').slice(0, 200) || null;
    const overridable = reason && actor.kind === 'user' && (this.store.isOrgAdmin(actor) || (projectId !== null && this.store.roleIn(actor, projectId) === 'admin'));
    if (reason && !overridable) throw new OrcoError('forbidden', 'Only an org or project admin (a person) overrides a freeze or deploy window');
    const freeze = this.freezes(projectId)[0];
    if (freeze) {
      if (!overridable) throw new OrcoError('conflict', `Deploys and pushes are frozen until ${freeze.until} (${freeze.by}: ${freeze.reason}).`);
      this.store.audit.record(actor, 'freeze.override', { projectId, subject: `freeze:${freeze.id}`, detail: { reason, request: text.slice(0, 200) } });
      return `Approved during a freeze (${freeze.reason}); override by ${actor.name}: ${reason}`;
    }
    const windows = this.windows(projectId);
    if (!windows.length) return null;
    const now = localTime(this.store.now(), this.timeZone);
    const allows = windows.filter((w) => w.mode === 'allow');
    const inAllow = allows.some((w) => inside(parseWindow(w.spec), now));
    const deny = windows.find((w) => w.mode === 'deny' && inside(parseWindow(w.spec), now));
    const outside = deny ? `inside the no-deploy window ${deny.spec}` : allows.length && !inAllow ? `outside the deploy window (${allows.map((w) => w.spec).join(', ')})` : null;
    if (!outside) return null;
    const refuse = deny ? deny.refuse : allows.some((w) => w.refuse);
    if (refuse && !overridable) throw new OrcoError('conflict', `Not now: this is ${outside}, ${this.timeZone} time. An admin can override with a reason.`);
    if (overridable) this.store.audit.record(actor, 'deploy_window.override', { projectId, subject: 'deploy_window', detail: { reason, request: text.slice(0, 200) } });
    return `${outside[0]!.toUpperCase()}${outside.slice(1)}${overridable ? `; override by ${actor.name}: ${reason}` : ''}`;
  }

  private admin(actor: Participant, project: string | null | undefined): number | null {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people set deploy windows and freezes');
    if (!project) {
      if (!this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins set them for the whole org; name a project');
      return null;
    }
    const p = this.store.visibleProject(actor, project);
    if (this.store.roleIn(actor, p.id) !== 'admin' && !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', `Only admins of ${project} set its deploy windows and freezes`);
    return p.id;
  }
}
