import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

export type TaskState = 'requested' | 'accepted' | 'done' | 'failed' | 'declined' | 'cancelled';

export const OPEN_STATES: readonly TaskState[] = ['requested', 'accepted'];

export interface TaskSummary {
  id: number;
  state: TaskState;
  assignee: string;
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
  created_at: string;
  updated_at: string;
}

const TASK_SELECT = `
  SELECT t.id, t.room_id, r.project_id, p.name AS project, r.name AS room, t.message_id,
         t.requester_id, rq.name AS requester, rq.owner_id AS requester_owner_id,
         t.assignee_id, a.name AS assignee, a.owner_id AS assignee_owner_id, ao.name AS assignee_owner,
         t.parent_id, t.depth, t.request, t.state, t.note, t.created_at, t.updated_at
  FROM tasks t
  JOIN rooms r ON r.id = t.room_id
  LEFT JOIN projects p ON p.id = r.project_id
  JOIN participants rq ON rq.id = t.requester_id
  JOIN participants a ON a.id = t.assignee_id
  LEFT JOIN participants ao ON ao.id = a.owner_id
`;

const ASSIGNEE_MOVES: Record<TaskState, TaskState[]> = {
  requested: ['accepted', 'declined', 'done', 'failed'],
  accepted: ['done', 'failed'],
  done: [],
  failed: [],
  declined: [],
  cancelled: [],
};

const MAX_REQUEST = 4_000;

function toTask(row: TaskRow): Task {
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
    state: row.state,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class Tasks {
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
    this.store.checkRate(actor, 'task');

    let taskId = 0;
    this.store.post(actor, room.ref, `@${assignee.name} ${request}`, undefined, {
      skipRateLimit: true,
      onInsert: (messageId, inserted) => {
        const { lastInsertRowid } = this.store.db
          .prepare(
            `INSERT INTO tasks (message_id, room_id, requester_id, assignee_id, parent_id, depth, request)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(messageId, inserted.id, actor.id, assignee.id, parent?.id ?? null, depth, request);
        taskId = Number(lastInsertRowid);
      },
    });
    const task = this.byId(taskId)!;
    this.store.events.emit('task', task);
    return task;
  }

  update(actor: Participant, id: number, state: TaskState, note?: string): Task {
    const row = this.row(id);
    if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No task ${id}`);
    const trimmedNote = note?.trim() || null;

    if (state === 'cancelled') {
      const allowed = [row.requester_id, row.requester_owner_id, row.assignee_owner_id].includes(actor.id);
      if (!allowed) throw new OrcoError('forbidden', 'Only the requester or a human owner can cancel a task');
      if (!OPEN_STATES.includes(row.state)) throw new OrcoError('conflict', `Task ${id} is already ${row.state}`);
    } else {
      if (actor.id !== row.assignee_id) throw new OrcoError('forbidden', `Only ${row.assignee} can update task ${id}`);
      if (!ASSIGNEE_MOVES[row.state].includes(state)) {
        throw new OrcoError('conflict', `Task ${id} is ${row.state}; it cannot move to ${state}`);
      }
    }

    const notify = state === 'cancelled' ? row.assignee : row.requester;
    const ping = state === 'accepted' || notify === actor.name ? '' : `@${notify} `;
    const text = `${ping}Task #${id} ${state}.${trimmedNote ? `\n${trimmedNote}` : ''}`;
    this.store.post(actor, toTask(row).room, text, row.message_id, {
      skipRateLimit: true,
      onInsert: () => {
        this.store.db
          .prepare(
            "UPDATE tasks SET state = ?, note = coalesce(?, note), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
          )
          .run(state, trimmedNote, id);
      },
    });
    const task = this.byId(id)!;
    this.store.events.emit('task', task);
    return task;
  }

  get(actor: Participant, id: number): Task {
    const row = this.row(id);
    if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No task ${id}`);
    return toTask(row);
  }

  list(
    actor: Participant,
    filter: { assignedToMe?: boolean; requestedByMe?: boolean; room?: string; open?: boolean; limit?: number } = {},
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
    if (filter.room) {
      where.push('t.room_id = ?');
      params.push(this.store.room(actor, filter.room).id);
    }
    if (filter.open) where.push(`t.state IN (${OPEN_STATES.map((s) => `'${s}'`).join(', ')})`);
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = this.store.db
      .prepare(`${TASK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.id DESC LIMIT ?`)
      .all(...params, limit) as unknown as TaskRow[];
    return rows.filter((row) => this.store.canSee(actor, row.project_id)).map(toTask);
  }

  summaryForMessage(messageId: number): TaskSummary | null {
    const row = this.store.db
      .prepare('SELECT t.id, t.state, a.name AS assignee FROM tasks t JOIN participants a ON a.id = t.assignee_id WHERE t.message_id = ?')
      .get(messageId) as TaskSummary | undefined;
    return row ? { id: row.id, state: row.state, assignee: row.assignee } : null;
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
    return row ? toTask(row) : null;
  }
}
