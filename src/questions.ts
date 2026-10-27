import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

export type QuestionState = 'open' | 'answered' | 'resumed' | 'cancelled';
export type QuestionTarget = 'requester' | 'owner';

export interface Question {
  id: number;
  taskId: number;
  room: string;
  projectId: number | null;
  messageId: number;
  /** The task's message, which the question's thread hangs off. */
  threadId: number;
  asker: string;
  target: string;
  question: string;
  answer: string | null;
  answeredBy: string | null;
  state: QuestionState;
  createdAt: string;
  answeredAt: string | null;
}

export interface QuestionSummary {
  id: number;
  taskId: number;
  state: QuestionState;
  asker: string;
  target: string;
  question: string;
  answer: string | null;
  answeredBy: string | null;
}

interface QuestionRow {
  id: number;
  task_id: number;
  room_id: number;
  project_id: number | null;
  project: string | null;
  room: string;
  message_id: number;
  thread_id: number;
  asker_id: number;
  asker: string;
  target_id: number;
  target: string;
  target_owner_id: number | null;
  assignee_owner_id: number | null;
  question: string;
  answer: string | null;
  answered_by: string | null;
  state: QuestionState;
  created_at: string;
  answered_at: string | null;
}

const QUESTION_SELECT = `
  SELECT q.id, q.task_id, t.room_id, r.project_id, p.name AS project, r.name AS room, q.message_id, t.message_id AS thread_id,
         q.asker_id, ak.name AS asker, q.target_id, tg.name AS target, tg.owner_id AS target_owner_id,
         ak.owner_id AS assignee_owner_id, q.question, q.answer, ab.name AS answered_by, q.state,
         q.created_at, q.answered_at
  FROM questions q
  JOIN tasks t ON t.id = q.task_id
  JOIN rooms r ON r.id = t.room_id
  LEFT JOIN projects p ON p.id = r.project_id
  JOIN participants ak ON ak.id = q.asker_id
  JOIN participants tg ON tg.id = q.target_id
  LEFT JOIN participants ab ON ab.id = q.answered_by
`;

const MAX_QUESTION = 2_000;
const MAX_ANSWER = 4_000;

function toQuestion(row: QuestionRow): Question {
  return {
    id: row.id,
    taskId: row.task_id,
    room: row.project ? `${row.project}/${row.room}` : row.room,
    projectId: row.project_id,
    messageId: row.message_id,
    threadId: row.thread_id,
    asker: row.asker,
    target: row.target,
    question: row.question,
    answer: row.answer,
    answeredBy: row.answered_by,
    state: row.state,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
  };
}

function toSummary(q: Question): QuestionSummary {
  return {
    id: q.id,
    taskId: q.taskId,
    state: q.state,
    asker: q.asker,
    target: q.target,
    question: q.question,
    answer: q.answer,
    answeredBy: q.answeredBy,
  };
}

/**
 * Questions an agent asks while working a task. An open question puts the task in `needs_input`
 * instead of failing it; the answer @mentions the agent, and the bridge resumes it once.
 */
export class Questions {
  constructor(private readonly store: Store) {}

  ask(actor: Participant, taskId: number, text: string, to: QuestionTarget = 'requester'): Question {
    const task = this.store.tasks.get(actor, taskId);
    const assignee = this.store.participantByName(task.assignee)!;
    if (assignee.id !== actor.id) throw new OrcoError('forbidden', `Only ${task.assignee} can ask questions on task ${taskId}`);
    if (task.state === 'needs_input') throw new OrcoError('conflict', `Task ${taskId} is already waiting on question #${task.question?.id}`);
    if (task.state !== 'accepted') throw new OrcoError('conflict', `Task ${taskId} is ${task.state}; accept it before asking`);
    const question = text.trim();
    if (!question) throw new OrcoError('invalid', 'The question is empty');
    if (question.length > MAX_QUESTION) throw new OrcoError('invalid', `Questions can be at most ${MAX_QUESTION} characters`);
    if (to !== 'requester' && to !== 'owner') throw new OrcoError('invalid', 'Ask the "requester" or your "owner"');
    const target =
      to === 'owner' ? this.store.participantById(assignee.ownerId!)! : this.store.participantByName(task.requester)!;
    if (target.id === actor.id) throw new OrcoError('invalid', 'You cannot ask yourself');
    this.store.checkRate(actor, 'post');

    let id = 0;
    this.store.post(actor, task.room, `@${target.name} Question on task #${taskId}: ${question}`, task.messageId, {
      skipRateLimit: true,
      onInsert: (messageId) => {
        const { lastInsertRowid } = this.store.db
          .prepare('INSERT INTO questions (task_id, message_id, asker_id, target_id, question) VALUES (?, ?, ?, ?, ?)')
          .run(taskId, messageId, actor.id, target.id, question);
        id = Number(lastInsertRowid);
      },
    });
    const asked = this.byId(id)!;
    this.store.audit.record(actor, 'question.ask', {
      projectId: asked.projectId,
      subject: `question:${id}`,
      detail: { taskId, target: target.name, question },
    });
    this.changed(asked);
    return asked;
  }

  answer(actor: Participant, id: number, text: string): Question {
    const row = this.row(id);
    if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No question ${id}`);
    if (row.state !== 'open') throw new OrcoError('conflict', `Question ${id} is already ${row.state === 'cancelled' ? 'closed' : 'answered'}`);
    if (![row.target_id, row.target_owner_id, row.assignee_owner_id].includes(actor.id)) {
      throw new OrcoError('forbidden', `Only ${row.target} or the people responsible for it can answer question ${id}`);
    }
    const answer = text.trim();
    if (!answer) throw new OrcoError('invalid', 'The answer is empty');
    if (answer.length > MAX_ANSWER) throw new OrcoError('invalid', `Answers can be at most ${MAX_ANSWER} characters`);
    const question = toQuestion(row);
    this.store.post(actor, question.room, `@${row.asker} Answer to your question on task #${row.task_id}: ${answer}`, row.message_id, {
      skipRateLimit: true,
      onInsert: () => {
        this.store.db
          .prepare(
            "UPDATE questions SET state = 'answered', answer = ?, answered_by = ?, answered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
          )
          .run(answer, actor.id, id);
      },
    });
    const answered = this.byId(id)!;
    this.store.audit.record(actor, 'question.answer', {
      projectId: answered.projectId,
      subject: `question:${id}`,
      detail: { taskId: row.task_id, answer },
    });
    this.changed(answered);
    return answered;
  }

  /** The bridge claims an answered question once, so a restarted bridge does not resume the agent twice. */
  claimResume(actor: Participant, id: number): boolean {
    const row = this.row(id);
    if (!row || row.asker_id !== actor.id) throw new OrcoError('not_found', `No question ${id} of yours`);
    const { changes } = this.store.db.prepare("UPDATE questions SET state = 'resumed' WHERE id = ? AND state = 'answered'").run(id);
    return Number(changes) === 1;
  }

  /** Closes open questions when their task ends. */
  closeForTask(taskId: number): void {
    this.store.db.prepare("UPDATE questions SET state = 'cancelled' WHERE task_id = ? AND state = 'open'").run(taskId);
  }

  get(actor: Participant, id: number): Question {
    const row = this.row(id);
    if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No question ${id}`);
    return toQuestion(row);
  }

  /** Open questions this participant can answer: asked of them, or of an agent they own. */
  waitingOn(actor: Participant): Question[] {
    const rows = this.store.db
      .prepare(`${QUESTION_SELECT} WHERE q.state = 'open' AND (q.target_id = ? OR tg.owner_id = ?) ORDER BY q.id`)
      .all(actor.id, actor.id) as unknown as QuestionRow[];
    return rows.filter((row) => this.store.canSeeRoomId(actor, row.room_id)).map(toQuestion);
  }

  latestForTask(taskId: number): QuestionSummary | null {
    const row = this.store.db.prepare(`${QUESTION_SELECT} WHERE q.task_id = ? ORDER BY q.id DESC LIMIT 1`).get(taskId) as
      | QuestionRow
      | undefined;
    return row ? toSummary(toQuestion(row)) : null;
  }

  summaryForMessage(messageId: number): QuestionSummary | null {
    const row = this.store.db.prepare(`${QUESTION_SELECT} WHERE q.message_id = ?`).get(messageId) as QuestionRow | undefined;
    return row ? toSummary(toQuestion(row)) : null;
  }

  private changed(question: Question): void {
    this.store.events.emit('question', question);
    const task = this.store.tasks.find(question.taskId);
    if (task) this.store.events.emit('task', task);
  }

  private row(id: number): QuestionRow | undefined {
    return this.store.db.prepare(`${QUESTION_SELECT} WHERE q.id = ?`).get(id) as QuestionRow | undefined;
  }

  private byId(id: number): Question | null {
    const row = this.row(id);
    return row ? toQuestion(row) : null;
  }
}
