import { OrcoError } from './errors.js';
import { maskSecrets } from './mask.js';
import type { Participant, Store } from './store.js';

/** Logs are kept to this many bytes per run: the head and the tail, with the middle cut. */
export const MAX_LOG_BYTES = 256 * 1024;
const MAX_OUTCOME = 200;
/** A bridge reports one run per agent start; these bound what one agent can make Orco store. */
const MAX_RUNS_PER_MINUTE = 20;
const MAX_RUNS_PER_TASK = 300;
/** Only the newest runs of a task keep their logs. */
const LOGS_KEPT_PER_TASK = 20;

export type RunMode = 'start' | 'resume' | 'reminder';

export interface RunInput {
  mode: RunMode;
  startedAt: string;
  seconds: number;
  /** How the run ended, like "code 0", "timeout", "model stopped". */
  outcome: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Cost in millionths of a US dollar, as the agent tool reported it. */
  costMicros?: number | null;
  branch?: string | null;
  workspace?: string | null;
  log?: string | null;
}

export interface Run {
  id: number;
  taskId: number;
  agent: string;
  mode: RunMode;
  startedAt: string;
  seconds: number;
  outcome: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  branch: string | null;
  workspace: string | null;
  /** Bytes of log kept (0 once pruned or if none was sent). */
  logBytes: number;
  logCut: boolean;
}

export interface Scorecard {
  agent: string;
  days: number;
  tasks: { total: number; done: number; failed: number; declined: number; cancelled: number; open: number };
  /** done / (done + failed), or null with nothing finished. */
  successRate: number | null;
  /** Median minutes from accepting to done. */
  medianMinutes: number | null;
  /** Tasks where the agent asked a person something. */
  askedForHelp: number;
  runs: number;
  runSeconds: number;
  tokens: { input: number; output: number };
  costMicros: number;
  costPerDoneMicros: number | null;
  feedback: { up: number; down: number };
}

interface RunRow {
  id: number;
  task_id: number;
  agent: string;
  mode: RunMode;
  started_at: string;
  seconds: number;
  outcome: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: number | null;
  branch: string | null;
  workspace: string | null;
  log_bytes: number;
  log_cut: number;
}

const RUN_SELECT = `SELECT r.id, r.task_id, a.name AS agent, r.mode, r.started_at, r.seconds, r.outcome, r.input_tokens, r.output_tokens,
  r.cost_micros, r.branch, r.workspace, r.log_bytes, r.log_cut FROM task_runs r JOIN participants a ON a.id = r.agent_id`;

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    taskId: row.task_id,
    agent: row.agent,
    mode: row.mode,
    startedAt: row.started_at,
    seconds: row.seconds,
    outcome: row.outcome,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costMicros: row.cost_micros,
    branch: row.branch,
    workspace: row.workspace,
    logBytes: row.log_bytes,
    logCut: row.log_cut === 1,
  };
}

/** Keeps the start and end of a long log, which is where the setup and the outcome are. */
export function capLog(text: string, max = MAX_LOG_BYTES): { text: string; cut: boolean } {
  const bytes = Buffer.byteLength(text);
  if (bytes <= max) return { text, cut: false };
  const buffer = Buffer.from(text);
  const head = buffer.subarray(0, Math.floor(max / 4)).toString().replace(/�+$/, '');
  const tail = buffer.subarray(bytes - Math.floor((max * 3) / 4) + 100).toString().replace(/^�+/, '');
  return { text: `${head}\n\n… ${Math.round((bytes - max) / 1024)} KB cut …\n\n${tail}`, cut: true };
}

const count = (value: unknown, field: string): number | null => {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1e13) throw new OrcoError('invalid', `${field} must be a whole number of at least 0`);
  return value as number;
};

/**
 * What agents' runs did: the bridge reports each run of an agent on a task (how long, how it ended,
 * tokens and cost if the tool says, the worktree branch, and a masked log). People who can see the
 * task can read its runs; the agent and its owner get a scorecard built from them.
 */
export class Runs {
  constructor(private readonly store: Store) {}

  record(actor: Participant, taskId: number, input: RunInput): Run {
    const task = this.store.tasks.get(actor, taskId);
    if (task.assignee !== actor.name) throw new OrcoError('forbidden', `Only ${task.assignee}'s bridge can report runs on task ${taskId}`);
    if (!['start', 'resume', 'reminder'].includes(input.mode)) throw new OrcoError('invalid', 'mode is start, resume or reminder');
    if (Number.isNaN(Date.parse(input.startedAt))) throw new OrcoError('invalid', 'started_at must be a date and time');
    const seconds = count(input.seconds, 'seconds') ?? 0;
    const outcome = String(input.outcome ?? '').trim().slice(0, MAX_OUTCOME);
    if (!outcome) throw new OrcoError('invalid', 'Say how the run ended');
    const inputTokens = count(input.inputTokens, 'input_tokens');
    const outputTokens = count(input.outputTokens, 'output_tokens');
    const costMicros = count(input.costMicros, 'cost_micros');
    // The bridge masks what it knows; this catches tokens and keys of well-known shapes it may have missed.
    const recent = this.store.db
      .prepare('SELECT count(*) AS n FROM task_runs WHERE agent_id = ? AND created_at > ?')
      .get(actor.id, new Date(this.store.now() - 60_000).toISOString()) as { n: number };
    if (recent.n >= MAX_RUNS_PER_MINUTE) throw new OrcoError('rate_limited', `At most ${MAX_RUNS_PER_MINUTE} run reports a minute`);
    const total = this.store.db.prepare('SELECT count(*) AS n FROM task_runs WHERE task_id = ?').get(taskId) as { n: number };
    if (total.n >= MAX_RUNS_PER_TASK) throw new OrcoError('conflict', `Task ${taskId} already has ${MAX_RUNS_PER_TASK} runs; close it and start a new task`);
    // The bridge masks what it knows; this also hides secrets the agent was shown through a lease, and
    // tokens and keys of well-known shapes.
    const log = input.log ? capLog(maskSecrets(String(input.log), this.store.secrets.revealedTo(actor.id))) : null;
    const { lastInsertRowid } = this.store.db
      .prepare(
        `INSERT INTO task_runs (task_id, agent_id, mode, started_at, seconds, outcome, input_tokens, output_tokens, cost_micros, branch, workspace, log, log_bytes, log_cut, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        actor.id,
        input.mode,
        new Date(input.startedAt).toISOString(),
        seconds,
        outcome,
        inputTokens,
        outputTokens,
        costMicros,
        input.branch?.slice(0, 200) ?? null,
        input.workspace?.slice(0, 500) ?? null,
        log?.text ?? null,
        log ? Buffer.byteLength(log.text) : 0,
        log?.cut ? 1 : 0,
        new Date(this.store.now()).toISOString(),
      );
    const id = Number(lastInsertRowid);
    this.store.db
      .prepare(
        `UPDATE task_runs SET log = NULL, log_bytes = 0 WHERE task_id = ? AND log IS NOT NULL
         AND id NOT IN (SELECT id FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ${LOGS_KEPT_PER_TASK})`,
      )
      .run(taskId, taskId);
    this.store.audit.record(actor, 'task.run', {
      projectId: task.projectId,
      subject: `task:${taskId}`,
      detail: { run: id, mode: input.mode, seconds, outcome, inputTokens, outputTokens, costMicros, branch: input.branch ?? null },
    });
    this.store.tasks.addUsage(taskId, Math.round((costMicros ?? 0) / 10_000), (inputTokens ?? 0) + (outputTokens ?? 0));
    return this.byId(id)!;
  }

  /** Runs of a task, oldest first, for anyone who can see the task. */
  list(actor: Participant, taskId: number): Run[] {
    this.store.tasks.get(actor, taskId);
    return (this.store.db.prepare(`${RUN_SELECT} WHERE r.task_id = ? ORDER BY r.id`).all(taskId) as unknown as RunRow[]).map(toRun);
  }

  /** A run's log, for anyone who can see its task. */
  log(actor: Participant, runId: number): { run: Run; log: string } {
    // Logs hold whatever the agent printed; people review them, agents have no need to.
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people read run logs');
    const row = this.store.db.prepare('SELECT task_id, log FROM task_runs WHERE id = ?').get(runId) as { task_id: number; log: string | null } | undefined;
    if (!row) throw new OrcoError('not_found', `No run ${runId}`);
    try {
      this.store.tasks.get(actor, row.task_id);
    } catch {
      throw new OrcoError('not_found', `No run ${runId}`);
    }
    return { run: this.byId(runId)!, log: row.log ?? '' };
  }

  /** Drops logs older than `days` days, keeping the runs themselves. */
  pruneLogs(days: number): number {
    if (days <= 0) return 0;
    const before = new Date(this.store.now() - days * 86_400_000).toISOString();
    return Number(
      this.store.db.prepare('UPDATE task_runs SET log = NULL, log_bytes = 0 WHERE log IS NOT NULL AND created_at < ?').run(before).changes,
    );
  }

  /** How an agent has done over the last `days` days. The agent itself, or its owner. */
  scorecard(actor: Participant, agentName: string | undefined, days = 30): Scorecard {
    const agent = agentName && agentName !== actor.name ? this.store.participantByName(agentName) : actor;
    if (!agent || agent.kind !== 'agent' || (agent.id !== actor.id && agent.ownerId !== actor.id)) throw new OrcoError('not_found', `No agent ${agentName ?? ''} of yours`);
    const span = Math.min(Math.max(Math.floor(days) || 30, 1), 365);
    const since = new Date(this.store.now() - span * 86_400_000).toISOString();
    const tasks = this.store.db
      .prepare(
        `SELECT t.id, t.state, t.accepted_at, t.updated_at, EXISTS (SELECT 1 FROM questions q WHERE q.task_id = t.id) AS asked
         FROM tasks t WHERE t.assignee_id = ? AND t.created_at >= ?`,
      )
      .all(agent.id, since) as { id: number; state: string; accepted_at: number | null; updated_at: string; asked: number }[];
    const by = (state: string) => tasks.filter((t) => t.state === state).length;
    const done = by('done');
    const failed = by('failed');
    const minutes = tasks
      .filter((t) => t.state === 'done' && t.accepted_at !== null)
      .map((t) => Math.max(0, (Date.parse(t.updated_at) - t.accepted_at!) / 60_000))
      .sort((a, b) => a - b);
    const median = minutes.length ? (minutes.length % 2 ? minutes[(minutes.length - 1) / 2]! : (minutes[minutes.length / 2 - 1]! + minutes[minutes.length / 2]!) / 2) : null;
    const runs = this.store.db
      .prepare(
        `SELECT count(*) AS runs, coalesce(sum(seconds), 0) AS seconds, coalesce(sum(input_tokens), 0) AS input,
           coalesce(sum(output_tokens), 0) AS output, coalesce(sum(cost_micros), 0) AS cost
         FROM task_runs WHERE agent_id = ? AND created_at >= ?`,
      )
      .get(agent.id, since) as { runs: number; seconds: number; input: number; output: number; cost: number };
    const feedback = this.store.db
      .prepare(
        `SELECT coalesce(sum(f.rating = 'up'), 0) AS up, coalesce(sum(f.rating = 'down'), 0) AS down
         FROM task_feedback f JOIN tasks t ON t.id = f.task_id WHERE t.assignee_id = ? AND t.created_at >= ?`,
      )
      .get(agent.id, since) as { up: number; down: number };
    const open = tasks.filter((t) => ['awaiting_approval', 'requested', 'accepted'].includes(t.state)).length;
    return {
      agent: agent.name,
      days: span,
      tasks: { total: tasks.length, done, failed, declined: by('declined'), cancelled: by('cancelled'), open },
      successRate: done + failed ? done / (done + failed) : null,
      medianMinutes: median === null ? null : Math.round(median * 10) / 10,
      askedForHelp: tasks.filter((t) => t.asked).length,
      runs: runs.runs,
      runSeconds: runs.seconds,
      tokens: { input: runs.input, output: runs.output },
      costMicros: runs.cost,
      costPerDoneMicros: done ? Math.round(runs.cost / done) : null,
      feedback: { up: feedback.up, down: feedback.down },
    };
  }

  private byId(id: number): Run | undefined {
    const row = this.store.db.prepare(`${RUN_SELECT} WHERE r.id = ?`).get(id) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }
}
