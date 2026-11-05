import { OrcoError } from './errors.js';
import { MENTION_ALL, type Participant, type Store } from './store.js';

export type QuestionState = 'open' | 'answered' | 'resumed' | 'cancelled';
/** One-tap passes (#135). */
export type PassReason = 'not_me' | 'use_pick' | 'not_needed';
export const PASS_TEXT: Record<PassReason, string> = { not_me: 'not me', use_pick: 'use your pick', not_needed: 'not needed' };
export type QuestionTarget = 'requester' | 'owner' | 'project';
/** `one`: asked of one participant. `project`: asked of every person who can see the task's room. */
export type QuestionAudience = 'one' | 'project';
/** A `plan` is a question whose answer is a decision: approve (possibly edited) or reject. */
export type QuestionKind = 'question' | 'plan';
export type PlanVerdict = 'approved' | 'rejected';

/** One choice in a multiple-choice question. */
export interface QuestionOption {
  label: string;
  description?: string;
}

/** Choices that make a question one tap to answer; free text ("Other") stays possible. */
export interface QuestionChoices {
  options?: QuestionOption[];
  recommended?: string;
  multiSelect?: boolean;
}

const MAX_OPTIONS = 10;
const MAX_LABEL = 80;
const MAX_OPTION_DESCRIPTION = 300;

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
  /** Choices to pick from, if it is multiple choice; free text is always allowed too. */
  options: QuestionOption[];
  recommended: string | null;
  multiSelect: boolean;
  answer: string | null;
  /** Attachments sent with the answer (#128); open images with view_image, files with read_file. */
  answerAttachments: number[];
  answeredBy: string | null;
  /** Someone passed on it (#135), and why. */
  passed: { reason: PassReason; by: string } | null;
  state: QuestionState;
  /** When the person (or agent) it was asked of first looked at it. */
  seenAt: string | null;
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
  options: QuestionOption[];
  recommended: string | null;
  multiSelect: boolean;
  answer: string | null;
  answerAttachments?: number[];
  passed?: { reason: PassReason; by: string };
  answeredBy: string | null;
  seenAt: string | null;
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
  options: string | null;
  recommended: string | null;
  multi_select: number;
  answer: string | null;
  answer_attachments: string | null;
  pass_reason: PassReason | null;
  passer: string | null;
  passed_by: number | null;
  answered_by: string | null;
  state: QuestionState;
  seen_at: string | null;
  created_at: string;
  answered_at: string | null;
}

const QUESTION_SELECT = `
  SELECT q.id, q.task_id, t.room_id, r.project_id, p.name AS project, r.name AS room, q.message_id, t.message_id AS thread_id,
         q.asker_id, ak.name AS asker, q.target_id, tg.name AS target, tg.owner_id AS target_owner_id,
         ak.owner_id AS assignee_owner_id, q.audience, q.kind, q.verdict, q.question, q.options, q.recommended, q.multi_select, q.answer, q.answer_attachments, q.pass_reason, q.passed_by, pb.name AS passer, ab.name AS answered_by, q.state,
         q.seen_at, q.created_at, q.answered_at
  FROM questions q
  JOIN tasks t ON t.id = q.task_id
  JOIN rooms r ON r.id = t.room_id
  LEFT JOIN projects p ON p.id = r.project_id
  JOIN participants ak ON ak.id = q.asker_id
  JOIN participants tg ON tg.id = q.target_id
  LEFT JOIN participants pb ON pb.id = q.passed_by
  LEFT JOIN participants ab ON ab.id = q.answered_by
`;

const MAX_QUESTION = 2_000;
const MAX_ANSWER = 4_000;

function checkOptions(choices: QuestionChoices): QuestionOption[] {
  const options = (choices.options ?? []).map((o) => ({ label: String(o?.label ?? '').trim(), ...(o?.description?.trim() ? { description: o.description.trim() } : {}) }));
  if (!options.length) {
    if (choices.recommended || choices.multiSelect) throw new OrcoError('invalid', 'recommended and multi_select go with options');
    return [];
  }
  if (options.length < 2 || options.length > MAX_OPTIONS) throw new OrcoError('invalid', `Give 2 to ${MAX_OPTIONS} options`);
  if (options.some((o) => !o.label || o.label.length > MAX_LABEL)) throw new OrcoError('invalid', `Each option needs a label of at most ${MAX_LABEL} characters`);
  if (options.some((o) => (o.description?.length ?? 0) > MAX_OPTION_DESCRIPTION)) throw new OrcoError('invalid', `Option descriptions are at most ${MAX_OPTION_DESCRIPTION} characters`);
  if (new Set(options.map((o) => o.label)).size !== options.length) throw new OrcoError('invalid', 'Option labels must differ');
  if (choices.recommended !== undefined && !options.some((o) => o.label === choices.recommended)) throw new OrcoError('invalid', 'recommended is one of the option labels');
  return options;
}

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
    options: row.options ? (JSON.parse(row.options) as QuestionOption[]) : [],
    recommended: row.recommended,
    multiSelect: row.multi_select === 1,
    answer: row.answer,
    answerAttachments: row.answer_attachments ? (JSON.parse(row.answer_attachments) as number[]) : [],
    passed: row.pass_reason ? { reason: row.pass_reason, by: row.passer ?? '' } : null,
    answeredBy: row.answered_by,
    state: row.state,
    seenAt: row.seen_at,
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
    options: q.options,
    recommended: q.recommended,
    multiSelect: q.multiSelect,
    answer: q.answer,
    ...(q.answerAttachments.length ? { answerAttachments: q.answerAttachments } : {}),
    ...(q.passed ? { passed: q.passed } : {}),
    answeredBy: q.answeredBy,
    seenAt: q.seenAt,
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

  ask(actor: Participant, taskId: number, text: string, to: QuestionTarget = 'requester', kind: QuestionKind = 'question', choices: QuestionChoices = {}): Question {
    const options = checkOptions(choices);
    if (options.length && kind === 'plan') throw new OrcoError('invalid', 'Plans are approved or rejected, not multiple choice');
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
    if (kind === 'plan') this.store.rules.enforce(actor, 'plan', question, task.room, task.projectId);
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
    const listed = options.length
      ? `\n${choices.multiSelect ? 'Pick any of' : 'Pick one'}:\n${options.map((o, i) => `${i + 1}. ${o.label}${o.label === choices.recommended ? ' (recommended)' : ''}${o.description ? ` — ${o.description}` : ''}`).join('\n')}`
      : '';
    this.store.post(actor, task.room, `${addressee} ${heading}${question}${listed}`, task.messageId, {
      skipRateLimit: true,
      onInsert: (messageId) => {
        const { lastInsertRowid } = this.store.db
          .prepare('INSERT INTO questions (task_id, message_id, asker_id, target_id, audience, kind, question, options, recommended, multi_select) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(taskId, messageId, actor.id, target.id, audience, kind, question, options.length ? JSON.stringify(options) : null, options.length ? (choices.recommended ?? null) : null, choices.multiSelect && options.length ? 1 : 0);
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

  /**
   * Answers a question: free text, or for a multiple-choice one the picked labels (any of them when it
   * allows several), with free text alongside as "Other".
   */
  answer(actor: Participant, id: number, text: string, picked: string[] = [], attachmentIds: number[] = []): Question {
    const row = this.openRow(actor, id);
    if (row.kind === 'plan') throw new OrcoError('invalid', `Question ${id} is a plan; approve or reject it`);
    const options = row.options ? (JSON.parse(row.options) as QuestionOption[]) : [];
    const chosen = [...new Set(picked.map((p) => String(p).trim()).filter(Boolean))];
    if (chosen.length && !options.length) throw new OrcoError('invalid', `Question ${id} has no options; answer in words`);
    const unknown = chosen.filter((c) => !options.some((o) => o.label === c));
    if (unknown.length) throw new OrcoError('invalid', `Not an option: ${unknown.join(', ')}. The options are ${options.map((o) => o.label).join(', ')}`);
    if (chosen.length > 1 && row.multi_select !== 1) throw new OrcoError('invalid', `Question ${id} takes one choice`);
    const other = text.trim();
    const ids = [...new Set(attachmentIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    // A photo can be the whole answer (#128).
    const sent = ids.length ? `(${ids.length === 1 ? 'a file' : `${ids.length} files`} attached)` : '';
    const words = chosen.length ? `${chosen.join(', ')}${other ? `. Other: ${other}` : ''}` : other;
    const answer = words && sent ? `${words} ${sent}` : words || sent;
    if (!answer) throw new OrcoError('invalid', 'The answer is empty');
    if (answer.length > MAX_ANSWER) throw new OrcoError('invalid', `Answers can be at most ${MAX_ANSWER} characters`);
    return this.resolve(actor, row, answer, null, `Answer to your question on task #${row.task_id}: ${answer}`, 'question.answer', ids);
  }

  /**
   * Passes on a question with one tap (#135). Each reason reaches the asking agent as its next message.
   *   not_me: opens it to everyone in the project now (the escalation path), and leaves the passer's list.
   *   use_pick: answers with the option the agent recommended.
   *   not_needed: closes it; the agent carries on without an answer.
   */
  pass(actor: Participant, id: number, reason: PassReason): Question {
    if (!['not_me', 'use_pick', 'not_needed'].includes(reason)) throw new OrcoError('invalid', 'Pass with not_me, use_pick or not_needed');
    const row = this.openRow(actor, id);
    if (row.kind === 'plan') throw new OrcoError('invalid', `Question ${id} is a plan; approve or reject it`);
    const mark = () => this.store.db.prepare('UPDATE questions SET pass_reason = ?, passed_by = ? WHERE id = ?').run(reason, actor.id, id);
    if (reason === 'use_pick') {
      if (!row.recommended) throw new OrcoError('invalid', `Question ${id} has no recommended option`);
      mark();
      return this.answer(actor, id, '', [row.recommended]);
    }
    if (reason === 'not_needed') {
      mark();
      return this.resolve(
        actor,
        row,
        'No answer needed: carry on without one.',
        null,
        `${actor.name} passed on your question on task #${row.task_id}: not needed. Carry on without an answer.`,
        'question.pass',
      );
    }
    // Not me: everyone in the project can answer, now.
    if (row.project_id === null) throw new OrcoError('invalid', `Question ${id} is in a server room, which has no project to open it to; answer it or pass with not needed`);
    const asker = this.store.participantById(row.asker_id)!;
    const widen = row.audience === 'one';
    this.store.post(
      actor,
      toQuestion(row).room,
      `@${asker.name} ${actor.name} passed on your question on task #${row.task_id}: not me.${widen ? ` @${MENTION_ALL} anyone in the project can answer question ${row.id}: ${row.question.replace(/@/g, '＠')}` : ''}`,
      row.thread_id,
      {
        skipRateLimit: true,
        onInsert: () => {
          mark();
          if (widen) this.store.db.prepare("UPDATE questions SET audience = 'project', escalated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
        },
      },
    );
    const passed = this.byId(id)!;
    this.store.audit.record(actor, 'question.pass', { projectId: passed.projectId, subject: `question:${id}`, detail: { reason, widened: widen } });
    this.changed(passed);
    return passed;
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

  private resolve(actor: Participant, row: QuestionRow, answer: string, verdict: PlanVerdict | null, message: string, action: string, attachmentIds: number[] = []): Question {
    const id = row.id;
    this.store.post(actor, toQuestion(row).room, `@${row.asker} ${message}`, row.message_id, {
      skipRateLimit: true,
      // The answer's attachments go on the message it posts in the thread, so the asker sees them with it.
      attachmentIds,
      onInsert: () => {
        this.store.db
          .prepare(
            "UPDATE questions SET state = 'answered', answer = ?, answer_attachments = ?, verdict = ?, answered_by = ?, answered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
          )
          .run(answer, attachmentIds.length ? JSON.stringify(attachmentIds) : null, verdict, actor.id, id);
      },
    });
    const answered = this.byId(id)!;
    this.store.audit.record(actor, action, {
      projectId: answered.projectId,
      subject: `question:${id}`,
      detail: { taskId: row.task_id, answer, verdict, ...(attachmentIds.length ? { attachments: this.store.attachments.auditDetail(attachmentIds) } : {}) },
    });
    // The answer lands where the work is tracked: on the task's ticket, and (from a person) as a decision
    // other agents can look up instead of asking again.
    if (row.kind === 'question') {
      const ticketId = this.store.tickets.ticketIdForTask(row.task_id);
      if (ticketId !== null) this.store.tickets.note(ticketId, actor, 'comment', `Question from ${row.asker}: ${row.question}\n\nAnswer: ${answer}`);
      if (row.project_id !== null) {
        const options = row.options ? (JSON.parse(row.options) as QuestionOption[]).map((o) => o.label) : [];
        this.store.decisions.fromAnswer(actor, { projectId: row.project_id, ticketId, questionId: id, question: row.question, answer, options, context: `${row.asker} asked on task #${row.task_id}.` });
      }
    }
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
           AND (q.passed_by IS NULL OR q.passed_by != ?)
         ORDER BY q.id`,
      )
      .all(actor.id, actor.id, actor.kind, actor.id) as unknown as QuestionRow[];
    return rows.filter((row) => this.store.canSeeRoomId(actor, row.room_id)).map(toQuestion);
  }

  /**
   * Questions asked of one participant that have gone unanswered for `escalateHours` are opened to
   * every person in the project, once, so a task does not wait forever on someone who is away.
   * Plans are not widened: only the owner or requester decides those.
   */
  escalateDue(): Question[] {
    const hours = this.store.limits.escalateHours;
    if (hours <= 0) return [];
    const cutoff = new Date(this.store.now() - hours * 3600_000).toISOString();
    const rows = this.store.db
      .prepare(`${QUESTION_SELECT} WHERE q.state = 'open' AND q.kind = 'question' AND q.audience = 'one' AND q.escalated_at IS NULL AND q.created_at < ?`)
      .all(cutoff) as unknown as QuestionRow[];
    const widened: Question[] = [];
    for (const row of rows) {
      if (row.project_id === null) {
        this.store.db.prepare("UPDATE questions SET escalated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(row.id);
        continue;
      }
      const asker = this.store.participantById(row.asker_id)!;
      const room = toQuestion(row).room;
      this.store.post(
        asker,
        room,
        `@${MENTION_ALL} No answer from ${row.target} for ${hours} hours, so anyone in the project can answer question ${row.id}: ${row.question.replace(/@/g, '＠')}`,
        row.thread_id,
        {
          skipRateLimit: true,
          onInsert: () => {
            this.store.db
              .prepare("UPDATE questions SET audience = 'project', escalated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
              .run(row.id);
          },
        },
      );
      const question = this.byId(row.id)!;
      this.store.audit.record(null, 'question.escalate', { projectId: row.project_id, subject: `question:${row.id}`, detail: { from: row.target, hours } });
      this.changed(question);
      widened.push(question);
    }
    return widened;
  }

  /** Records the first look at open questions by someone they were asked of (for a project question, any person in it). */
  markSeen(actor: Participant, ids: number[]): void {
    for (const id of new Set(ids)) {
      const row = this.row(id);
      if (!row || row.state !== 'open' || row.seen_at !== null || !this.store.canSeeRoomId(actor, row.room_id)) continue;
      const askedOf = row.target_id === actor.id || (row.audience === 'project' && actor.kind === 'user' && actor.id !== row.asker_id);
      if (!askedOf) continue;
      this.store.db.prepare("UPDATE questions SET seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND seen_at IS NULL").run(id);
      this.changed(this.byId(id)!);
    }
  }

  /** Marks open questions in a thread seen, when someone they were asked of opens it. */
  markThreadSeen(actor: Participant, threadId: number): void {
    const ids = this.store.db
      .prepare("SELECT q.id FROM questions q JOIN tasks t ON t.id = q.task_id WHERE t.message_id = ? AND q.state = 'open' AND q.seen_at IS NULL")
      .all(threadId) as unknown as { id: number }[];
    if (ids.length) this.markSeen(actor, ids.map((r) => r.id));
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
