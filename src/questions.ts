import { OrcoError } from './errors.js';
import { MENTION_ALL, type Participant, type Store } from './store.js';

export type QuestionState = 'open' | 'answered' | 'resumed' | 'cancelled';
export type QuestionTarget = 'requester' | 'owner' | 'project';
/** `one`: asked of one participant. `project`: asked of every person who can see the task's room. */
export type QuestionAudience = 'one' | 'project';
/** A `plan` is a question whose answer is a decision: approve (possibly edited) or reject. */
export type QuestionKind = 'question' | 'plan';
export type PlanVerdict = 'approved' | 'rejected';

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
  audience: QuestionAudience;
  kind: QuestionKind;
  verdict: PlanVerdict | null;
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
  audience: QuestionAudience;
  kind: QuestionKind;
  verdict: PlanVerdict | null;
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
  audience: QuestionAudience;
  kind: QuestionKind;
  verdict: PlanVerdict | null;
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
         ak.owner_id AS assignee_owner_id, q.audience, q.kind, q.verdict, q.question, q.answer, ab.name AS answered_by, q.state,
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
    audience: row.audience,
    kind: row.kind,
    verdict: row.verdict,
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
    audience: q.audience,
    kind: q.kind,
    verdict: q.verdict,
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

  /** Proposes a plan for the owner (by default) to approve, edit or reject before the work starts. */
  proposePlan(actor: Participant, taskId: number, plan: string, to: 'owner' | 'requester' = 'owner'): Question {
    return this.ask(actor, taskId, plan, to, 'plan');
  }

  ask(actor: Participant, taskId: number, text: string, to: QuestionTarget = 'requester', kind: QuestionKind = 'question'): Question {
    const task = this.store.tasks.get(actor, taskId);
    const assignee = this.store.participantByName(task.assignee)!;
    if (assignee.id !== actor.id) throw new OrcoError('forbidden', `Only ${task.assignee} can ask questions on task ${taskId}`);
    if (task.state === 'needs_input') throw new OrcoError('conflict', `Task ${taskId} is already waiting on question #${task.question?.id}`);
    if (task.state !== 'accepted') throw new OrcoError('conflict', `Task ${taskId} is ${task.state}; accept it before asking`);
    const question = text.trim();
    if (!question) throw new OrcoError('invalid', 'The question is empty');
    const max = kind === 'plan' ? MAX_ANSWER : MAX_QUESTION;
    if (question.length > max) throw new OrcoError('invalid', `${kind === 'plan' ? 'Plans' : 'Questions'} can be at most ${max} characters`);
    if (kind === 'plan' && to === 'project') throw new OrcoError('invalid', 'Plans go to your owner or the requester, not the whole project');
    if (to !== 'requester' && to !== 'owner' && to !== 'project') {
      throw new OrcoError('invalid', 'Ask the "requester", your "owner", or the whole "project"');
    }
    const audience: QuestionAudience = to === 'project' ? 'project' : 'one';
    // A project-wide question still names the requester, who can always answer it.
    const target =
      to === 'owner' ? this.store.participantById(assignee.ownerId!)! : this.store.participantByName(task.requester)!;
    if (audience === 'one' && target.id === actor.id) throw new OrcoError('invalid', 'You cannot ask yourself');
    this.store.checkRate(actor, 'post');

    const addressee = audience === 'project' ? `@${MENTION_ALL}` : `@${target.name}`;
    let id = 0;
    const heading = kind === 'plan' ? `Plan for task #${taskId}, waiting for approval:\n` : `Question on task #${taskId}: `;
    this.store.post(actor, task.room, `${addressee} ${heading}${question}`, task.messageId, {
      skipRateLimit: true,
      onInsert: (messageId) => {
        const { lastInsertRowid } = this.store.db
          .prepare('INSERT INTO questions (task_id, message_id, asker_id, target_id, audience, kind, question) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(taskId, messageId, actor.id, target.id, audience, kind, question);
        id = Number(lastInsertRowid);
      },
    });
    const asked = this.byId(id)!;
    this.store.audit.record(actor, kind === 'plan' ? 'plan.propose' : 'question.ask', {
      projectId: asked.projectId,
      subject: `question:${id}`,
      detail: { taskId, target: audience === 'project' ? 'everyone' : target.name, question },
    });
    this.changed(asked);
    return asked;
  }

  answer(actor: Participant, id: number, text: string): Question {
    const row = this.openRow(actor, id);
    if (row.kind === 'plan') throw new OrcoError('invalid', `Question ${id} is a plan; approve or reject it`);
    const answer = text.trim();
    if (!answer) throw new OrcoError('invalid', 'The answer is empty');
    if (answer.length > MAX_ANSWER) throw new OrcoError('invalid', `Answers can be at most ${MAX_ANSWER} characters`);
    return this.resolve(actor, row, answer, null, `Answer to your question on task #${row.task_id}: ${answer}`, 'question.answer');
  }

  /** Approves a plan, optionally edited, or rejects it with a reason. */
  decidePlan(actor: Participant, id: number, decision: { approve: boolean; plan?: string; note?: string }): Question {
    // A plan approval is oversight of an agent; like any approval, only people decide it.
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people can approve or reject plans');
    const row = this.openRow(actor, id);
    if (row.kind !== 'plan') throw new OrcoError('invalid', `Question ${id} is not a plan; answer it instead`);
    const note = decision.note?.trim() ?? '';
    if (decision.approve) {
      const final = (decision.plan ?? row.question).trim();
      if (!final) throw new OrcoError('invalid', 'The approved plan is empty');
      if (final.length > MAX_ANSWER) throw new OrcoError('invalid', `Plans can be at most ${MAX_ANSWER} characters`);
      const edited = final !== row.question;
      const answer = `Approved${edited ? ' with changes' : ''}${note ? ` (${note})` : ''}. Final plan:\n${final}`;
      return this.resolve(actor, row, answer, 'approved', `Plan for task #${row.task_id} ${answer.charAt(0).toLowerCase()}${answer.slice(1)}`, 'plan.approve');
    }
    const answer = `Rejected: ${note || 'no reason given'}`;
    return this.resolve(actor, row, answer, 'rejected', `Plan for task #${row.task_id} rejected by ${actor.name}: ${note || 'no reason given'}`, 'plan.reject');
  }

  private openRow(actor: Participant, id: number): QuestionRow {
    const row = this.row(id);
    if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No question ${id}`);
    if (row.state !== 'open') throw new OrcoError('conflict', `Question ${id} is already ${row.state === 'cancelled' ? 'closed' : 'answered'}`);
    const anyPerson = row.audience === 'project' && actor.kind === 'user';
    if (!anyPerson && ![row.target_id, row.target_owner_id, row.assignee_owner_id].includes(actor.id)) {
      throw new OrcoError(
        'forbidden',
        row.audience === 'project'
          ? `Question ${id} is for the people in the project`
          : `Only ${row.target} or the people responsible for it can answer question ${id}`,
      );
    }
    return row;
  }

  private resolve(actor: Participant, row: QuestionRow, answer: string, verdict: PlanVerdict | null, message: string, action: string): Question {
    const id = row.id;
    this.store.post(actor, toQuestion(row).room, `@${row.asker} ${message}`, row.message_id, {
      skipRateLimit: true,
      onInsert: () => {
        this.store.db
          .prepare(
            "UPDATE questions SET state = 'answered', answer = ?, verdict = ?, answered_by = ?, answered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
          )
          .run(answer, verdict, actor.id, id);
      },
    });
    const answered = this.byId(id)!;
    this.store.audit.record(actor, action, {
      projectId: answered.projectId,
      subject: `question:${id}`,
      detail: { taskId: row.task_id, answer, verdict },
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

  /** Open questions this participant can answer: asked of them, of an agent they own, or of their whole project. */
  waitingOn(actor: Participant): Question[] {
    const rows = this.store.db
      .prepare(
        `${QUESTION_SELECT} WHERE q.state = 'open' AND (q.target_id = ? OR tg.owner_id = ? OR (q.audience = 'project' AND ? = 'user'))
         ORDER BY q.id`,
      )
      .all(actor.id, actor.id, actor.kind) as unknown as QuestionRow[];
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
