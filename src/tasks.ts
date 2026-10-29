import { OrcoError } from './errors.js';
import type { QuestionSummary } from './questions.js';
import type { Participant, Store } from './store.js';
import { hashToken } from './tokens.js';
import { randomBytes } from 'node:crypto';

export type TaskState =
  | 'awaiting_approval'
  | 'requested'
  | 'accepted'
  | 'needs_input'
  | 'done'
  | 'failed'
  | 'declined'
  | 'cancelled';

export const OPEN_STATES: readonly TaskState[] = ['awaiting_approval', 'requested', 'accepted', 'needs_input'];

export interface TaskProgress {
  text: string;
  percent: number | null;
  at: string;
}

export interface TaskBudget {
  minutes: number | null;
  cents: number | null;
  /** Minutes since the agent accepted, up to when the task closed. */
  elapsedMinutes: number | null;
  spentCents: number;
  tokens: number;
  over: boolean;
}

export interface TaskLink {
  title: string | null;
  url: string;
}

export interface TaskFollowup {
  id: number;
  title: string;
  state: 'open' | 'accepted' | 'dismissed';
  ticket: string | null;
}

export interface TaskSummary {
  id: number;
  state: TaskState;
  assignee: string;
  since: string;
  chain: string[];
  progress: TaskProgress | null;
  stalled: boolean;
  /** When the assignee first looked at the task (read it, listed it, or started on it). */
  seenAt: string | null;
  budget: TaskBudget | null;
  links: TaskLink[];
  followups: TaskFollowup[];
  /** Thumbs from people on a finished task. */
  feedback: { up: number; down: number };
}

export interface TaskCheckpoint {
  text: string;
  at: string;
}

export interface Feedback {
  taskId: number;
  request: string;
  room: string;
  by: string;
  rating: 'up' | 'down';
  note: string;
  at: string;
}

export interface TaskResult {
  links?: { title?: string; url: string }[];
  followups?: { title: string; description?: string }[];
}

export interface CancelNotice {
  taskId: number;
  room: string;
  note: string | null;
}

export const MAX_BUDGET_MINUTES = 7 * 24 * 60;
export const MAX_BUDGET_CENTS = 1_000_000;
const MAX_LINKS = 10;
const MAX_FOLLOWUPS = 10;
const MAX_CHECKPOINT = 4_000;
const MAX_FEEDBACK_NOTE = 500;
const DEFAULT_TOKEN_TTL_SECONDS = 2 * 3600;
const MAX_TOKEN_TTL_SECONDS = 24 * 3600;

export interface AgentActivity {
  taskId: number;
  messageId: number;
  request: string;
  room: string;
  since: string;
}

export interface Task {
  id: number;
  room: string;
  projectId: number | null;
  messageId: number;
  requester: string;
  assignee: string;
  assigneeOwner: string | null;
  parentId: number | null;
  depth: number;
  request: string;
  state: TaskState;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  /** Who the request came from, root first: ["ana", "hermes"] means ana asked hermes, which asked this agent. */
  chain: string[];
  /** The latest question the assignee asked on this task, if any. */
  question: QuestionSummary | null;
  /** The assignee's latest progress line, updated in place. */
  progress: TaskProgress | null;
  /** Accepted, not waiting on a person, and no sign of life from the agent for a while. */
  stalled: boolean;
  seenAt: string | null;
  budget: TaskBudget | null;
  /** Links the assignee left with its result: a PR, a commit, a deploy. */
  links: TaskLink[];
  /** Follow-up work the assignee suggested; people turn each into a ticket or dismiss it. */
  followups: TaskFollowup[];
  feedback: { up: number; down: number };
  /** Where the assignee left off, for its next session or whoever takes the task over. */
  checkpoint: TaskCheckpoint | null;
  scheduleId: number | null;
}

interface TaskRow {
  id: number;
  room_id: number;
  project_id: number | null;
  project: string | null;
  room: string;
  message_id: number;
  requester_id: number;
  requester: string;
  requester_owner_id: number | null;
  assignee_id: number;
  assignee: string;
  assignee_owner_id: number | null;
  assignee_owner: string | null;
  parent_id: number | null;
  depth: number;
  request: string;
  state: TaskState;
  note: string | null;
  approval_id: number | null;
  approval_state: string | null;
  open_question: number | null;
  progress: string | null;
  progress_pct: number | null;
  progress_at: string | null;
  heartbeat_at: number | null;
  stall_notified: number;
  seen_at: string | null;
  accepted_at: number | null;
  budget_minutes: number | null;
  budget_cents: number | null;
  spent_cents: number;
  spent_tokens: number;
  over_budget_notified: number;
  links: string;
  schedule_id: number | null;
  checkpoint: string | null;
  checkpoint_at: string | null;
  reminder_due: number | null;
  created_at: string;
  updated_at: string;
}

const TASK_SELECT = `
  SELECT t.id, t.room_id, r.project_id, p.name AS project, r.name AS room, t.message_id,
         t.requester_id, rq.name AS requester, rq.owner_id AS requester_owner_id,
         t.assignee_id, a.name AS assignee, a.owner_id AS assignee_owner_id, ao.name AS assignee_owner,
         t.parent_id, t.depth, t.request, t.state, t.note, t.approval_id, ap.state AS approval_state,
         (SELECT q.id FROM questions q WHERE q.task_id = t.id AND q.state = 'open') AS open_question,
         t.progress, t.progress_pct, t.progress_at, t.heartbeat_at, t.stall_notified,
         t.seen_at, t.accepted_at, t.budget_minutes, t.budget_cents, t.spent_cents, t.spent_tokens,
         t.over_budget_notified, t.links, t.schedule_id, t.checkpoint, t.checkpoint_at,
         (SELECT min(rm.due_at) FROM reminders rm WHERE rm.task_id = t.id AND rm.fired_at IS NULL) AS reminder_due,
         t.created_at, t.updated_at
  FROM tasks t
  LEFT JOIN approvals ap ON ap.id = t.approval_id
  JOIN rooms r ON r.id = t.room_id
  LEFT JOIN projects p ON p.id = r.project_id
  JOIN participants rq ON rq.id = t.requester_id
  JOIN participants a ON a.id = t.assignee_id
  LEFT JOIN participants ao ON ao.id = a.owner_id
`;

const ASSIGNEE_MOVES: Record<TaskState, TaskState[]> = {
  awaiting_approval: [],
  requested: ['accepted', 'declined', 'done', 'failed'],
  accepted: ['done', 'failed'],
  needs_input: ['done', 'failed'],
  done: [],
  failed: [],
  declined: [],
  cancelled: [],
};

const MAX_REQUEST = 4_000;
const MAX_PROGRESS = 300;
const TOUCH_EVERY_MS = 30_000;

function effectiveState(row: { state: TaskState; approval_state: string | null; open_question: number | null }): TaskState {
  if (row.state === 'requested' && row.approval_state === 'pending') return 'awaiting_approval';
  if (row.state === 'accepted' && row.open_question !== null) return 'needs_input';
  return row.state;
}

function progressOf(row: { progress: string | null; progress_pct: number | null; progress_at: string | null }): TaskProgress | null {
  return row.progress === null ? null : { text: row.progress, percent: row.progress_pct, at: row.progress_at! };
}

function checkBudget(minutes: number | null | undefined, cents: number | null | undefined): void {
  if (minutes !== undefined && minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_BUDGET_MINUTES)) {
    throw new OrcoError('invalid', `A time budget is 1 to ${MAX_BUDGET_MINUTES} minutes`);
  }
  if (cents !== undefined && cents !== null && (!Number.isInteger(cents) || cents < 1 || cents > MAX_BUDGET_CENTS)) {
    throw new OrcoError('invalid', `A cost budget is 1 to ${MAX_BUDGET_CENTS} cents`);
  }
}

function checkLinks(links: TaskResult['links']): TaskLink[] {
  if (!links?.length) return [];
  if (links.length > MAX_LINKS) throw new OrcoError('invalid', `Leave at most ${MAX_LINKS} links`);
  return links.map((link) => {
    let url: URL;
    try {
      url = new URL(link.url.trim());
    } catch {
      throw new OrcoError('invalid', `Not a link: ${link.url}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OrcoError('invalid', `Links must be http or https: ${link.url}`);
    if (url.href.length > 2000) throw new OrcoError('invalid', 'That link is too long');
    const title = link.title?.trim().replace(/\s+/g, ' ').slice(0, 100) || null;
    return { title, url: url.href };
  });
}

function baseTask(row: TaskRow): Omit<Task, 'chain' | 'question' | 'progress' | 'stalled' | 'seenAt' | 'budget' | 'links' | 'followups' | 'feedback'> {
  return {
    id: row.id,
    room: row.project ? `${row.project}/${row.room}` : row.room,
    projectId: row.project_id,
    messageId: row.message_id,
    requester: row.requester,
    assignee: row.assignee,
    assigneeOwner: row.assignee_owner,
    parentId: row.parent_id,
    depth: row.depth,
    request: row.request,
    state: effectiveState(row),
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    scheduleId: row.schedule_id,
    checkpoint: row.checkpoint === null ? null : { text: row.checkpoint, at: row.checkpoint_at! },
  };
}

export class Tasks {
  private readonly lastTouch = new Map<number, number>();

  constructor(private readonly store: Store) {}

  create(
    actor: Participant,
    input: {
      agent: string;
      room: string;
      request: string;
      parentId?: number;
      budgetMinutes?: number | null;
      budgetCents?: number | null;
      scheduleId?: number;
      /** A person who must approve before the agent starts (webhook tasks: whoever set up the hook). */
      confirmBy?: Participant;
    },
  ): Task {
    const request = input.request.trim();
    checkBudget(input.budgetMinutes, input.budgetCents);
    if (!request) throw new OrcoError('invalid', 'Task request is empty');
    if (request.length > MAX_REQUEST) throw new OrcoError('invalid', `Task request is over ${MAX_REQUEST} characters`);
    const assignee = this.store.participantByName(input.agent.replace(/^@/, ''));
    if (!assignee || assignee.kind !== 'agent') throw new OrcoError('not_found', `No agent named ${input.agent}`);
    if (assignee.id === actor.id) throw new OrcoError('invalid', 'An agent cannot assign a task to itself');
    const room = this.store.room(actor, input.room);
    if (!this.store.canSee(assignee, room.projectId)) {
      throw new OrcoError('forbidden', `${assignee.name} cannot see ${room.ref}; add its owner to the project first`);
    }
    this.store.assertWrite(actor, room.projectId);
    if (room.projectId !== null && this.store.roleIn(assignee, room.projectId) === 'viewer') {
      throw new OrcoError('forbidden', `${assignee.name}'s owner has read-only access to ${room.project}, so it cannot take tasks there`);
    }
    // The project's policy decides who may take tasks and fills in or caps the budget.
    const budget = this.store.policies.forNewTask(room.projectId, assignee.name, { minutes: input.budgetMinutes, cents: input.budgetCents });

    const parent = this.parentFor(actor, input.parentId);
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > this.store.limits.maxTaskDepth) {
      throw new OrcoError(
        'forbidden',
        `Task chain is too deep (limit ${this.store.limits.maxTaskDepth}). Finish the work you have, or ask a human to take over.`,
      );
    }
    const owner = this.store.participantById(assignee.ownerId!)!;
    // Over a monthly budget, the task waits for the person who set it (see controls.ts). Otherwise the
    // owner's consent comes first; a person confirming outside text only stands in when none is needed.
    const gate = this.store.controls.taskGate(actor, assignee, room);
    const needsConsent = this.consent(actor, assignee, owner);
    const confirmBy = !gate && !needsConsent && input.confirmBy?.kind === 'user' ? input.confirmBy : null;
    const approver = gate?.approver ?? confirmBy ?? owner;
    const needsApproval = gate !== null || confirmBy !== null || needsConsent;
    this.store.checkRate(actor, 'task');

    const text = gate
      ? `@${approver.name} ${gate.reason}. ${actor.name} asks ${assignee.name} to: ${request}\nApprove to let it start anyway, or deny.`
      : confirmBy
        ? `@${confirmBy.name} This came from outside Orco. Should ${assignee.name} start on it?\n${request}\nApprove to let it start, or deny.`
      : needsApproval
        ? `@${owner.name} ${actor.name} asks your agent ${assignee.name} to: ${request}\nApprove to let ${assignee.name} start, or deny.`
        : `@${assignee.name} ${request}`;
    let taskId = 0;
    this.store.post(actor, room.ref, text, undefined, {
      skipRateLimit: true,
      onInsert: (messageId, inserted) => {
        const approvalId = needsApproval
          ? this.store.approvals.createForTask(actor, inserted, messageId, approver, `${gate ? 'Over budget · ' : ''}${assignee.name}: ${request}`.slice(0, 300))
          : null;
        const { lastInsertRowid } = this.store.db
          .prepare(
            `INSERT INTO tasks (message_id, room_id, requester_id, assignee_id, parent_id, depth, request, approval_id,
               budget_minutes, budget_cents, schedule_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            messageId,
            inserted.id,
            actor.id,
            assignee.id,
            parent?.id ?? null,
            depth,
            request,
            approvalId,
            budget.minutes,
            budget.cents,
            input.scheduleId ?? null,
          );
        taskId = Number(lastInsertRowid);
      },
    });
    const task = this.byId(taskId)!;
    this.store.audit.record(actor, 'task.create', {
      projectId: task.projectId,
      subject: `task:${task.id}`,
      detail: {
        assignee: assignee.name,
        room: task.room,
        request,
        parentId: task.parentId,
        depth,
        needsApproval,
        ...(gate ? { overBudget: gate.reason } : {}),
        ...(task.budget ? { budget: { minutes: task.budget.minutes, cents: task.budget.cents } } : {}),
        ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
      },
    });
    this.store.events.emit('task', task);
    return task;
  }

  resolveApproval(actor: Participant, approvalId: number, decision: 'approved' | 'denied', note: string | null): void {
    const row = this.store.db.prepare(`${TASK_SELECT} WHERE t.approval_id = ?`).get(approvalId) as TaskRow | undefined;
    if (!row || row.state !== 'requested') return;
    const room = this.toTask(row).room;
    if (decision === 'approved') {
      this.store.post(actor, room, `@${row.assignee} Task #${row.id} approved by ${actor.name}. Go ahead.${note ? `\n${note}` : ''}`, row.message_id, {
        skipRateLimit: true,
      });
    } else {
      const reason = `Not approved by ${actor.name}${note ? `: ${note}` : '.'}`;
      this.store.post(actor, room, `@${row.requester} Task #${row.id} declined. ${reason}`, row.message_id, {
        skipRateLimit: true,
        onInsert: () => {
          this.store.db
            .prepare("UPDATE tasks SET state = 'declined', note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
            .run(reason, row.id);
        },
      });
    }
    const task = this.byId(row.id)!;
    this.store.audit.record(actor, 'task.update', { projectId: task.projectId, subject: `task:${task.id}`, detail: { state: task.state, via: 'approval' } });
    this.store.events.emit('task', task);
  }

  private consent(actor: Participant, assignee: Participant, owner: Participant): boolean {
    const requesterHuman = this.store.humanOf(actor);
    if (requesterHuman === owner.id) return false;
    const policy = this.store.taskPolicyFor(assignee);
    if (policy === 'open') return false;
    if (policy === 'owner_only') {
      throw new OrcoError('forbidden', `${assignee.name} only takes tasks from ${owner.name} and ${owner.name}'s agents`);
    }
    return !this.store.trusts(assignee, requesterHuman);
  }

  update(actor: Participant, id: number, state: TaskState, note?: string, result: TaskResult = {}): Task {
    const row = this.row(id);
    if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No task ${id}`);
    const trimmedNote = this.store.hideSecrets(actor, note?.trim() ?? '') || null;
    const links = checkLinks(result.links);
    const followups = result.followups ?? [];
    if ((links.length || followups.length) && state !== 'done' && state !== 'failed') {
      throw new OrcoError('invalid', 'Links and follow-ups go with a done or failed task');
    }
    if (followups.length > MAX_FOLLOWUPS) throw new OrcoError('invalid', `Suggest at most ${MAX_FOLLOWUPS} follow-ups`);
    if (followups.length && row.project_id === null) throw new OrcoError('invalid', 'Follow-ups become tickets, so they need a task in a project room');
    for (const f of followups) this.store.suggestions.check(f);

    const current = effectiveState(row);
    if (state === 'cancelled') {
      const allowed = [row.requester_id, row.requester_owner_id, row.assignee_owner_id].includes(actor.id);
      if (!allowed) throw new OrcoError('forbidden', 'Only the requester or a human owner can cancel a task');
      if (!OPEN_STATES.includes(current)) throw new OrcoError('conflict', `Task ${id} is already ${current}`);
    } else {
      if (actor.id !== row.assignee_id) throw new OrcoError('forbidden', `Only ${row.assignee} can update task ${id}`);
      if (!ASSIGNEE_MOVES[current].includes(state)) {
        const why = current === 'awaiting_approval' ? `Task ${id} is waiting for your owner's approval` : `Task ${id} is ${current}`;
        throw new OrcoError('conflict', `${why}; it cannot move to ${state}`);
      }
      // A paused agent may still let go of work (done, failed, declined) but not start it.
      if (state === 'accepted') this.store.controls.assertRunning(actor, row.project_id);
    }
    if (state === 'cancelled' && row.approval_id !== null) this.store.approvals.withdraw(row.approval_id);
    if (links.length) this.store.db.prepare('UPDATE tasks SET links = ? WHERE id = ?').run(JSON.stringify(links), id);
    for (const f of followups) this.store.suggestions.create(actor, row.id, row.project_id!, f);
    return this.transition(actor, row, state, trimmedNote, {
      ...(links.length ? { links } : {}),
      ...(followups.length ? { followups: followups.map((f) => f.title) } : {}),
    });
  }

  private transition(actor: Participant, row: TaskRow, state: TaskState, note: string | null, detail: Record<string, unknown> = {}): Task {
    const id = row.id;
    if (state !== 'accepted') this.store.questions.closeForTask(id);
    const notify = state === 'cancelled' ? row.assignee : row.requester;
    const ping = state === 'accepted' || notify === actor.name ? '' : `@${notify} `;
    const text = `${ping}Task #${id} ${state}.${note ? `\n${note}` : ''}`;
    this.store.post(actor, this.toTask(row).room, text, row.message_id, {
      skipRateLimit: true,
      onInsert: () => {
        this.store.db
          .prepare(
            `UPDATE tasks SET state = ?, note = coalesce(?, note), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               heartbeat_at = CASE WHEN ? = 'accepted' THEN ? ELSE heartbeat_at END, stall_notified = 0,
               accepted_at = CASE WHEN ? = 'accepted' THEN coalesce(accepted_at, ?) ELSE accepted_at END,
               seen_at = CASE WHEN ? = 'accepted' THEN coalesce(seen_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE seen_at END,
               cancel_unseen = CASE WHEN ? = 'cancelled' AND ? != assignee_id THEN 1 ELSE 0 END
             WHERE id = ?`,
          )
          .run(state, note, state, this.store.now(), state, this.store.now(), state, state, actor.id, id);
      },
    });
    const task = this.byId(id)!;
    this.store.audit.record(actor, 'task.update', { projectId: task.projectId, subject: `task:${id}`, detail: { state, note, ...detail } });
    this.store.events.emit('task', task);
    return task;
  }

  /** Updates the progress line on an open task in place, without posting a message. */
  reportProgress(
    actor: Participant,
    id: number,
    text: string,
    percent?: number | null,
    usage: { costCents?: number | null; tokens?: number | null } = {},
  ): Task {
    const row = this.row(id);
    if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No task ${id}`);
    if (row.assignee_id !== actor.id) throw new OrcoError('forbidden', `Only ${row.assignee} can report progress on task ${id}`);
    if (row.state !== 'accepted') throw new OrcoError('conflict', `Task ${id} is ${effectiveState(row)}; accept it first`);
    const line = text.trim().replace(/\s+/g, ' ');
    if (!line) throw new OrcoError('invalid', 'Progress text is empty');
    if (line.length > MAX_PROGRESS) throw new OrcoError('invalid', `Progress can be at most ${MAX_PROGRESS} characters`);
    if (percent !== undefined && percent !== null && (!Number.isInteger(percent) || percent < 0 || percent > 100)) {
      throw new OrcoError('invalid', 'Percent must be a whole number from 0 to 100');
    }
    for (const [field, value] of [['Cost', usage.costCents], ['Tokens', usage.tokens]] as const) {
      if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 0 || value > 1e12)) {
        throw new OrcoError('invalid', `${field} must be a whole number of at least 0`);
      }
    }
    this.store.checkRate(actor, 'post');
    this.store.db
      .prepare(
        `UPDATE tasks SET progress = ?, progress_pct = ?, progress_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           heartbeat_at = ?, stall_notified = 0 WHERE id = ?`,
      )
      .run(line, percent ?? null, this.store.now(), id);
    // An agent's own figure is a total, and can only raise the spend: what the bridge measured stands.
    this.store.db
      .prepare(
        `UPDATE tasks SET reported_cents = max(reported_cents, coalesce(?, 0)), reported_tokens = max(reported_tokens, coalesce(?, 0)),
           spent_cents = max(measured_cents, max(reported_cents, coalesce(?, 0))), spent_tokens = max(measured_tokens, max(reported_tokens, coalesce(?, 0)))
         WHERE id = ?`,
      )
      .run(usage.costCents ?? null, usage.tokens ?? null, usage.costCents ?? null, usage.tokens ?? null, id);
    if (usage.costCents != null) this.store.controls.checkSpend(id);
    this.store.audit.record(actor, 'task.progress', {
      projectId: row.project_id,
      subject: `task:${id}`,
      detail: { text: line, percent: percent ?? null, ...(usage.costCents != null ? { costCents: usage.costCents } : {}), ...(usage.tokens != null ? { tokens: usage.tokens } : {}) },
    });
    this.checkOverBudget(id);
    const task = this.byId(id)!;
    this.store.events.emit('task', task);
    return task;
  }

  /** Adds what a bridge-reported run cost to the task's spend, and checks its budget. */
  addUsage(id: number, cents: number, tokens: number): void {
    if (cents <= 0 && tokens <= 0) return;
    this.store.db
      .prepare(
        `UPDATE tasks SET measured_cents = measured_cents + ?, measured_tokens = measured_tokens + ?,
           spent_cents = max(measured_cents + ?, reported_cents), spent_tokens = max(measured_tokens + ?, reported_tokens)
         WHERE id = ?`,
      )
      .run(cents, tokens, cents, tokens, id);
    this.checkOverBudget(id);
    this.store.controls.checkSpend(id);
    this.store.events.emit('task', this.byId(id)!);
  }

  /** Tells the requester once when a task runs past its time or cost budget. */
  private checkOverBudget(id: number): void {
    const row = this.row(id);
    if (!row || row.over_budget_notified || !OPEN_STATES.includes(row.state)) return;
    const budget = this.budgetOf(row);
    if (!budget?.over) return;
    const parts: string[] = [];
    if (budget.minutes !== null && budget.elapsedMinutes !== null && budget.elapsedMinutes > budget.minutes) {
      parts.push(`${budget.elapsedMinutes} of ${budget.minutes} minutes`);
    }
    if (budget.cents !== null && budget.spentCents > budget.cents) parts.push(`${money(budget.spentCents)} of ${money(budget.cents)}`);
    const assignee = this.store.participantById(row.assignee_id)!;
    this.store.db.prepare('UPDATE tasks SET over_budget_notified = 1 WHERE id = ?').run(id);
    this.store.post(assignee, this.toTask(row).room, `@${row.requester} Task #${id} is over its budget (${parts.join(', ')}). ${row.assignee} has been asked to stop and check with you before going on.`, row.message_id, {
      skipRateLimit: true,
    });
    this.store.audit.record(null, 'task.over_budget', { projectId: row.project_id, subject: `task:${id}`, detail: budget });
  }

  /** Saves where the assignee left off; replaces the last checkpoint. */
  checkpoint(actor: Participant, id: number, text: string): Task {
    const row = this.row(id);
    if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No task ${id}`);
    if (row.assignee_id !== actor.id) throw new OrcoError('forbidden', `Only ${row.assignee} can checkpoint task ${id}`);
    if (!OPEN_STATES.includes(row.state)) throw new OrcoError('conflict', `Task ${id} is ${row.state}`);
    const value = text.trim();
    if (!value) throw new OrcoError('invalid', 'The checkpoint is empty');
    if (value.length > MAX_CHECKPOINT) throw new OrcoError('invalid', `Checkpoints are at most ${MAX_CHECKPOINT} characters`);
    this.store.db
      .prepare("UPDATE tasks SET checkpoint = ?, checkpoint_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), heartbeat_at = ?, stall_notified = 0 WHERE id = ?")
      .run(value, this.store.now(), id);
    this.store.audit.record(actor, 'task.checkpoint', { projectId: row.project_id, subject: `task:${id}`, detail: { length: value.length } });
    const task = this.byId(id)!;
    this.store.events.emit('task', task);
    return task;
  }

  /** A person rates a finished task, once (a second rating replaces the first). */
  rate(actor: Participant, id: number, rating: 'up' | 'down', note = ''): Task {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people rate task results');
    const row = this.row(id);
    if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No task ${id}`);
    if (row.state !== 'done' && row.state !== 'failed') throw new OrcoError('conflict', 'Rate a task once it is done or failed');
    if (rating !== 'up' && rating !== 'down') throw new OrcoError('invalid', 'Rating is up or down');
    const text = note.trim();
    if (text.length > MAX_FEEDBACK_NOTE) throw new OrcoError('invalid', `Keep the note under ${MAX_FEEDBACK_NOTE} characters`);
    this.store.db
      .prepare(
        `INSERT INTO task_feedback (task_id, author_id, rating, note) VALUES (?, ?, ?, ?)
         ON CONFLICT (task_id, author_id) DO UPDATE SET rating = excluded.rating, note = excluded.note, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(id, actor.id, rating, text);
    this.store.audit.record(actor, 'task.feedback', { projectId: row.project_id, subject: `task:${id}`, detail: { rating, note: text } });
    const task = this.byId(id)!;
    this.store.events.emit('task', task);
    return task;
  }

  /** Feedback people left on an agent's tasks, newest first. The agent's own, or its owner's view. */
  feedbackFor(actor: Participant, agentName?: string, limit = 20): Feedback[] {
    const agent = agentName && agentName !== actor.name ? this.store.participantByName(agentName) : actor;
    if (!agent || agent.kind !== 'agent' || (agent.id !== actor.id && agent.ownerId !== actor.id)) throw new OrcoError('not_found', `No agent ${agentName ?? ''} of yours`);
    const rows = this.store.db
      .prepare(
        `SELECT f.task_id, t.request, r.project_id, coalesce(p.name || '/', '') || r.name AS room, u.name AS by, f.rating, f.note, f.created_at
         FROM task_feedback f JOIN tasks t ON t.id = f.task_id JOIN rooms r ON r.id = t.room_id LEFT JOIN projects p ON p.id = r.project_id
         JOIN participants u ON u.id = f.author_id
         WHERE t.assignee_id = ? ORDER BY f.created_at DESC LIMIT ?`,
      )
      .all(agent.id, Math.min(Math.max(limit, 1), 100)) as unknown as {
      task_id: number;
      request: string;
      project_id: number | null;
      room: string;
      by: string;
      rating: 'up' | 'down';
      note: string;
      created_at: string;
    }[];
    return rows
      .filter((r) => this.store.canSee(actor, r.project_id))
      .map((r) => ({ taskId: r.task_id, request: r.request, room: r.room, by: r.by, rating: r.rating, note: r.note, at: r.created_at }));
  }

  private feedbackCounts(taskId: number): { up: number; down: number } {
    const row = this.store.db
      .prepare("SELECT sum(rating = 'up') AS up, sum(rating = 'down') AS down FROM task_feedback WHERE task_id = ?")
      .get(taskId) as { up: number | null; down: number | null };
    return { up: row.up ?? 0, down: row.down ?? 0 };
  }

  /** Records that the assignee has looked at these tasks; the first look only. */
  markSeen(actor: Participant, ids: number[]): void {
    if (actor.kind !== 'agent' || ids.length === 0) return;
    const update = this.store.db.prepare("UPDATE tasks SET seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND assignee_id = ? AND seen_at IS NULL");
    for (const id of new Set(ids)) {
      if (Number(update.run(id, actor.id).changes) > 0) this.store.events.emit('task', this.byId(id)!);
    }
  }

  /** Tasks of this agent's that someone cancelled since it last heard; each is reported once. */
  takeCancelNotices(actor: Participant): CancelNotice[] {
    if (actor.kind !== 'agent') return [];
    const rows = this.store.db
      .prepare(`${TASK_SELECT} WHERE t.assignee_id = ? AND t.cancel_unseen = 1 ORDER BY t.id`)
      .all(actor.id) as unknown as TaskRow[];
    if (rows.length === 0) return [];
    this.store.db.prepare('UPDATE tasks SET cancel_unseen = 0 WHERE assignee_id = ? AND cancel_unseen = 1').run(actor.id);
    return rows.map((row) => ({ taskId: row.id, room: this.toTask(row).room, note: row.note }));
  }

  /**
   * A short-lived token for one task: it signs in as the assignee but sees only the task's project
   * (and server rooms), and stops working when the task closes. The bridge hands it to the agent it
   * starts instead of the agent's own token.
   */
  issueToken(actor: Participant, id: number, ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS): { token: string; taskId: number; expiresAt: string } {
    this.store.unscoped(actor, 'issue task tokens');
    const row = this.row(id);
    if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No task ${id}`);
    if (row.assignee_id !== actor.id) throw new OrcoError('forbidden', `Only ${row.assignee} can get a token for task ${id}`);
    if (!OPEN_STATES.includes(row.state)) throw new OrcoError('conflict', `Task ${id} is ${row.state}`);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_TOKEN_TTL_SECONDS) {
      throw new OrcoError('invalid', `A task token lasts 60 to ${MAX_TOKEN_TTL_SECONDS} seconds`);
    }
    const now = this.store.now();
    this.store.db.prepare('DELETE FROM task_tokens WHERE expires_at < ?').run(now);
    const token = `orco_t_${randomBytes(32).toString('base64url')}`;
    const expires = now + ttlSeconds * 1000;
    this.store.db.prepare('INSERT INTO task_tokens (token_hash, task_id, agent_id, expires_at) VALUES (?, ?, ?, ?)').run(hashToken(token), id, actor.id, expires);
    this.store.audit.record(actor, 'task.token', { projectId: row.project_id, subject: `task:${id}`, detail: { ttlSeconds } });
    return { token, taskId: id, expiresAt: new Date(expires).toISOString() };
  }

  authenticateTaskToken(hash: string): Participant | null {
    const row = this.store.db
      .prepare(
        `SELECT p.id, p.kind, p.name, p.owner_id, t.id AS task_id, r.project_id
         FROM task_tokens tt JOIN tasks t ON t.id = tt.task_id JOIN rooms r ON r.id = t.room_id
         JOIN participants p ON p.id = tt.agent_id
         WHERE tt.token_hash = ? AND tt.expires_at > ? AND t.state IN ('requested', 'accepted')`,
      )
      .get(hash, this.store.now()) as
      | { id: number; kind: 'agent'; name: string; owner_id: number | null; task_id: number; project_id: number | null }
      | undefined;
    if (!row) return null;
    return { id: row.id, kind: row.kind, name: row.name, ownerId: row.owner_id, scope: { taskId: row.task_id, projectId: row.project_id } };
  }

  /** What an agent spent on tasks over the last `days` days, for its owner. */
  spendOf(agentId: number, days = 30): { tasks: number; cents: number; tokens: number; minutes: number } {
    const since = new Date(this.store.now() - days * 86_400_000).toISOString();
    const rows = this.store.db
      .prepare(`${TASK_SELECT} WHERE t.assignee_id = ? AND t.created_at >= ? AND t.accepted_at IS NOT NULL`)
      .all(agentId, since) as unknown as TaskRow[];
    let cents = 0;
    let tokens = 0;
    let minutes = 0;
    for (const row of rows) {
      cents += row.spent_cents;
      tokens += row.spent_tokens;
      minutes += this.elapsedMinutes(row) ?? 0;
    }
    return { tasks: rows.length, cents, tokens, minutes };
  }

  private elapsedMinutes(row: TaskRow): number | null {
    if (row.accepted_at === null) return null;
    const end = OPEN_STATES.includes(row.state) ? this.store.now() : Date.parse(row.updated_at);
    return Math.max(0, Math.floor((end - row.accepted_at) / 60_000));
  }

  private budgetOf(row: TaskRow): TaskBudget | null {
    if (row.budget_minutes === null && row.budget_cents === null && row.spent_cents === 0 && row.spent_tokens === 0) return null;
    const elapsedMinutes = this.elapsedMinutes(row);
    const overTime = row.budget_minutes !== null && elapsedMinutes !== null && elapsedMinutes > row.budget_minutes;
    const overCost = row.budget_cents !== null && row.spent_cents > row.budget_cents;
    return {
      minutes: row.budget_minutes,
      cents: row.budget_cents,
      elapsedMinutes,
      spentCents: row.spent_cents,
      tokens: row.spent_tokens,
      over: overTime || overCost,
    };
  }

  /**
   * Hands an open task to another agent: a new task (consent rules apply, the chain is kept) and
   * this one declined with a pointer to it.
   */
  reassign(actor: Participant, id: number, agentName: string, note?: string): { from: Task; to: Task } {
    const row = this.row(id);
    if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No task ${id}`);
    if (row.assignee_id !== actor.id) throw new OrcoError('forbidden', `Only ${row.assignee} can hand task ${id} over`);
    const current = effectiveState(row);
    if (!['requested', 'accepted', 'needs_input'].includes(current)) throw new OrcoError('conflict', `Task ${id} is ${current}`);
    // No hand-over loops (A to B and back to A): an agent that already had this work in the chain cannot get it again.
    const target = this.store.participantByName(agentName);
    if (target) {
      const step = this.store.db.prepare('SELECT parent_id, assignee_id FROM tasks WHERE id = ?');
      for (let at: number | null = id, hops = 0; at !== null && hops <= 50; hops++) {
        const up = step.get(at) as { parent_id: number | null; assignee_id: number } | undefined;
        if (!up) break;
        if (up.assignee_id === target.id) throw new OrcoError('conflict', `${agentName} already had this work in the chain; ask a person instead`);
        at = up.parent_id;
      }
    }
    const why = note?.trim();
    const request = `${row.request}\n\nHanded over by ${actor.name}${why ? `: ${why}` : '.'}`.slice(0, MAX_REQUEST);
    const room = this.toTask(row).room;
    const to = this.create(actor, { agent: agentName, room, request, parentId: id });
    if (row.checkpoint !== null) {
      this.store.db.prepare('UPDATE tasks SET checkpoint = ?, checkpoint_at = ? WHERE id = ?').run(row.checkpoint, row.checkpoint_at, to.id);
    }
    const from = this.transition(actor, this.row(id)!, 'declined', `Handed over to ${to.assignee} as task #${to.id}${why ? `: ${why}` : '.'}`, {
      handedTo: to.id,
    });
    this.store.events.emit('handoff', { from, to });
    return { from, to };
  }

  /** Records that an agent is alive: any request it makes counts. Cheap; writes at most every 30s per agent. */
  touch(actor: Participant): void {
    if (actor.kind !== 'agent') return;
    const now = this.store.now();
    if (now - (this.lastTouch.get(actor.id) ?? 0) < TOUCH_EVERY_MS) return;
    this.lastTouch.set(actor.id, now);
    const revived = this.store.db
      .prepare("SELECT id FROM tasks WHERE assignee_id = ? AND state = 'accepted' AND stall_notified = 1")
      .all(actor.id) as unknown as { id: number }[];
    this.store.db.prepare("UPDATE tasks SET heartbeat_at = ?, stall_notified = 0 WHERE assignee_id = ? AND state = 'accepted'").run(now, actor.id);
    for (const { id } of revived) this.store.events.emit('task', this.byId(id)!);
  }

  /** Announces newly stalled tasks once each (as task events); returns them. Also catches tasks that ran out of time. */
  sweepStalled(): Task[] {
    const timed = this.store.db
      .prepare("SELECT id FROM tasks WHERE state = 'accepted' AND budget_minutes IS NOT NULL AND over_budget_notified = 0 AND accepted_at < ? - budget_minutes * 60000")
      .all(this.store.now()) as unknown as { id: number }[];
    for (const { id } of timed) {
      this.checkOverBudget(id);
      this.store.events.emit('task', this.byId(id)!);
    }
    const cutoff = this.store.now() - this.store.limits.taskStallMinutes * 60_000;
    const rows = this.store.db
      .prepare(
        `${TASK_SELECT} WHERE t.state = 'accepted' AND t.stall_notified = 0 AND t.heartbeat_at IS NOT NULL AND t.heartbeat_at < ?`,
      )
      .all(cutoff) as unknown as TaskRow[];
    const stalled: Task[] = [];
    for (const row of rows) {
      if (row.open_question !== null || row.reminder_due !== null) continue;
      this.store.db.prepare('UPDATE tasks SET stall_notified = 1 WHERE id = ?').run(row.id);
      const task = this.byId(row.id)!;
      this.store.audit.record(null, 'task.stalled', { projectId: task.projectId, subject: `task:${task.id}`, detail: { assignee: task.assignee } });
      this.store.events.emit('task', task);
      stalled.push(task);
    }
    return stalled;
  }

  /** Open tasks this participant requested (or their agents did) that have stalled. */
  stalledFor(actor: Participant): Task[] {
    const rows = this.store.db
      .prepare(`${TASK_SELECT} WHERE t.state = 'accepted' AND (t.requester_id = ? OR rq.owner_id = ? OR a.owner_id = ?) ORDER BY t.id`)
      .all(actor.id, actor.id, actor.id) as unknown as TaskRow[];
    return rows.filter((row) => this.isStalled(row) && this.store.canSee(actor, row.project_id)).map((row) => this.toTask(row));
  }

  private isStalled(row: { state: TaskState; heartbeat_at: number | null; open_question?: number | null; reminder_due?: number | null }): boolean {
    // Waiting on a person, or asleep until a reminder the agent set, is not stalling.
    if (row.state !== 'accepted' || row.heartbeat_at === null || row.open_question || row.reminder_due) return false;
    return this.store.now() - row.heartbeat_at > this.store.limits.taskStallMinutes * 60_000;
  }

  get(actor: Participant, id: number): Task {
    const row = this.row(id);
    if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No task ${id}`);
    return this.toTask(row);
  }

  list(
    actor: Participant,
    filter: {
      assignedToMe?: boolean;
      requestedByMe?: boolean;
      forMyAgents?: boolean;
      room?: string;
      open?: boolean;
      limit?: number;
    } = {},
  ): Task[] {
    const where: string[] = [];
    const params: (number | string)[] = [];
    if (filter.assignedToMe) {
      where.push('t.assignee_id = ?');
      params.push(actor.id);
    }
    if (filter.requestedByMe) {
      where.push('t.requester_id = ?');
      params.push(actor.id);
    }
    if (filter.forMyAgents) {
      where.push('a.owner_id = ?');
      params.push(actor.id);
    }
    if (filter.room) {
      where.push('t.room_id = ?');
      params.push(this.store.room(actor, filter.room).id);
    }
    if (filter.open) where.push(`t.state IN (${OPEN_STATES.map((s) => `'${s}'`).join(', ')})`);
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = this.store.db
      .prepare(`${TASK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.id DESC LIMIT ?`)
      .all(...params, limit) as unknown as TaskRow[];
    return rows.filter((row) => this.store.canSee(actor, row.project_id)).map((row) => this.toTask(row));
  }

  forApproval(approvalId: number): Task | null {
    const row = this.store.db.prepare(`${TASK_SELECT} WHERE t.approval_id = ?`).get(approvalId) as TaskRow | undefined;
    return row ? this.toTask(row) : null;
  }

  summaryForMessage(messageId: number): TaskSummary | null {
    const row = this.store.db.prepare(`${TASK_SELECT} WHERE t.message_id = ?`).get(messageId) as TaskRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      state: effectiveState(row),
      assignee: row.assignee,
      since: row.updated_at,
      chain: this.chainFor(row),
      progress: progressOf(row),
      stalled: this.isStalled(row),
      seenAt: row.seen_at,
      budget: this.budgetOf(row),
      links: JSON.parse(row.links) as TaskLink[],
      followups: this.store.suggestions.forTask(row.id),
      feedback: this.feedbackCounts(row.id),
    };
  }

  activity(viewer: Participant): Map<number, AgentActivity> {
    const rows = this.store.db
      .prepare(
        `${TASK_SELECT} WHERE t.state = 'accepted' ORDER BY t.updated_at ASC`,
      )
      .all() as unknown as TaskRow[];
    const byAgent = new Map<number, AgentActivity>();
    for (const row of rows) {
      if (!this.store.canSee(viewer, row.project_id)) continue;
      const task = this.toTask(row);
      byAgent.set(row.assignee_id, { taskId: task.id, messageId: task.messageId, request: task.request, room: task.room, since: task.updatedAt });
    }
    return byAgent;
  }

  /** A task as callers see it, with where the request came from and its latest question. */
  private toTask(row: TaskRow): Task {
    return {
      ...baseTask(row),
      chain: this.chainFor(row),
      question: this.store.questions.latestForTask(row.id),
      progress: progressOf(row),
      stalled: this.isStalled(row),
      seenAt: row.seen_at,
      budget: this.budgetOf(row),
      links: JSON.parse(row.links) as TaskLink[],
      followups: this.store.suggestions.forTask(row.id),
      feedback: this.feedbackCounts(row.id),
    };
  }

  private chainFor(row: { requester: string; parent_id: number | null }): string[] {
    const chain = [row.requester];
    const step = this.store.db.prepare(
      'SELECT t.parent_id, rq.name AS requester FROM tasks t JOIN participants rq ON rq.id = t.requester_id WHERE t.id = ?',
    );
    for (let parent = row.parent_id; parent !== null && chain.length <= 20; ) {
      const up = step.get(parent) as { parent_id: number | null; requester: string } | undefined;
      if (!up) break;
      chain.unshift(up.requester);
      parent = up.parent_id;
    }
    return chain;
  }

  /** A task by id without a visibility check, for events. */
  find(id: number): Task | null {
    return this.byId(id);
  }

  private parentFor(actor: Participant, parentId: number | undefined): TaskRow | null {
    if (parentId !== undefined) {
      const parent = this.row(parentId);
      if (!parent || !this.store.canSeeRoomId(actor, parent.room_id)) throw new OrcoError('not_found', `No task ${parentId}`);
      if (parent.assignee_id !== actor.id || !OPEN_STATES.includes(parent.state)) {
        throw new OrcoError('invalid', `Task ${parentId} is not an open task assigned to you`);
      }
      return parent;
    }
    if (actor.kind !== 'agent') return null;
    const open = this.store.db
      .prepare(
        `${TASK_SELECT} WHERE t.assignee_id = ? AND t.state = 'accepted' ORDER BY t.depth DESC, t.id DESC LIMIT 1`,
      )
      .get(actor.id) as TaskRow | undefined;
    return open ?? null;
  }

  private row(id: number): TaskRow | undefined {
    return this.store.db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as TaskRow | undefined;
  }

  private byId(id: number): Task | null {
    const row = this.row(id);
    return row ? this.toTask(row) : null;
  }
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
