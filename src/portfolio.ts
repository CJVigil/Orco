import { nextRun, parseCron } from './cron.js';
import type { Pause } from './controls.js';
import type { Participant, Store } from './store.js';

export type Health = 'green' | 'amber' | 'red';
export type MilestoneStatus = 'done' | 'late' | 'at_risk' | 'on_track' | 'no_date';

export interface ProjectHealth {
  project: string;
  /** Your role, or null when you see it as an org admin without being a member. */
  role: string | null;
  health: Health;
  /** Why it is not green, most serious first. */
  reasons: string[];
  tickets: { open: number; blocked: number; overdue: number; doneThisWeek: number };
  milestone: RoadmapMilestone | null;
  agents: { working: number; waiting: number; stalled: number };
  approvals: { waiting: number; waitingOnYou: number; oldestHours: number | null };
  ci: { source: string; state: 'success' | 'failure' | 'pending'; summary: string; at: string }[];
  spend: { weekCents: number; monthCents: number; budgetCents: number | null; budgetPercent: number | null };
  paused: Pause | null;
  lastActivity: string | null;
}

export interface Portfolio {
  projects: ProjectHealth[];
  totals: { projects: number; red: number; amber: number; green: number; weekCents: number; working: number; waitingOnYou: number };
}

export interface ExternalBlocker {
  /** The blocked ticket in this milestone, and the ticket in another project it waits on. */
  ticket: string;
  blocker: string;
  blockerTitle: string;
  blockerProject: string;
  blockerMilestone: string | null;
  blockerDue: string | null;
}

export interface RoadmapMilestone {
  id: number;
  project: string;
  name: string;
  targetDate: string | null;
  done: number;
  total: number;
  status: MilestoneStatus;
  /** Why it is late or at risk. */
  why: string[];
  waitsOn: ExternalBlocker[];
}

const CLOSED = "('completed', 'canceled')";
const DAY = 86_400_000;
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * The view across projects for whoever runs many of them: health per project, a roadmap of
 * milestones with the cross-project tickets they wait on, and a weekly digest. Members see their
 * projects; org admins see all of them, member or not. Everything comes from Orco's own data.
 */
export class Portfolios {
  constructor(private readonly store: Store) {}

  /** Projects in the actor's portfolio. */
  projects(actor: Participant): { id: number; name: string }[] {
    if (this.store.isOrgAdmin(actor)) return this.store.db.prepare('SELECT id, name FROM projects ORDER BY name').all() as { id: number; name: string }[];
    const visible = this.store.projectFilter(actor, 'id');
    return this.store.db.prepare(`SELECT id, name FROM projects WHERE ${visible.sql} ORDER BY name`).all(...visible.params) as { id: number; name: string }[];
  }

  overview(actor: Participant): Portfolio {
    const roadmap = this.roadmap(actor);
    const projects = this.projects(actor).map((p) => this.health(actor, p, roadmap));
    const order: Record<Health, number> = { red: 0, amber: 1, green: 2 };
    projects.sort((a, b) => order[a.health] - order[b.health] || a.project.localeCompare(b.project));
    return {
      projects,
      totals: {
        projects: projects.length,
        red: projects.filter((p) => p.health === 'red').length,
        amber: projects.filter((p) => p.health === 'amber').length,
        green: projects.filter((p) => p.health === 'green').length,
        weekCents: projects.reduce((n, p) => n + p.spend.weekCents, 0),
        working: projects.reduce((n, p) => n + p.agents.working, 0),
        waitingOnYou: projects.reduce((n, p) => n + p.approvals.waitingOnYou, 0),
      },
    };
  }

  private health(actor: Participant, project: { id: number; name: string }, roadmap: RoadmapMilestone[]): ProjectHealth {
    const db = this.store.db;
    const now = this.store.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const weekAgo = new Date(now - 7 * DAY).toISOString();
    const tickets = db
      .prepare(
        `SELECT
           sum(s.category NOT IN ${CLOSED}) AS open,
           sum(s.category NOT IN ${CLOSED} AND (t.blocked_reason != '' OR EXISTS (
             SELECT 1 FROM ticket_links l JOIN tickets b ON b.id = l.blocker_id JOIN ticket_statuses bs ON bs.id = b.status_id
             WHERE l.blocked_id = t.id AND bs.category NOT IN ${CLOSED}))) AS blocked,
           sum(s.category NOT IN ${CLOSED} AND t.due_date IS NOT NULL AND t.due_date < ?) AS overdue,
           sum(s.category = 'completed' AND t.completed_at >= ?) AS done_week
         FROM tickets t JOIN ticket_statuses s ON s.id = t.status_id WHERE t.project_id = ?`,
      )
      .get(today, weekAgo, project.id) as { open: number | null; blocked: number | null; overdue: number | null; done_week: number | null };
    const agents = db
      .prepare(
        `SELECT sum(t.state = 'accepted') AS working, sum(t.state IN ('requested', 'awaiting_approval')) AS waiting,
           sum(t.state = 'accepted' AND t.stall_notified = 1) AS stalled
         FROM tasks t JOIN rooms r ON r.id = t.room_id WHERE r.project_id = ?`,
      )
      .get(project.id) as { working: number | null; waiting: number | null; stalled: number | null };
    const approvals = db
      .prepare(
        `SELECT count(*) AS waiting, sum(a.approver_id = ?) AS mine, min(a.created_at) AS oldest
         FROM approvals a JOIN rooms r ON r.id = a.room_id WHERE r.project_id = ? AND a.state = 'pending' AND a.expires_at > ?`,
      )
      .get(actor.id, project.id, now) as { waiting: number; mine: number | null; oldest: number | null };
    const ci = (db.prepare('SELECT source, state, summary, updated_at FROM ci_status WHERE project_id = ? ORDER BY state = \'failure\' DESC, updated_at DESC').all(project.id) as {
      source: string;
      state: 'success' | 'failure' | 'pending';
      summary: string;
      updated_at: string;
    }[]).map((c) => ({ source: c.source, state: c.state, summary: c.summary, at: c.updated_at }));
    const week = db
      .prepare('SELECT coalesce(sum(cents), 0) AS cents FROM spend WHERE project_id = ? AND created_at >= ?')
      .get(project.id, weekAgo) as { cents: number };
    const monthCents = this.store.controls.spentThisMonth('project', project.id);
    const budget = db.prepare("SELECT monthly_cents FROM budgets WHERE scope = 'project' AND target_id = ?").get(project.id) as { monthly_cents: number } | undefined;
    const last = db
      .prepare('SELECT max(m.created_at) AS at FROM messages m JOIN rooms r ON r.id = m.room_id WHERE r.project_id = ?')
      .get(project.id) as { at: string | null };
    const paused = this.pauseOf(project.id);
    const milestone = roadmap.find((m) => m.project === project.name && m.status !== 'done') ?? null;

    const t = { open: tickets.open ?? 0, blocked: tickets.blocked ?? 0, overdue: tickets.overdue ?? 0, doneThisWeek: tickets.done_week ?? 0 };
    const a = { working: agents.working ?? 0, waiting: agents.waiting ?? 0, stalled: agents.stalled ?? 0 };
    const oldestHours = approvals.oldest === null ? null : Math.floor((now - approvals.oldest) / 3_600_000);
    const budgetPercent = budget ? Math.round((monthCents / budget.monthly_cents) * 100) : null;

    const red: string[] = [];
    const amber: string[] = [];
    for (const c of ci.filter((c) => c.state === 'failure')) red.push(`CI failing: ${c.source}`);
    if (a.stalled) red.push(`${a.stalled} stalled agent task${a.stalled === 1 ? '' : 's'}`);
    if (budgetPercent !== null && budgetPercent >= 100) red.push(`over its monthly budget (${money(monthCents)} of ${money(budget!.monthly_cents)})`);
    if (milestone?.status === 'late') red.push(`milestone ${milestone.name} is past its date (${milestone.done}/${milestone.total} done)`);
    if (paused) amber.push(`agents paused by ${paused.by}${paused.reason ? `: ${paused.reason}` : ''}`);
    if (milestone?.status === 'at_risk') amber.push(`milestone ${milestone.name} at risk: ${milestone.why[0] ?? ''}`.trim());
    if (t.overdue) amber.push(`${t.overdue} overdue ticket${t.overdue === 1 ? '' : 's'}`);
    if (t.blocked) amber.push(`${t.blocked} blocked ticket${t.blocked === 1 ? '' : 's'}`);
    if (oldestHours !== null && oldestHours >= 24) amber.push(`an approval has waited ${oldestHours} hours`);
    if (budgetPercent !== null && budgetPercent >= 80 && budgetPercent < 100) amber.push(`${budgetPercent}% of its monthly budget used`);

    return {
      project: project.name,
      role: this.store.roleIn(actor, project.id),
      health: red.length ? 'red' : amber.length ? 'amber' : 'green',
      reasons: [...red, ...amber],
      tickets: t,
      milestone,
      agents: a,
      approvals: { waiting: approvals.waiting, waitingOnYou: approvals.mine ?? 0, oldestHours },
      ci,
      spend: { weekCents: week.cents, monthCents, budgetCents: budget?.monthly_cents ?? null, budgetPercent },
      paused,
      lastActivity: last.at,
    };
  }

  /**
   * Milestones across the actor's projects, by date, with what they wait on in other projects. A
   * milestone is late once its date passes with work open, and at risk when it waits on a ticket in
   * another project that is due later, has no date, or sits in a late milestone, or when it is due
   * within a week with most of its work still open.
   */
  roadmap(actor: Participant): RoadmapMilestone[] {
    const ids = this.projects(actor).map((p) => p.id);
    if (!ids.length) return [];
    // What this viewer's portfolio covers (an org admin's covers every project).
    const visible = new Set(ids);
    const db = this.store.db;
    const now = this.store.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const soon = new Date(now + 7 * DAY).toISOString().slice(0, 10);
    const rows = db
      .prepare(
        `SELECT m.id, p.name AS project, m.name, m.target_date,
           (SELECT count(*) FROM tickets t WHERE t.milestone_id = m.id) AS total,
           (SELECT count(*) FROM tickets t JOIN ticket_statuses s ON s.id = t.status_id WHERE t.milestone_id = m.id AND s.category IN ${CLOSED}) AS done
         FROM milestones m JOIN projects p ON p.id = m.project_id
         WHERE m.project_id IN (${ids.map(() => '?').join(',')})
         ORDER BY m.target_date IS NULL, m.target_date, p.name, m.name`,
      )
      .all(...ids) as { id: number; project: string; name: string; target_date: string | null; total: number; done: number }[];
    const blockers = db.prepare(
      `SELECT bp.ticket_key || '-' || t.number AS ticket, kp.ticket_key || '-' || b.number AS blocker, b.title AS blocker_title, kp.name AS blocker_project, kp.id AS blocker_project_id,
         bm.id AS blocker_milestone_id, bm.name AS blocker_milestone, coalesce(b.due_date, bm.target_date) AS blocker_due
       FROM tickets t
       JOIN ticket_statuses ts ON ts.id = t.status_id
       JOIN projects bp ON bp.id = t.project_id
       JOIN ticket_links l ON l.blocked_id = t.id
       JOIN tickets b ON b.id = l.blocker_id
       JOIN ticket_statuses bs ON bs.id = b.status_id
       JOIN projects kp ON kp.id = b.project_id
       LEFT JOIN milestones bm ON bm.id = b.milestone_id
       WHERE t.milestone_id = ? AND ts.category NOT IN ${CLOSED} AND bs.category NOT IN ${CLOSED} AND b.project_id != t.project_id`,
    );
    const lateIds = new Set(rows.filter((r) => r.target_date !== null && r.target_date < today && r.done < r.total).map((r) => r.id));
    return rows.map((r) => {
      // A blocker in a project the viewer cannot see still counts toward the risk, but stays anonymous.
      const waits = (
        blockers.all(r.id) as {
          ticket: string;
          blocker: string;
          blocker_title: string;
          blocker_project: string;
          blocker_project_id: number;
          blocker_milestone_id: number | null;
          blocker_milestone: string | null;
          blocker_due: string | null;
        }[]
      ).map((w) =>
        visible.has(w.blocker_project_id)
          ? w
          : { ...w, blocker: 'a ticket', blocker_title: '', blocker_project: 'another project', blocker_milestone: w.blocker_milestone === null ? null : 'its milestone' },
      );
      const waitsOn: ExternalBlocker[] = waits.map((w) => ({
        ticket: w.ticket,
        blocker: w.blocker,
        blockerTitle: w.blocker_title,
        blockerProject: w.blocker_project,
        blockerMilestone: w.blocker_milestone,
        blockerDue: w.blocker_due,
      }));
      let status: MilestoneStatus;
      const why: string[] = [];
      if (r.total > 0 && r.done === r.total) status = 'done';
      else if (r.target_date === null) status = 'no_date';
      else if (r.target_date < today) {
        status = 'late';
        why.push(`was due ${r.target_date}`);
      } else {
        for (const w of waits) {
          if (w.blocker_milestone_id !== null && lateIds.has(w.blocker_milestone_id)) why.push(`${w.ticket} waits on ${w.blocker} in ${w.blocker_project}, whose milestone ${w.blocker_milestone} is late`);
          else if (w.blocker_due === null) why.push(`${w.ticket} waits on ${w.blocker} in ${w.blocker_project}, which has no date`);
          else if (w.blocker_due > r.target_date) why.push(`${w.ticket} waits on ${w.blocker} in ${w.blocker_project}, due ${w.blocker_due}`);
        }
        if (r.target_date <= soon && r.total > 0 && r.done * 2 < r.total) why.push(`due ${r.target_date} with ${r.total - r.done} of ${r.total} tickets open`);
        status = why.length ? 'at_risk' : 'on_track';
      }
      return { id: r.id, project: r.project, name: r.name, targetDate: r.target_date, done: r.done, total: r.total, status, why, waitsOn };
    });
  }

  /** A project's digest for the week ending now, as Markdown. */
  projectDigest(projectId: number): string {
    const db = this.store.db;
    const now = this.store.now();
    const weekAgo = new Date(now - 7 * DAY).toISOString();
    const nextWeek = new Date(now + 7 * DAY).toISOString().slice(0, 10);
    const today = new Date(now).toISOString().slice(0, 10);
    const name = (db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string }).name;
    const key = (db.prepare('SELECT ticket_key FROM projects WHERE id = ?').get(projectId) as { ticket_key: string | null }).ticket_key ?? name.toUpperCase();
    const lines: string[] = [`**Weekly digest · ${name} · week to ${today}**`];

    const shipped = db
      .prepare(
        `SELECT t.number, t.title, k.links FROM tickets t JOIN ticket_statuses s ON s.id = t.status_id LEFT JOIN tasks k ON k.id = t.task_id
         WHERE t.project_id = ? AND s.category = 'completed' AND t.completed_at >= ? ORDER BY t.completed_at`,
      )
      .all(projectId, weekAgo) as { number: number; title: string; links: string | null }[];
    lines.push('', `**Shipped (${shipped.length})**`);
    if (!shipped.length) lines.push('- Nothing closed this week.');
    for (const t of shipped.slice(0, 20)) {
      const links = (JSON.parse(t.links ?? '[]') as { url: string; title?: string }[]).map((l) => `[${l.title || 'link'}](${l.url})`);
      lines.push(`- ${key}-${t.number} ${t.title}${links.length ? ` · ${links.join(', ')}` : ''}`);
    }
    if (shipped.length > 20) lines.push(`- … and ${shipped.length - 20} more`);

    const blocked = db
      .prepare(
        `SELECT t.id, t.number, t.title, t.blocked_reason FROM tickets t JOIN ticket_statuses s ON s.id = t.status_id
         WHERE t.project_id = ? AND s.category NOT IN ${CLOSED} AND (t.blocked_reason != '' OR EXISTS (
           SELECT 1 FROM ticket_links l JOIN tickets b ON b.id = l.blocker_id JOIN ticket_statuses bs ON bs.id = b.status_id
           WHERE l.blocked_id = t.id AND bs.category NOT IN ${CLOSED})) ORDER BY t.priority DESC, t.number LIMIT 15`,
      )
      .all(projectId) as { id: number; number: number; title: string; blocked_reason: string }[];
    const waitsOn = db.prepare(
      `SELECT p.ticket_key || '-' || b.number AS ref, b.project_id FROM ticket_links l JOIN tickets b ON b.id = l.blocker_id JOIN projects p ON p.id = b.project_id
       JOIN ticket_statuses bs ON bs.id = b.status_id WHERE l.blocked_id = ? AND bs.category NOT IN ${CLOSED}`,
    );
    if (blocked.length) {
      lines.push('', `**Blocked (${blocked.length})**`);
      for (const t of blocked) {
        // Everyone in the project reads the digest, so blockers elsewhere are not named.
        const refs = (waitsOn.all(t.id) as { ref: string; project_id: number }[]).map((w) => (w.project_id === projectId ? w.ref : 'a ticket in another project'));
        const why = [refs.length ? `waits on ${refs.join(', ')}` : '', t.blocked_reason].filter(Boolean).join('; ');
        lines.push(`- ${key}-${t.number} ${t.title}${why ? ` — ${why}` : ''}`);
      }
    }

    const decisions = db
      .prepare('SELECT id, title, decision FROM decisions WHERE project_id = ? AND created_at >= ? ORDER BY id')
      .all(projectId, weekAgo) as { id: number; title: string; decision: string }[];
    if (decisions.length) {
      lines.push('', `**Decisions (${decisions.length})**`);
      for (const d of decisions) lines.push(`- #${d.id} ${d.title}: ${d.decision.replace(/\s+/g, ' ').slice(0, 200)}`);
    }

    const agents = db
      .prepare(
        `SELECT a.name, sum(t.state = 'done') AS done, sum(t.state = 'failed') AS failed, coalesce(sum(t.spent_cents), 0) AS cents
         FROM tasks t JOIN rooms r ON r.id = t.room_id JOIN participants a ON a.id = t.assignee_id
         WHERE r.project_id = ? AND t.updated_at >= ? GROUP BY a.id ORDER BY done DESC`,
      )
      .all(projectId, weekAgo) as { name: string; done: number; failed: number; cents: number }[];
    if (agents.length) {
      lines.push('', '**Agents**');
      for (const a of agents) lines.push(`- ${a.name}: ${a.done} done${a.failed ? `, ${a.failed} failed` : ''}${a.cents ? ` · ${money(a.cents)}` : ''}`);
    }

    const due = db
      .prepare(
        `SELECT m.name, m.target_date,
           (SELECT count(*) FROM tickets t WHERE t.milestone_id = m.id) AS total,
           (SELECT count(*) FROM tickets t JOIN ticket_statuses s ON s.id = t.status_id WHERE t.milestone_id = m.id AND s.category IN ${CLOSED}) AS done
         FROM milestones m WHERE m.project_id = ? AND m.target_date IS NOT NULL AND m.target_date <= ? AND m.target_date >= ? ORDER BY m.target_date`,
      )
      .all(projectId, nextWeek, today) as { name: string; target_date: string; total: number; done: number }[];
    const dueTickets = db
      .prepare(
        `SELECT t.number, t.title, t.due_date FROM tickets t JOIN ticket_statuses s ON s.id = t.status_id
         WHERE t.project_id = ? AND s.category NOT IN ${CLOSED} AND t.due_date IS NOT NULL AND t.due_date <= ? ORDER BY t.due_date LIMIT 10`,
      )
      .all(projectId, nextWeek) as { number: number; title: string; due_date: string }[];
    if (due.length || dueTickets.length) {
      lines.push('', '**Due this week**');
      for (const m of due) lines.push(`- Milestone ${m.name} (${m.target_date}): ${m.done}/${m.total} done`);
      for (const t of dueTickets) lines.push(`- ${key}-${t.number} ${t.title} (${t.due_date}${t.due_date < today ? ', overdue' : ''})`);
    }

    const week = db
      .prepare('SELECT coalesce(sum(cents), 0) AS cents FROM spend WHERE project_id = ? AND created_at >= ?')
      .get(projectId, weekAgo) as { cents: number };
    const month = this.store.controls.spentThisMonth('project', projectId);
    const budget = db.prepare("SELECT monthly_cents FROM budgets WHERE scope = 'project' AND target_id = ?").get(projectId) as { monthly_cents: number } | undefined;
    if (week.cents || budget) {
      lines.push('', `**Spend:** ${money(week.cents)} this week · ${money(month)}${budget ? ` of ${money(budget.monthly_cents)}` : ''} this month`);
    }
    return lines.join('\n');
  }

  /** One line per project for org admins: health, why, what shipped and spend. */
  orgDigest(admin: Participant): string {
    const overview = this.overview(admin);
    const word: Record<Health, string> = { red: 'Red', amber: 'Amber', green: 'Green' };
    const lines = [`**Weekly digest · all projects · week to ${new Date(this.store.now()).toISOString().slice(0, 10)}**`, ''];
    lines.push(`${overview.totals.projects} projects: ${overview.totals.red} red, ${overview.totals.amber} amber, ${overview.totals.green} green · ${money(overview.totals.weekCents)} spent this week`, '');
    for (const p of overview.projects) {
      const why = p.reasons.length ? `: ${p.reasons.slice(0, 2).join('; ')}` : '';
      lines.push(`- **${p.project}** ${word[p.health]}${why} · ${p.tickets.doneThisWeek} shipped · ${money(p.spend.weekCents)}`);
    }
    return lines.join('\n');
  }

  /** The digests already written, newest first, for the actor's projects (and the org roll-up for org admins). */
  digests(actor: Participant, limit = 20): { project: string | null; week: string; body: string; at: string }[] {
    const ids = this.projects(actor).map((p) => p.id);
    const admin = this.store.isOrgAdmin(actor);
    const rows = this.store.db
      .prepare('SELECT d.project_id, p.name AS project, d.week, d.body, d.created_at FROM digests d LEFT JOIN projects p ON p.id = d.project_id ORDER BY d.id DESC LIMIT 500')
      .all() as { project_id: number | null; project: string | null; week: string; body: string; created_at: string }[];
    return rows
      .filter((r) => (r.project_id === null ? admin : ids.includes(r.project_id)))
      .slice(0, limit)
      .map((r) => ({ project: r.project, week: r.week, body: r.body, at: r.created_at }));
  }

  /**
   * Writes the week's digests when the digest schedule comes round (ORCO_DIGEST, default Monday 9:00
   * in ORCO_DIGEST_TZ): one in each project's #general (or nowhere if the project has no such room),
   * and the roll-up for org admins, kept for the dashboard. Runs at most once per scheduled time.
   */
  runDue(schedule: { cron: string; tz: string } | null): number {
    if (!schedule) return 0;
    const now = this.store.now();
    const cron = parseCron(schedule.cron);
    let fire: number | null = null;
    for (let at = nextRun(cron, now - 8 * DAY, schedule.tz); at <= now; at = nextRun(cron, at, schedule.tz)) fire = at;
    // Only the most recent time, and only within a day of it: a server started mid-week does not post late digests.
    if (fire === null || now - fire > DAY) return 0;
    const week = new Date(fire).toISOString().slice(0, 16);
    if (this.store.db.prepare('SELECT 1 FROM digests WHERE project_id IS NULL AND week = ?').get(week)) return 0;
    const system = this.store.system();
    let written = 0;
    for (const project of this.store.db.prepare('SELECT id, name FROM projects ORDER BY name').all() as { id: number; name: string }[]) {
      const body = this.projectDigest(project.id);
      const inserted = this.store.db.prepare('INSERT OR IGNORE INTO digests (project_id, week, body) VALUES (?, ?, ?)').run(project.id, week, body);
      if (Number(inserted.changes) === 0) continue;
      written++;
      const hasGeneral = this.store.db.prepare("SELECT 1 FROM rooms WHERE project_id = ? AND name = 'general'").get(project.id);
      if (system && hasGeneral) this.store.post(system, `${project.name}/general`, body, undefined, { skipRateLimit: true });
    }
    const admins = this.store.orgAdmins();
    const rollup = admins.length ? this.orgDigest(admins[0]!) : '';
    this.store.db.prepare('INSERT OR IGNORE INTO digests (project_id, week, body) VALUES (NULL, ?, ?)').run(week, rollup);
    this.store.audit.record(null, 'digest.write', { detail: { week, projects: written } });
    this.store.events.emit('controls', { kind: 'digest' });
    return written;
  }

  private pauseOf(projectId: number): Pause | null {
    const row = this.store.db
      .prepare(
        `SELECT x.scope, u.name AS by_name, x.reason, x.created_at FROM pauses x JOIN participants u ON u.id = x.by_id
         WHERE x.scope = 'all' OR (x.scope = 'project' AND x.target_id = ?) ORDER BY x.scope = 'all' DESC LIMIT 1`,
      )
      .get(projectId) as { scope: 'all' | 'project'; by_name: string; reason: string; created_at: string } | undefined;
    if (!row) return null;
    return { scope: row.scope, target: null, by: row.by_name, reason: row.reason, at: row.created_at };
  }
}
