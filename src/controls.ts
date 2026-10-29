import { OrcoError } from './errors.js';
import type { Participant, Room, Store } from './store.js';

export type BudgetScope = 'project' | 'agent';
export type PauseScope = 'all' | 'project' | 'agent';

export interface Budget {
  scope: BudgetScope;
  /** The project or agent name. */
  target: string;
  monthlyCents: number;
  spentCents: number;
  /** Whole percent of the cap spent this month. */
  percent: number;
  setBy: string;
}

export interface Pause {
  scope: PauseScope;
  /** The project or agent name; null when everything is paused. */
  target: string | null;
  by: string;
  reason: string;
  at: string;
}

interface BudgetRow {
  id: number;
  scope: BudgetScope;
  target_id: number;
  monthly_cents: number;
  set_by: number;
  setter: string;
}

const MAX_CENTS = 100_000_000;
const MAX_REASON = 300;

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Spending caps and the kill switch.
 *
 * Budgets cap what a project or an agent spends per calendar month (UTC), counting what its tasks
 * cost (bridge run reports and agents' own reports). At 80% the person who set the budget is told
 * once; past the cap, new tasks wait for that person's approval instead of starting.
 *
 * Pauses stop agents: all of them (org admins), one project's (its admins) or one agent (its owner).
 * A paused agent cannot accept tasks, post, or change anything; it can still finish or fail what it
 * holds. Bridges stop running agents and start nothing until the pause is lifted.
 */
export class Controls {
  constructor(private readonly store: Store) {}

  /* Budgets */

  setBudget(actor: Participant, scope: BudgetScope, name: string, monthlyCents: number | null): Budget | null {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people set budgets');
    const targetId = this.budgetTarget(actor, scope, name);
    if (monthlyCents === null) {
      this.store.db.prepare('DELETE FROM budgets WHERE scope = ? AND target_id = ?').run(scope, targetId);
      this.store.audit.record(actor, 'budget.clear', { projectId: scope === 'project' ? targetId : null, subject: `${scope}:${name}` });
      this.store.events.emit('controls', { kind: 'budget' });
      return null;
    }
    if (!Number.isInteger(monthlyCents) || monthlyCents < 100 || monthlyCents > MAX_CENTS) {
      throw new OrcoError('invalid', `A monthly budget is $1 to ${money(MAX_CENTS)}, in whole cents`);
    }
    this.store.db
      .prepare(
        `INSERT INTO budgets (scope, target_id, monthly_cents, set_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (scope, target_id) DO UPDATE SET monthly_cents = excluded.monthly_cents, set_by = excluded.set_by,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(scope, targetId, monthlyCents, actor.id);
    // A raised cap may be under the alert levels again; let them fire anew this month.
    this.store.db.prepare('DELETE FROM budget_alerts WHERE budget_id = (SELECT id FROM budgets WHERE scope = ? AND target_id = ?)').run(scope, targetId);
    this.store.audit.record(actor, 'budget.set', { projectId: scope === 'project' ? targetId : null, subject: `${scope}:${name}`, detail: { monthlyCents } });
    this.store.events.emit('controls', { kind: 'budget' });
    return this.toBudget(this.budgetRow(scope, targetId)!);
  }

  /** Budgets the actor may see: their projects' and their agents' (org admins: all). */
  budgets(actor: Participant): Budget[] {
    const admin = this.store.isOrgAdmin(actor);
    const rows = this.store.db
      .prepare('SELECT b.id, b.scope, b.target_id, b.monthly_cents, b.set_by, u.name AS setter FROM budgets b JOIN participants u ON u.id = b.set_by')
      .all() as unknown as BudgetRow[];
    return rows
      .filter((r) => {
        if (admin) return true;
        if (r.scope === 'project') return this.store.canSee(actor, r.target_id);
        const agent = this.store.participantById(r.target_id);
        return agent !== null && (agent.id === actor.id || agent.ownerId === this.store.humanOf(actor));
      })
      .map((r) => this.toBudget(r))
      .sort((a, b) => b.percent - a.percent);
  }

  /** What a project or agent has spent this month, in cents. */
  spentThisMonth(scope: BudgetScope, targetId: number): number {
    const since = this.monthStart();
    const row = (
      scope === 'project'
        ? this.store.db
            .prepare('SELECT coalesce(sum(t.spent_cents), 0) AS cents FROM tasks t JOIN rooms r ON r.id = t.room_id WHERE r.project_id = ? AND t.created_at >= ?')
            .get(targetId, since)
        : this.store.db.prepare('SELECT coalesce(sum(spent_cents), 0) AS cents FROM tasks WHERE assignee_id = ? AND created_at >= ?').get(targetId, since)
    ) as { cents: number };
    return row.cents;
  }

  /**
   * Whether a new task must wait because its project or agent is over budget, and who decides. The
   * person who would decide is not stopped by their own budget.
   */
  taskGate(actor: Participant, assignee: Participant, room: Room): { approver: Participant; reason: string } | null {
    const checks: [BudgetScope, number, string][] = [['agent', assignee.id, `${assignee.name}'s`]];
    if (room.projectId !== null) checks.unshift(['project', room.projectId, `${room.project}'s`]);
    for (const [scope, id, whose] of checks) {
      const row = this.budgetRow(scope, id);
      if (!row) continue;
      const spent = this.spentThisMonth(scope, id);
      if (spent < row.monthly_cents) continue;
      let approver = this.store.participantById(row.set_by);
      if (!approver || (scope === 'project' && !this.store.canSee(approver, id))) approver = this.store.participantById(assignee.ownerId!);
      if (!approver || approver.id === this.store.humanOf(actor)) continue;
      return { approver, reason: `${whose} monthly budget is used up (${money(spent)} of ${money(row.monthly_cents)})` };
    }
    return null;
  }

  /** Called when a task's spend changes: warns once a month at 80% and at 100%. */
  checkSpend(taskId: number): void {
    const task = this.store.db
      .prepare('SELECT t.assignee_id, t.message_id, r.project_id, coalesce(p.name || \'/\', \'\') || r.name AS room FROM tasks t JOIN rooms r ON r.id = t.room_id LEFT JOIN projects p ON p.id = r.project_id WHERE t.id = ?')
      .get(taskId) as { assignee_id: number; message_id: number; project_id: number | null; room: string } | undefined;
    if (!task) return;
    const month = this.monthStart().slice(0, 7);
    const scopes: [BudgetScope, number][] = [['agent', task.assignee_id]];
    if (task.project_id !== null) scopes.push(['project', task.project_id]);
    for (const [scope, id] of scopes) {
      const row = this.budgetRow(scope, id);
      if (!row) continue;
      const spent = this.spentThisMonth(scope, id);
      const level = spent >= row.monthly_cents ? 100 : spent >= row.monthly_cents * 0.8 ? 80 : 0;
      if (!level) continue;
      const fresh = this.store.db.prepare('INSERT OR IGNORE INTO budget_alerts (budget_id, month, level) VALUES (?, ?, ?)').run(row.id, month, level);
      if (Number(fresh.changes) === 0) continue;
      const name = scope === 'project' ? `Project ${this.projectName(id)}` : this.store.participantById(id)!.name;
      const what =
        level === 100
          ? `has used its monthly budget (${money(spent)} of ${money(row.monthly_cents)}). New tasks wait for your approval until next month or a higher budget.`
          : `has used ${Math.round((spent / row.monthly_cents) * 100)}% of its monthly budget (${money(spent)} of ${money(row.monthly_cents)}).`;
      const assignee = this.store.participantById(task.assignee_id)!;
      this.store.post(assignee, task.room, `@${row.setter} ${name} ${what}`, task.message_id, { skipRateLimit: true });
      this.store.audit.record(null, 'budget.alert', { projectId: task.project_id, subject: `${scope}:${name}`, detail: { level, spent, monthlyCents: row.monthly_cents } });
      this.store.events.emit('controls', { kind: 'budget' });
    }
  }

  /* Pauses */

  pause(actor: Participant, scope: PauseScope, name: string | null, reason = ''): Pause {
    const targetId = this.pauseTarget(actor, scope, name);
    const text = reason.trim().slice(0, MAX_REASON);
    this.store.db
      .prepare(
        `INSERT INTO pauses (scope, target_id, by_id, reason) VALUES (?, ?, ?, ?)
         ON CONFLICT (scope, target_id) DO UPDATE SET by_id = excluded.by_id, reason = excluded.reason, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(scope, targetId, actor.id, text);
    this.store.audit.record(actor, 'pause.on', { projectId: scope === 'project' ? targetId : null, subject: `${scope}:${name ?? 'all'}`, detail: { reason: text } });
    const pause = this.pauses(actor).find((p) => p.scope === scope && p.target === (scope === 'all' ? null : name))!;
    this.store.events.emit('pause', { ...pause, paused: true, projectId: scope === 'project' ? targetId : null, agentId: scope === 'agent' ? targetId : null });
    return pause;
  }

  resume(actor: Participant, scope: PauseScope, name: string | null): void {
    const targetId = this.pauseTarget(actor, scope, name);
    const { changes } = this.store.db.prepare('DELETE FROM pauses WHERE scope = ? AND target_id = ?').run(scope, targetId);
    if (Number(changes) === 0) throw new OrcoError('not_found', 'That is not paused');
    this.store.audit.record(actor, 'pause.off', { projectId: scope === 'project' ? targetId : null, subject: `${scope}:${name ?? 'all'}` });
    this.store.events.emit('pause', {
      scope,
      target: scope === 'all' ? null : name,
      paused: false,
      projectId: scope === 'project' ? targetId : null,
      agentId: scope === 'agent' ? targetId : null,
    });
  }

  /** Pauses in force that the actor is affected by or may see. */
  pauses(actor: Participant): Pause[] {
    const admin = this.store.isOrgAdmin(actor);
    const rows = this.store.db
      .prepare('SELECT x.scope, x.target_id, u.name AS by_name, x.reason, x.created_at FROM pauses x JOIN participants u ON u.id = x.by_id ORDER BY x.created_at')
      .all() as { scope: PauseScope; target_id: number; by_name: string; reason: string; created_at: string }[];
    const out: Pause[] = [];
    for (const r of rows) {
      let target: string | null = null;
      if (r.scope === 'project') {
        if (!admin && !this.store.canSee(actor, r.target_id)) continue;
        target = this.projectName(r.target_id);
      } else if (r.scope === 'agent') {
        const agent = this.store.participantById(r.target_id);
        if (!agent || (!admin && agent.id !== actor.id && agent.ownerId !== this.store.humanOf(actor))) continue;
        target = agent.name;
      }
      out.push({ scope: r.scope, target, by: r.by_name, reason: r.reason, at: r.created_at });
    }
    return out;
  }

  /** The pause stopping this agent in this project, if any. */
  pausedFor(agent: Participant, projectId: number | null): Pause | null {
    if (agent.kind !== 'agent') return null;
    const row = this.store.db
      .prepare(
        `SELECT x.scope, x.target_id, u.name AS by_name, x.reason, x.created_at FROM pauses x JOIN participants u ON u.id = x.by_id
         WHERE x.scope = 'all' OR (x.scope = 'agent' AND x.target_id = ?) OR (x.scope = 'project' AND x.target_id = ?)
         ORDER BY CASE x.scope WHEN 'all' THEN 0 WHEN 'project' THEN 1 ELSE 2 END LIMIT 1`,
      )
      .get(agent.id, projectId ?? -1) as { scope: PauseScope; target_id: number; by_name: string; reason: string; created_at: string } | undefined;
    if (!row) return null;
    const target = row.scope === 'project' ? this.projectName(row.target_id) : row.scope === 'agent' ? agent.name : null;
    return { scope: row.scope, target, by: row.by_name, reason: row.reason, at: row.created_at };
  }

  /** Throws if a pause stops this agent from acting in this project. */
  assertRunning(actor: Participant, projectId: number | null): void {
    const pause = this.pausedFor(actor, projectId);
    if (!pause) return;
    const what = pause.scope === 'all' ? 'All agents are' : pause.scope === 'project' ? `Agents in ${pause.target} are` : `${actor.name} is`;
    throw new OrcoError('forbidden', `${what} paused by ${pause.by}${pause.reason ? ` (${pause.reason})` : ''}. Stop work; you may still fail or decline your tasks.`);
  }

  /* Helpers */

  private budgetTarget(actor: Participant, scope: BudgetScope, name: string): number {
    if (scope === 'project') return this.store.adminProject(actor, name).id;
    if (scope === 'agent') return this.ownedOrAdmin(actor, name).id;
    throw new OrcoError('invalid', 'scope is project or agent');
  }

  private pauseTarget(actor: Participant, scope: PauseScope, name: string | null): number {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people pause or resume agents');
    if (scope === 'all') {
      if (!this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins pause every agent');
      return 0;
    }
    if (!name) throw new OrcoError('invalid', `Name the ${scope} to pause`);
    if (scope === 'project') return this.store.adminProject(actor, name).id;
    if (scope === 'agent') return this.ownedOrAdmin(actor, name).id;
    throw new OrcoError('invalid', 'scope is all, project or agent');
  }

  private ownedOrAdmin(actor: Participant, name: string): Participant {
    const agent = this.store.participantByName(name);
    if (!agent || agent.kind !== 'agent') throw new OrcoError('not_found', `No agent ${name}`);
    if (agent.ownerId !== actor.id && !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', `Only ${name}'s owner or an org admin can do that`);
    return agent;
  }

  private budgetRow(scope: BudgetScope, targetId: number): BudgetRow | undefined {
    return this.store.db
      .prepare('SELECT b.id, b.scope, b.target_id, b.monthly_cents, b.set_by, u.name AS setter FROM budgets b JOIN participants u ON u.id = b.set_by WHERE b.scope = ? AND b.target_id = ?')
      .get(scope, targetId) as BudgetRow | undefined;
  }

  private toBudget(row: BudgetRow): Budget {
    const spent = this.spentThisMonth(row.scope, row.target_id);
    const target = row.scope === 'project' ? this.projectName(row.target_id) : (this.store.participantById(row.target_id)?.name ?? '?');
    return { scope: row.scope, target, monthlyCents: row.monthly_cents, spentCents: spent, percent: Math.round((spent / row.monthly_cents) * 100), setBy: row.setter };
  }

  private projectName(id: number): string {
    return (this.store.db.prepare('SELECT name FROM projects WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? '?';
  }

  private monthStart(): string {
    const now = new Date(this.store.now());
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  }
}
