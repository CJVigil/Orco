import { MAX_MEMBER_BUDGET_CENTS } from './hosted.js';
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
  /** What is left this month, in cents. */
  remainingCents: number;
  /** Where spend would be today if spread evenly over the month. */
  evenCents: number;
  /** The day the cap runs out at this pace, or null when it lasts the month. */
  runsOutOn: string | null;
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
    // An agent that runs on the org's model keeps a capped budget unless an org admin says otherwise.
    const agent = scope === 'agent' ? this.store.participantById(targetId)! : null;
    if (agent && !this.store.isOrgAdmin(actor) && this.store.hosted.of(agent)) {
      const others = this.store.hosted.memberCommitted(agent.ownerId!, agent.id);
      // Lowering a budget below what was spent frees nothing: the money is gone.
      if (monthlyCents === null || Math.max(monthlyCents, this.spentThisMonth('agent', agent.id)) + others > MAX_MEMBER_BUDGET_CENTS) {
        throw new OrcoError('invalid', `${name} runs on the org's model: your agents there can have at most $${MAX_MEMBER_BUDGET_CENTS / 100} a month between them; an org admin can raise it`);
      }
    }
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

  /** What a project or agent has spent this month, in cents: counted when the money was spent. */
  spentThisMonth(scope: BudgetScope, targetId: number): number {
    return this.spentSince(scope, targetId, this.monthStart());
  }

  spentSince(scope: BudgetScope, targetId: number, since: string): number {
    const column = scope === 'project' ? 'project_id' : 'agent_id';
    return (this.store.db.prepare(`SELECT coalesce(sum(cents), 0) AS cents FROM spend WHERE ${column} = ? AND created_at >= ?`).get(targetId, since) as { cents: number }).cents;
  }

  /**
   * Books money an agent just spent, dated now. Whether it ran on the org's model, and who owned it,
   * are kept with it, so removing the agent or lowering its budget never makes the money unspent.
   */
  recordSpend(agentId: number, cents: number, context: { taskId?: number; projectId?: number | null; note?: string; ticketId?: number | null; tokens?: number } = {}): void {
    const tokens = Math.max(0, Math.round(context.tokens ?? 0));
    if (!(cents > 0) && tokens === 0) return;
    const agent = this.store.participantById(agentId);
    // Spend on a task that works a ticket counts on the ticket too (#106).
    const ticketId = context.ticketId ?? (context.taskId !== undefined ? this.store.tickets.ticketIdForTask(context.taskId) : null);
    this.store.db
      .prepare('INSERT INTO spend (agent_id, owner_id, task_id, project_id, org_model, cents, note, created_at, ticket_id, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(agentId, agent?.ownerId ?? null, context.taskId ?? null, context.projectId ?? null, agent && this.store.hosted.of(agent) ? 1 : 0, Math.max(cents, 0), context.note ?? '', new Date(this.store.now()).toISOString(), ticketId, tokens);
  }

  /**
   * Usage an agent reports for its session (#106): totals so far, so a session can report again and
   * only the growth is booked. It goes on the ticket named, or the agent's one ticket in progress.
   */
  reportUsage(actor: Participant, input: { session: string; tokens: number; costUsd?: number | null; ticket?: string | null }): { ticket: string | null; tokens: number; cents: number } {
    if (actor.kind !== 'agent') throw new OrcoError('forbidden', 'Agents report their own usage');
    const session = String(input.session ?? '').trim().slice(0, 200);
    if (!session) throw new OrcoError('invalid', 'session names the session the totals are for');
    if (!Number.isFinite(input.tokens) || input.tokens < 0 || input.tokens > 1e11) throw new OrcoError('invalid', 'tokens is a count');
    const cents = input.costUsd === undefined || input.costUsd === null ? 0 : Number(input.costUsd) * 100;
    if (!Number.isFinite(cents) || cents < 0 || cents > MAX_CENTS) throw new OrcoError('invalid', 'cost_usd is an amount in dollars');
    let ticketId: number | null = null;
    let projectId: number | null = null;
    if (input.ticket) {
      ticketId = this.store.tickets.idOf(actor, input.ticket);
    } else {
      const mine = this.store.tickets.list(actor, { assignee: 'me', categories: ['started'], limit: 2 });
      if (mine.length === 1) ticketId = mine[0]!.id;
    }
    if (ticketId !== null) projectId = (this.store.db.prepare('SELECT project_id FROM tickets WHERE id = ?').get(ticketId) as { project_id: number }).project_id;
    const before = this.store.db.prepare('SELECT tokens, cents FROM usage_sessions WHERE agent_id = ? AND session = ?').get(actor.id, session) as { tokens: number; cents: number } | undefined;
    const addTokens = Math.max(0, Math.round(input.tokens) - (before?.tokens ?? 0));
    const addCents = Math.max(0, cents - (before?.cents ?? 0));
    this.store.db
      .prepare(
        `INSERT INTO usage_sessions (agent_id, session, tokens, cents, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, session) DO UPDATE SET tokens = max(tokens, excluded.tokens), cents = max(cents, excluded.cents), updated_at = excluded.updated_at`,
      )
      .run(actor.id, session, Math.round(input.tokens), cents, new Date(this.store.now()).toISOString());
    this.recordSpend(actor.id, addCents, { ticketId, projectId, tokens: addTokens, note: `session ${session.slice(0, 40)}` });
    const ref = ticketId === null ? null : (this.store.db.prepare("SELECT p.ticket_key || '-' || t.number AS ref FROM tickets t JOIN projects p ON p.id = t.project_id WHERE t.id = ?").get(ticketId) as { ref: string }).ref;
    return { ticket: ref, tokens: addTokens, cents: Math.round(addCents) };
  }

  /** What a ticket has cost so far: tokens and cents. */
  ticketSpend(ticketId: number): { tokens: number; cents: number } {
    const row = this.store.db.prepare('SELECT coalesce(sum(tokens), 0) AS tokens, coalesce(sum(cents), 0) AS cents FROM spend WHERE ticket_id = ?').get(ticketId) as { tokens: number; cents: number };
    return { tokens: row.tokens, cents: Math.round(row.cents) };
  }

  /**
   * Spend in a project over the last days (#106): the most expensive tickets, and totals by folder,
   * person (the agent's owner), agent and day. Private tickets the actor cannot see are left out.
   */
  projectSpend(actor: Participant, projectName: string, days = 7) {
    const project = this.store.visibleProject(actor, projectName);
    const since = new Date(this.store.now() - Math.min(Math.max(days, 1), 92) * 86_400_000).toISOString();
    const hidden = this.store.tickets.privateFilter(actor);
    const q = <T>(sql: string, ...params: (string | number)[]) => this.store.db.prepare(sql).all(...params) as unknown as T[];
    const base = `FROM spend s LEFT JOIN tickets t ON t.id = s.ticket_id WHERE s.project_id = ? AND s.created_at >= ? AND (t.id IS NULL OR ${hidden.sql})`;
    const params = [project.id, since, ...hidden.params];
    const tickets = q<{ ref: string; title: string; tokens: number; cents: number }>(
      `SELECT pr.ticket_key || '-' || t.number AS ref, t.title, sum(s.tokens) AS tokens, sum(s.cents) AS cents ${base} AND t.id IS NOT NULL
       GROUP BY t.id ORDER BY sum(s.cents) DESC, sum(s.tokens) DESC LIMIT 15`.replace('FROM spend s', 'FROM spend s JOIN projects pr ON pr.id = s.project_id'),
      ...params,
    );
    const by = (column: string, join = '') =>
      q<{ name: string | null; tokens: number; cents: number }>(
        `SELECT ${column} AS name, sum(s.tokens) AS tokens, sum(s.cents) AS cents ${base.replace('FROM spend s', `FROM spend s ${join}`)} GROUP BY 1 ORDER BY sum(s.cents) DESC, sum(s.tokens) DESC`,
        ...params,
      );
    const round = <T extends { cents: number }>(rows: T[]) => rows.map((r) => ({ ...r, cents: Math.round(r.cents) }));
    return {
      days,
      tickets: round(tickets),
      folders: round(by("coalesce(f.name, '(no folder)')", 'LEFT JOIN tickets tf ON tf.id = s.ticket_id LEFT JOIN ticket_folders f ON f.id = tf.folder_id')),
      people: round(by("coalesce(o.name, '(no owner)')", 'LEFT JOIN participants o ON o.id = s.owner_id')),
      agents: round(by('a.name', 'JOIN participants a ON a.id = s.agent_id')),
      byDay: round(by('substr(s.created_at, 1, 10)')),
    };
  }

  /** What a person's agents spent on the org's models this month, removed agents included. */
  ownerOrgSpend(ownerId: number): number {
    return (
      this.store.db.prepare('SELECT coalesce(sum(cents), 0) AS cents FROM spend WHERE owner_id = ? AND org_model = 1 AND created_at >= ?').get(ownerId, this.monthStart()) as {
        cents: number;
      }
    ).cents;
  }

  /** What an agent may still spend this month, in cents, or null without a budget. */
  agentBudgetLeft(agentId: number): number | null {
    const row = this.budgetRow('agent', agentId);
    return row ? row.monthly_cents - this.spentThisMonth('agent', agentId) : null;
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
      // An agent on the org's model key: past its budget, only an org admin lets more work start,
      // whoever asks (its owner included).
      const provider = scope === 'agent' ? this.store.hosted.providerCreatorOf(assignee) : null;
      if (provider) {
        if (this.store.isOrgAdmin(this.store.participantById(this.store.humanOf(actor))!)) continue;
        return { approver: provider, reason: `${whose} monthly budget on the org's model is used up (${money(spent)} of ${money(row.monthly_cents)})` };
      }
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
      const pace = this.pace(spent, row.monthly_cents);
      // Level 1: at this pace the cap runs out before the month does, told once (#106).
      const level = spent >= row.monthly_cents ? 100 : spent >= row.monthly_cents * 0.8 ? 80 : pace.runsOutOn ? 1 : 0;
      if (!level) continue;
      const fresh = this.store.db.prepare('INSERT OR IGNORE INTO budget_alerts (budget_id, month, level) VALUES (?, ?, ?)').run(row.id, month, level);
      if (Number(fresh.changes) === 0) continue;
      const name = scope === 'project' ? `Project ${this.projectName(id)}` : this.store.participantById(id)!.name;
      const what =
        level === 1
          ? `is spending fast: at this pace its monthly budget (${money(row.monthly_cents)}) runs out on ${pace.runsOutOn}. ${money(spent)} spent, ${money(pace.remainingCents)} left.`
          : level === 100
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
    return { scope: row.scope, target, monthlyCents: row.monthly_cents, spentCents: spent, percent: Math.round((spent / row.monthly_cents) * 100), setBy: row.setter, ...this.pace(spent, row.monthly_cents) };
  }

  /**
   * Where spend would be if spread evenly over the month, what remains, and the day the cap runs out
   * at this pace (null when it lasts the month), so a fast start shows before the 80% alert (#106).
   */
  pace(spent: number, monthly: number): { remainingCents: number; evenCents: number; runsOutOn: string | null } {
    const now = this.store.now();
    const start = Date.parse(this.monthStart());
    const d = new Date(start);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const elapsed = Math.max(now - start, 3600_000);
    const evenCents = Math.round((monthly * (now - start)) / (end - start));
    const perMs = spent / elapsed;
    const out = perMs > 0 ? start + monthly / perMs : Infinity;
    return { remainingCents: Math.max(0, monthly - spent), evenCents, runsOutOn: out < end && spent < monthly ? new Date(out).toISOString().slice(0, 10) : spent >= monthly ? new Date(now).toISOString().slice(0, 10) : null };
  }

  private projectName(id: number): string {
    return (this.store.db.prepare('SELECT name FROM projects WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? '?';
  }

  monthStart(): string {
    const now = new Date(this.store.now());
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  }
}
