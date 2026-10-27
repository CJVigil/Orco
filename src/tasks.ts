import { OrcoError } from './errors.js';
import type { QuestionSummary } from './questions.js';
import type { Participant, Store } from './store.js';

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

export interface TaskSummary {
  id: number;
  state: TaskState;
  assignee: string;
  since: string;
  chain: string[];
  progress: TaskProgress | null;
  stalled: boolean;
}

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

function baseTask(row: TaskRow): Omit<Task, 'chain' | 'question' | 'progress' | 'stalled'> {
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
  };
}

export class Tasks {
  private readonly lastTouch = new Map<number, number>();

  constructor(private readonly store: Store) {}

  create(actor: Participant, input: { agent: string; room: string; request: string; parentId?: number }): Task {
    const request = input.request.trim();
    if (!request) throw new OrcoError('invalid', 'Task request is empty');
    if (request.length > MAX_REQUEST) throw new OrcoError('invalid', `Task request is over ${MAX_REQUEST} characters`);
    const assignee = this.store.participantByName(input.agent.replace(/^@/, ''));
    if (!assignee || assignee.kind !== 'agent') throw new OrcoError('not_found', `No agent named ${input.agent}`);
    if (assignee.id === actor.id) throw new OrcoError('invalid', 'An agent cannot assign a task to itself');
    const room = this.store.room(actor, input.room);
    if (!this.store.canSee(assignee, room.projectId)) {
      throw new OrcoError('forbidden', `${assignee.name} cannot see ${room.ref}; add its owner to the project first`);
    }

    const parent = this.parentFor(actor, input.parentId);
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > this.store.limits.maxTaskDepth) {
      throw new OrcoError(
        'forbidden',
        `Task chain is too deep (limit ${this.store.limits.maxTaskDepth}). Finish the work you have, or ask a human to take over.`,
      );
    }
    const owner = this.store.participantById(assignee.ownerId!)!;
    const needsApproval = this.consent(actor, assignee, owner);
    this.store.checkRate(actor, 'task');

    const text = needsApproval
      ? `@${owner.name} ${actor.name} asks your agent ${assignee.name} to: ${request}\nApprove to let ${assignee.name} start, or deny.`
      : `@${assignee.name} ${request}`;
    let taskId = 0;
    this.store.post(actor, room.ref, text, undefined, {
      skipRateLimit: true,
      onInsert: (messageId, inserted) => {
        const approvalId = needsApproval
          ? this.store.approvals.createForTask(actor, inserted, messageId, owner, `${assignee.name}: ${request}`.slice(0, 300))
          : null;
        const { lastInsertRowid } = this.store.db
          .prepare(
            `INSERT INTO tasks (message_id, room_id, requester_id, assignee_id, parent_id, depth, request, approval_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(messageId, inserted.id, actor.id, assignee.id, parent?.id ?? null, depth, request, approvalId);
        taskId = Number(lastInsertRowid);
      },
    });
    const task = this.byId(taskId)!;
    this.store.audit.record(actor, 'task.create', {
      projectId: task.projectId,
      subject: `task:${task.id}`,
      detail: { assignee: assignee.name, room: task.room, request, parentId: task.parentId, depth, needsApproval },
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

  update(actor: Participant, id: number, state: TaskState, note?: string): Task {
    const row = this.row(id);
    if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No task ${id}`);
    const trimmedNote = note?.trim() || null;

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
    }
    if (state === 'cancelled' && row.approval_id !== null) this.store.approvals.withdraw(row.approval_id);
    return this.transition(actor, row, state, trimmedNote);
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
               heartbeat_at = CASE WHEN ? = 'accepted' THEN ? ELSE heartbeat_at END, stall_notified = 0 WHERE id = ?`,
          )
          .run(state, note, state, this.store.now(), id);
      },
    });
    const task = this.byId(id)!;
    this.store.audit.record(actor, 'task.update', { projectId: task.projectId, subject: `task:${id}`, detail: { state, note, ...detail } });
    this.store.events.emit('task', task);
    return task;
  }

  /** Updates the progress line on an open task in place, without posting a message. */
  reportProgress(actor: Participant, id: number, text: string, percent?: number | null): Task {
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
    this.store.checkRate(actor, 'post');
    this.store.db
      .prepare(
        `UPDATE tasks SET progress = ?, progress_pct = ?, progress_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           heartbeat_at = ?, stall_notified = 0 WHERE id = ?`,
      )
      .run(line, percent ?? null, this.store.now(), id);
    const task = this.byId(id)!;
    this.store.audit.record(actor, 'task.progress', { projectId: task.projectId, subject: `task:${id}`, detail: { text: line, percent: percent ?? null } });
    this.store.events.emit('task', task);
    return task;
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
    const why = note?.trim();
    const request = `${row.request}\n\nHanded over by ${actor.name}${why ? `: ${why}` : '.'}`.slice(0, MAX_REQUEST);
    const room = this.toTask(row).room;
    const to = this.create(actor, { agent: agentName, room, request, parentId: id });
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

  /** Announces newly stalled tasks once each (as task events); returns them. */
  sweepStalled(): Task[] {
    const cutoff = this.store.now() - this.store.limits.taskStallMinutes * 60_000;
    const rows = this.store.db
      .prepare(
        `${TASK_SELECT} WHERE t.state = 'accepted' AND t.stall_notified = 0 AND t.heartbeat_at IS NOT NULL AND t.heartbeat_at < ?`,
      )
      .all(cutoff) as unknown as TaskRow[];
    const stalled: Task[] = [];
    for (const row of rows) {
      if (row.open_question !== null) continue;
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

  private isStalled(row: { state: TaskState; heartbeat_at: number | null; open_question?: number | null }): boolean {
    if (row.state !== 'accepted' || row.heartbeat_at === null || row.open_question) return false;
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
    const row = this.store.db
      .prepare(
        `SELECT t.id, t.state, a.name AS assignee, ap.state AS approval_state, t.updated_at AS since, t.parent_id,
                rq.name AS requester, t.progress, t.progress_pct, t.progress_at, t.heartbeat_at,
                (SELECT q.id FROM questions q WHERE q.task_id = t.id AND q.state = 'open') AS open_question
         FROM tasks t
         JOIN participants a ON a.id = t.assignee_id JOIN participants rq ON rq.id = t.requester_id
         LEFT JOIN approvals ap ON ap.id = t.approval_id
         WHERE t.message_id = ?`,
      )
      .get(messageId) as
      | (Omit<TaskSummary, 'chain' | 'progress' | 'stalled'> & {
          approval_state: string | null;
          open_question: number | null;
          parent_id: number | null;
          requester: string;
          progress: string | null;
          progress_pct: number | null;
          progress_at: string | null;
          heartbeat_at: number | null;
        })
      | undefined;
    return row
      ? {
          id: row.id,
          state: effectiveState(row),
          assignee: row.assignee,
          since: row.since,
          chain: this.chainFor(row),
          progress: progressOf(row),
          stalled: this.isStalled(row),
        }
      : null;
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
