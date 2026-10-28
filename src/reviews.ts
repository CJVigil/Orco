import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';
import { OPEN_STATES } from './tasks.js';

const MAX_SUMMARY = 1_000;
const MAX_NOTE = 4_000;

export type ReviewState = 'pending' | 'approved' | 'changes_requested' | 'withdrawn';

export interface ReviewSummary {
  id: number;
  state: ReviewState;
  reviewer: string;
  reviewerKind: 'user' | 'agent';
  requester: string;
  /** A ticket ref like API-12, or a task like "task #7". */
  target: string;
  ticket: string | null;
  taskId: number | null;
  summary: string;
  note: string | null;
  reviewTaskId: number | null;
}

export interface Review extends ReviewSummary {
  room: string;
  messageId: number;
  projectId: number | null;
  createdAt: string;
  decidedAt: string | null;
}

interface ReviewRow {
  id: number;
  room_id: number;
  room: string;
  project: string | null;
  project_id: number | null;
  message_id: number;
  ticket_id: number | null;
  ticket: string | null;
  task_id: number | null;
  requester_id: number;
  requester: string;
  requester_owner_id: number | null;
  reviewer_id: number;
  reviewer: string;
  reviewer_kind: 'user' | 'agent';
  summary: string;
  state: ReviewState;
  note: string | null;
  review_task_id: number | null;
  created_at: string;
  decided_at: string | null;
}

const SELECT = `
  SELECT v.id, v.room_id, r.name AS room, p.name AS project, r.project_id, v.message_id, v.ticket_id,
         CASE WHEN tk.id IS NULL THEN NULL ELSE tp.ticket_key || '-' || tk.number END AS ticket,
         v.task_id, v.requester_id, rq.name AS requester, rq.owner_id AS requester_owner_id,
         v.reviewer_id, rv.name AS reviewer, rv.kind AS reviewer_kind, v.summary, v.state, v.note, v.review_task_id,
         v.created_at, v.decided_at
  FROM reviews v
  JOIN rooms r ON r.id = v.room_id
  LEFT JOIN projects p ON p.id = r.project_id
  LEFT JOIN tickets tk ON tk.id = v.ticket_id
  LEFT JOIN projects tp ON tp.id = tk.project_id
  JOIN participants rq ON rq.id = v.requester_id
  JOIN participants rv ON rv.id = v.reviewer_id
`;

function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    state: row.state,
    reviewer: row.reviewer,
    reviewerKind: row.reviewer_kind,
    requester: row.requester,
    target: row.ticket ?? `task #${row.task_id}`,
    ticket: row.ticket,
    taskId: row.task_id,
    summary: row.summary,
    note: row.note,
    reviewTaskId: row.review_task_id,
    room: row.project ? `${row.project}/${row.room}` : row.room,
    messageId: row.message_id,
    projectId: row.project_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

/**
 * Asking someone, a person or another agent, to look over work before it counts as finished. On a
 * ticket, a request moves it to review; changes move it back to work (and restart its agent); a
 * person's approval moves it to done.
 */
export class Reviews {
  constructor(private readonly store: Store) {}

  request(actor: Participant, input: { ticket?: string; taskId?: number; reviewer: string; summary: string }): Review {
    if ((input.ticket === undefined) === (input.taskId === undefined)) throw new OrcoError('invalid', 'Ask for a review of a ticket or of a task, not both');
    const summary = input.summary.trim();
    if (!summary) throw new OrcoError('invalid', 'Say what to review and what you want checked');
    if (summary.length > MAX_SUMMARY) throw new OrcoError('invalid', `Keep the summary under ${MAX_SUMMARY} characters`);
    const reviewer = this.store.participantByName(input.reviewer.replace(/^@/, ''));
    if (!reviewer) throw new OrcoError('not_found', `No one named ${input.reviewer}`);
    if (reviewer.id === actor.id) throw new OrcoError('invalid', 'Ask someone else to review your work');

    let room: string;
    let threadId: number | undefined;
    let ticketId: number | null = null;
    let label: string;
    let projectId: number | null;
    if (input.ticket !== undefined) {
      const ticket = this.store.tickets.get(actor, input.ticket);
      room = this.store.tickets.workRoom(ticket.projectId);
      ticketId = ticket.id;
      projectId = ticket.projectId;
      // Ticket titles must not ping anyone (see Tickets.dispatch).
      label = `${ticket.ref} (${ticket.title.replace(/@/g, '＠')})`;
    } else {
      const task = this.store.tasks.get(actor, input.taskId!);
      room = task.room;
      threadId = task.messageId;
      projectId = task.projectId;
      label = `task #${task.id}`;
    }
    if (!this.store.canSee(reviewer, projectId)) throw new OrcoError('forbidden', `${reviewer.name} cannot see that project`);
    const pending = this.store.db
      .prepare("SELECT id FROM reviews WHERE state = 'pending' AND reviewer_id = ? AND (ticket_id IS ? AND task_id IS ?)")
      .get(reviewer.id, ticketId, input.taskId ?? null) as { id: number } | undefined;
    if (pending) throw new OrcoError('conflict', `${reviewer.name} already has review #${pending.id} of ${label} open`);

    let id = 0;
    const insert = (messageId: number, roomId: number, reviewTaskId: number | null) => {
      const { lastInsertRowid } = this.store.db
        .prepare('INSERT INTO reviews (room_id, message_id, ticket_id, task_id, requester_id, reviewer_id, summary, review_task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(roomId, messageId, ticketId, input.taskId ?? null, actor.id, reviewer.id, summary, reviewTaskId);
      id = Number(lastInsertRowid);
    };
    if (reviewer.kind === 'agent') {
      // An agent reviewer gets a task, so the bridge wakes it; consent rules apply as for any task.
      const request = `Review ${label} for ${actor.name}: ${summary}\nLook at the work, then answer with submit_review (verdict approved or changes_requested, with a note).`;
      const task = this.store.tasks.create(actor, { agent: reviewer.name, room, request });
      const roomId = (this.store.db.prepare('SELECT room_id FROM tasks WHERE id = ?').get(task.id) as { room_id: number }).room_id;
      insert(task.messageId, roomId, task.id);
    } else {
      this.store.post(actor, room, `@${reviewer.name} ${actor.name} asks for your review of ${label}: ${summary}`, threadId, {
        onInsert: (messageId, inserted) => insert(messageId, inserted.id, null),
      });
    }
    if (ticketId !== null) this.store.tickets.reviewStep(ticketId, actor, 'review', `Asked ${reviewer.name} for a review: ${summary}`);
    const review = this.byId(id)!;
    this.store.audit.record(actor, 'review.request', { projectId: review.projectId, subject: `review:${id}`, detail: { reviewer: reviewer.name, target: review.target, summary } });
    this.changed(review);
    return review;
  }

  submit(actor: Participant, id: number, verdict: 'approved' | 'changes_requested', note?: string): Review {
    const row = this.row(id);
    if (!row || !this.store.canSee(actor, row.project_id)) throw new OrcoError('not_found', `No review ${id}`);
    if (row.reviewer_id !== actor.id) throw new OrcoError('forbidden', `Review ${id} is ${row.reviewer}'s to give`);
    if (row.state !== 'pending') throw new OrcoError('conflict', `Review ${id} is ${row.state}`);
    if (verdict !== 'approved' && verdict !== 'changes_requested') throw new OrcoError('invalid', 'The verdict is approved or changes_requested');
    const text = note?.trim() || null;
    if (verdict === 'changes_requested' && !text) throw new OrcoError('invalid', 'Say what needs to change');
    if (text && text.length > MAX_NOTE) throw new OrcoError('invalid', `Keep the note under ${MAX_NOTE} characters`);
    const review = toReview(row);
    const words = verdict === 'approved' ? 'approved' : 'asks for changes';
    this.store.post(actor, review.room, `@${row.requester} ${actor.name} ${words} on ${review.target}.${text ? `\n${text}` : ''}`, row.message_id, {
      skipRateLimit: true,
      onInsert: () => {
        this.store.db
          .prepare("UPDATE reviews SET state = ?, note = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
          .run(verdict, text, id);
      },
    });
    if (row.ticket_id !== null) {
      const move = verdict === 'changes_requested' ? 'rework' : actor.kind === 'user' ? 'done' : null;
      this.store.tickets.reviewStep(row.ticket_id, actor, move, `Review by ${actor.name}: ${words}.${text ? `\n\n${text}` : ''}`);
      if (verdict === 'changes_requested' && row.ticket) this.restart(actor, row.ticket);
    }
    if (row.review_task_id !== null) {
      const task = this.store.tasks.find(row.review_task_id);
      if (task && (task.state === 'requested' || task.state === 'accepted')) {
        this.store.tasks.update(actor, task.id, 'done', `Review ${verdict === 'approved' ? 'approved' : 'asked for changes'}.`);
      }
    }
    const result = this.byId(id)!;
    this.store.audit.record(actor, 'review.submit', { projectId: result.projectId, subject: `review:${id}`, detail: { verdict, note: text } });
    this.changed(result);
    return result;
  }

  withdraw(actor: Participant, id: number): Review {
    const row = this.row(id);
    if (!row || !this.store.canSee(actor, row.project_id)) throw new OrcoError('not_found', `No review ${id}`);
    if (row.requester_id !== actor.id && row.requester_owner_id !== actor.id) throw new OrcoError('forbidden', 'Only whoever asked for the review can withdraw it');
    if (row.state !== 'pending') throw new OrcoError('conflict', `Review ${id} is ${row.state}`);
    this.store.db.prepare("UPDATE reviews SET state = 'withdrawn', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
    if (row.review_task_id !== null) {
      const task = this.store.tasks.find(row.review_task_id);
      if (task && OPEN_STATES.includes(task.state)) this.store.tasks.update(actor, task.id, 'cancelled', 'The review was withdrawn.');
    }
    const result = this.byId(id)!;
    this.store.audit.record(actor, 'review.withdraw', { projectId: result.projectId, subject: `review:${id}` });
    this.changed(result);
    return result;
  }

  get(actor: Participant, id: number): Review {
    const row = this.row(id);
    if (!row || !this.store.canSee(actor, row.project_id)) throw new OrcoError('not_found', `No review ${id}`);
    return toReview(row);
  }

  /** Reviews waiting on this participant. */
  pendingFor(actor: Participant): Review[] {
    const rows = this.store.db.prepare(`${SELECT} WHERE v.reviewer_id = ? AND v.state = 'pending' ORDER BY v.id`).all(actor.id) as unknown as ReviewRow[];
    return rows.filter((row) => this.store.canSee(actor, row.project_id)).map(toReview);
  }

  summaryForMessage(messageId: number): ReviewSummary | null {
    const row = this.store.db.prepare(`${SELECT} WHERE v.message_id = ?`).get(messageId) as ReviewRow | undefined;
    if (!row) return null;
    const { room: _room, messageId: _m, projectId: _p, createdAt: _c, decidedAt: _d, ...summary } = toReview(row);
    return summary;
  }

  /** Changes on a ticket worked by an agent start its task again, with the reviewer's note in the ticket. */
  private restart(actor: Participant, ref: string): void {
    try {
      const ticket = this.store.tickets.get(actor, ref);
      if (ticket.assignee?.kind !== 'agent') return;
      if (ticket.task && OPEN_STATES.includes(ticket.task.state)) return;
      this.store.tickets.startTask(actor, ref);
    } catch (err) {
      if (!(err instanceof OrcoError)) throw err;
    }
  }

  private changed(review: Review): void {
    this.store.events.emit('review', review);
  }

  private row(id: number): ReviewRow | undefined {
    return this.store.db.prepare(`${SELECT} WHERE v.id = ?`).get(id) as ReviewRow | undefined;
  }

  private byId(id: number): Review | null {
    const row = this.row(id);
    return row ? toReview(row) : null;
  }
}
