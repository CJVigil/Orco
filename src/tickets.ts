import type { OrderRule } from './order.js';
import type { ScopeStatus } from './scope.js';
import type { TicketCommit } from './commits.js';
import type { Artifact } from './artifacts.js';
import type { TicketFile } from './ticketfiles.js';
import { OrcoError } from './errors.js';
import type { Participant, Project, Store } from './store.js';
import { OPEN_STATES, stepsOf, type Task, type TaskState } from './tasks.js';

export type StatusCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';
export const STATUS_CATEGORIES: readonly StatusCategory[] = ['backlog', 'unstarted', 'started', 'completed', 'canceled'];
export const PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const LABEL_COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#d6409f', '#8d8d8d'];

const DEFAULT_STATUSES: [string, StatusCategory][] = [
  ['Backlog', 'backlog'],
  ['Todo', 'unstarted'],
  ['In Progress', 'started'],
  ['In Review', 'started'],
  ['Done', 'completed'],
  ['Canceled', 'canceled'],
];

const REF = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,9})$/;
/** How a linked ticket in a project the viewer cannot see is named. */
export const HIDDEN_REF = '(hidden)';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LABEL_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._/-]{0,31}$/u;
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 20_000;
export const MAX_COMMENT = 10_000;
export const MAX_HANDOFF = 4_000;
export const MAX_BLOCKED_REASON = 200;
export const MAX_CRITERIA = 50;
export const MAX_CRITERION = 300;
/** Tickets one update_tickets call may change. */
export const MAX_BULK = 50;
/** A next step and a waiting-on ask are one line each, to read at a glance. */
export const MAX_LINE = 140;
/** Quick replies an agent may offer for a waiting-on ask, and how long each may be. */
export const MAX_WAITING_OPTIONS = 6;
export const MAX_WAITING_OPTION = 40;

/**
 * The quick replies for a waiting-on ask: the agent's own when it chose them, else Yes / No for an
 * ask that is a question (so "Done" never has to mean "yes"), else Done. Not yet and a one-line reply
 * are always offered besides these.
 */
export function waitingChoices(ask: string, stored: string | null): string[] {
  if (stored) {
    try {
      const list = JSON.parse(stored) as unknown;
      if (Array.isArray(list) && list.length && list.every((o) => typeof o === 'string')) return list as string[];
    } catch {
      // Fall through to the defaults.
    }
  }
  return ask.trim().endsWith('?') ? ['Yes', 'No'] : ['Done'];
}

function checkWaitingOptions(options: string[]): string[] {
  if (!Array.isArray(options) || options.length === 0 || options.length > MAX_WAITING_OPTIONS) {
    throw new OrcoError('invalid', `waiting_options is a list of 1 to ${MAX_WAITING_OPTIONS} replies`);
  }
  const seen = new Set<string>();
  return options.map((option) => {
    const label = String(option ?? '').replace(/\s+/g, ' ').trim();
    if (!label || label.length > MAX_WAITING_OPTION) throw new OrcoError('invalid', `Each of waiting_options is 1 to ${MAX_WAITING_OPTION} characters`);
    const key = label.toLowerCase();
    if (key === 'not yet' || key === 'not_yet') throw new OrcoError('invalid', 'Not yet is always offered; leave it out of waiting_options');
    if (seen.has(key)) throw new OrcoError('invalid', `waiting_options lists "${label}" twice`);
    seen.add(key);
    return label;
  });
}

type Change = { field: string; from: unknown; to: unknown };
const DEFAULT_CYCLE_DAYS = 14;
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export interface TicketStatus {
  id: number;
  name: string;
  category: StatusCategory;
  position: number;
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

/** A folder inside a project, grouping tickets by area (#91), with its open and total ticket counts. */
export interface Folder {
  id: number;
  name: string;
  emoji: string | null;
  color: string | null;
  position: number;
  open: number;
  total: number;
}

export const MAX_FOLDERS = 100;
/** Folder names: 1-40 characters on one line; "none" is kept for "no folder" in filters. */
const FOLDER_NAME = /^[^\s\p{C}](?:[^\p{C}]{0,38}[^\s\p{C}])?$/u;

export interface Progress {
  tickets: number;
  completed: number;
  points: number;
  completedPoints: number;
}

export interface Milestone {
  id: number;
  name: string;
  description: string;
  targetDate: string | null;
  progress: Progress;
}

export interface Cycle {
  id: number;
  number: number;
  name: string;
  startsOn: string;
  endsOn: string;
  completedAt: string | null;
  current: boolean;
  progress: Progress;
}

export interface TicketSummary {
  id: number;
  /** Seen only by the people on it, project admins and their agents (#97). */
  private: boolean;
  /** What a not-yet-started ticket waits on under the build order rules (#109), like ["Skeleton"]. */
  waitsOn: string[];
  ref: string;
  project: string;
  projectId: number;
  number: number;
  title: string;
  status: { id: number; name: string; category: StatusCategory };
  priority: Priority;
  estimate: number | null;
  dueDate: string | null;
  assignee: { name: string; kind: 'user' | 'agent' } | null;
  labels: Label[];
  milestone: { id: number; name: string } | null;
  cycle: { id: number; number: number } | null;
  /** The folder it sits in, if any. */
  folder: { id: number; name: string; emoji: string | null } | null;
  parent: string | null;
  /** Its agent task, with how far the agent's checklist is (#94). */
  task: { id: number; state: TaskState; since: string; steps: { done: number; total: number } | null } | null;
  /** Unfinished tickets this one waits on. */
  blockedBy: string[];
  /** Something outside the project this ticket waits on, like "waiting on the vendor". */
  blockedReason: string | null;
  /** Waiting on an unfinished ticket or on something outside. */
  blocked: boolean;
  criteria: { done: number; total: number };
  /** The one next thing to do, and who it is for. */
  nextStep: { text: string; for: string | null } | null;
  /**
   * The person it waits on, the ask, since when, until when it is snoozed, and the quick replies they
   * get (besides Not yet and a one-line reply).
   */
  waitingOn: { person: string; ask: string; since: string; snoozedUntil: string | null; options: string[] } | null;
  /** When it last moved to another status (or was filed). */
  statusChangedAt: string;
  sort: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface TicketActivity {
  id: number;
  actor: string | null;
  actorKind: 'user' | 'agent' | null;
  kind: 'created' | 'change' | 'comment' | 'task';
  body: string | null;
  detail: unknown;
  createdAt: string;
}

export interface TicketLink {
  ref: string;
  title: string;
  status: string;
  category: StatusCategory;
}

export interface Ticket extends TicketSummary {
  /** Files on the ticket and its comments (#98). */
  files: TicketFile[];
  /** Commits that name it, with their CI result (#107). */
  commits: TicketCommit[];
  /** What agents have spent on it: tokens and cents (#106). */
  spend: { tokens: number; cents: number };
  /** Pages published on the ticket (#99). */
  artifacts: Omit<Artifact, 'versions'>[];
  description: string;
  creator: string;
  /** Where whoever works this ticket left off: done, next, branch or PR, gotchas. */
  handoff: { text: string; by: string | null; at: string | null } | null;
  /** required: must be checked before Done (#110); template: the label whose checklist added it. */
  criteriaItems: { id: number; text: string; done: boolean; required: boolean; template: string | null }[];
  blockers: TicketLink[];
  blocking: TicketLink[];
  children: TicketSummary[];
  activity: TicketActivity[];
  /** The newest activity id; pass it back as `since` to read only what changed. */
  lastActivityId: number;
  /** Closed as a duplicate of, or superseded by, another ticket. */
  closedAs: { reason: 'duplicate' | 'superseded'; ticket: TicketLink } | null;
  /** Tickets closed as duplicates of this one, or superseded by it. */
  replaces: (TicketLink & { reason: 'duplicate' | 'superseded' })[];
  /** What people decided about it (answers to questions, approvals given), newest first. */
  decisions: { id: number; title: string; decision: string; decidedBy: string; at: string }[];
  /** Approvals asked for on it, with their scope and how long they stay in force. */
  approvals: {
    id: number;
    summary: string;
    scope: string | null;
    state: string;
    decidedBy: string | null;
    validUntil: string | null;
    inForce: boolean;
    actionKind: string | null;
    standing: boolean;
  }[];
}

/** A link to the agent session that did the work (#105): https only, stored as a link, never content. */
export function sessionLink(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new OrcoError('invalid', 'session_url is a link, like https://claude.ai/code/session_…');
  }
  if (url.protocol !== 'https:' || url.href.length > 500) throw new OrcoError('invalid', 'session_url is an https link of at most 500 characters');
  return url.href;
}

export interface TicketInput {
  /** Close it Done with required checklist items open: a project or org admin's one-line reason (#110). */
  doneOverride?: string;
  /** The agent session behind this change (#105), shown as "Open session" on its entry. */
  sessionUrl?: string | null;
  /** Uploads (POST /api/ticket-files) to attach to the ticket (#98). */
  attachmentIds?: number[];
  /** Private (#97): only its creator, assignee, waiting-on person, project admins and their agents see it. */
  private?: boolean;
  title?: string;
  description?: string;
  status?: string;
  priority?: Priority;
  estimate?: number | null;
  dueDate?: string | null;
  assignee?: string | null;
  labels?: string[];
  milestone?: string | null;
  cycle?: number | 'current' | null;
  /** The folder to put it in, by name; null or empty takes it out of its folder. */
  folder?: string | null;
  parent?: string | null;
  sort?: number;
  handoff?: string;
  criteriaAdd?: string[];
  criteriaDone?: number[];
  criteriaUndone?: number[];
  /** People only: an agent cannot drop the bar it is measured against. */
  criteriaRemove?: number[];
  blockedByAdd?: string[];
  blockedByRemove?: string[];
  /** Mark the ticket blocked on something outside the project; empty clears it. */
  blockedReason?: string;
  /** The one next thing to do, at most 140 characters; empty clears it. */
  nextStep?: string;
  /** Who the next step is for (a person or agent), or null. */
  nextStepFor?: string | null;
  /** One person this ticket waits on, with a one-line ask; null or empty clears it. */
  waitingOn?: string | null;
  waitingAsk?: string;
  /** The quick replies for the ask (default Yes / No for a question, else Done); null resets them. */
  waitingOptions?: string[] | null;
  /** Close it (Canceled) as a duplicate of this ticket, or as superseded by it. */
  duplicateOf?: string;
  supersededBy?: string;
}

export interface TicketFilter {
  project?: string;
  status?: string;
  categories?: StatusCategory[];
  open?: boolean;
  assignee?: string;
  label?: string;
  milestone?: string;
  cycle?: number | 'current';
  /** A folder by name, or "none" for tickets in no folder. */
  folder?: string;
  priority?: Priority;
  parent?: string;
  /** Only blocked tickets (true) or only unblocked ones (false). */
  blocked?: boolean;
  query?: string;
  limit?: number;
}

export interface ProjectPlan {
  /** The scope gate (#108): where the project stands, and what SCOPE.md still needs. */
  scope: ScopeStatus;
  /** Build order rules that apply here, the org's first (#109). */
  orderRules: OrderRule[];
  project: string;
  key: string;
  statuses: TicketStatus[];
  labels: Label[];
  milestones: Milestone[];
  cycles: Cycle[];
  folders: Folder[];
  members: { name: string; kind: 'user' | 'agent'; owner: string | null }[];
}

export interface Written {
  ticket: Ticket;
  warning?: string;
}

interface TicketRow {
  id: number;
  private: number;
  creator_id: number;
  project_id: number;
  project: string;
  ticket_key: string;
  number: number;
  title: string;
  description: string;
  status_id: number;
  status_name: string;
  category: StatusCategory;
  priority: number;
  estimate: number | null;
  due_date: string | null;
  assignee_id: number | null;
  assignee: string | null;
  assignee_kind: 'user' | 'agent' | null;
  creator: string;
  parent_id: number | null;
  parent_number: number | null;
  milestone_id: number | null;
  milestone: string | null;
  cycle_id: number | null;
  cycle_number: number | null;
  task_id: number | null;
  task_state: TaskState | null;
  task_since: string | null;
  task_steps: string | null;
  task_approval_state: string | null;
  task_open_question: number | null;
  handoff: string;
  handoff_by: string | null;
  handoff_at: string | null;
  blocked_reason: string;
  closed_reason: 'duplicate' | 'superseded' | null;
  next_step: string | null;
  next_step_for: string | null;
  waiting_on_id: number | null;
  waiting_on: string | null;
  waiting_ask: string | null;
  waiting_since: string | null;
  waiting_snoozed_until: string | null;
  waiting_options: string | null;
  folder_id: number | null;
  folder: string | null;
  folder_emoji: string | null;
  status_changed_at: string | null;
  closed_for: number | null;
  sort: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const TICKET_SELECT = `
  SELECT t.id, t.project_id, p.name AS project, p.ticket_key, t.number, t.title, t.description,
         t.status_id, s.name AS status_name, s.category, t.priority, t.estimate, t.due_date,
         t.assignee_id, a.name AS assignee, a.kind AS assignee_kind, c.name AS creator,
         t.parent_id, pt.number AS parent_number, t.milestone_id, m.name AS milestone,
         t.cycle_id, cy.number AS cycle_number, t.task_id, tk.state AS task_state, tk.updated_at AS task_since, tk.steps AS task_steps,
         ap.state AS task_approval_state,
         (SELECT q.id FROM questions q WHERE q.task_id = t.task_id AND q.state = 'open') AS task_open_question,
         t.handoff, hb.name AS handoff_by, t.handoff_at, t.blocked_reason, t.closed_reason, t.closed_for,
         t.next_step, nsf.name AS next_step_for, t.waiting_on AS waiting_on_id, wo.name AS waiting_on, t.waiting_ask, t.waiting_since, t.waiting_snoozed_until, t.waiting_options, t.status_changed_at,
         t.folder_id, f.name AS folder, f.emoji AS folder_emoji,
         t.sort, t.created_at, t.updated_at, t.started_at, t.completed_at, t.private, t.creator_id
  FROM tickets t
  JOIN projects p ON p.id = t.project_id
  JOIN ticket_statuses s ON s.id = t.status_id
  JOIN participants c ON c.id = t.creator_id
  LEFT JOIN participants a ON a.id = t.assignee_id
  LEFT JOIN tickets pt ON pt.id = t.parent_id
  LEFT JOIN milestones m ON m.id = t.milestone_id
  LEFT JOIN cycles cy ON cy.id = t.cycle_id
  LEFT JOIN tasks tk ON tk.id = t.task_id
  LEFT JOIN approvals ap ON ap.id = tk.approval_id
  LEFT JOIN participants hb ON hb.id = t.handoff_by
  LEFT JOIN participants nsf ON nsf.id = t.next_step_for
  LEFT JOIN participants wo ON wo.id = t.waiting_on
  LEFT JOIN ticket_folders f ON f.id = t.folder_id
`;

/** How far an agent's checklist is, for the ticket card's bar (#94). */
function stepCount(json: string | null): { done: number; total: number } | null {
  const steps = stepsOf(json);
  return steps.length ? { done: steps.filter((s) => s.state === 'done').length, total: steps.length } : null;
}

/** One line of at most MAX_LINE characters (newlines become spaces). */
function oneLine(value: string, what: string): string {
  const line = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (line.length > MAX_LINE) throw new OrcoError('invalid', `${what} is one line of at most ${MAX_LINE} characters`);
  return line;
}

function keyBase(name: string): string {
  const parts = name.split('-').filter(Boolean);
  let base = (parts.length > 1 ? parts.map((part) => part[0]).join('').slice(0, 4) : name.slice(0, 3)).toUpperCase();
  if (!/^[A-Z]/.test(base)) base = `P${base}`;
  return base.slice(0, 5);
}

function checkDate(value: string | null | undefined, what: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new OrcoError('invalid', `${what} must be a date like 2026-11-30`);
  }
  return value;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function taskState(row: { task_state: TaskState | null; task_approval_state: string | null; task_open_question: number | null }): TaskState | null {
  if (row.task_state === 'requested' && row.task_approval_state === 'pending') return 'awaiting_approval';
  if (row.task_state === 'accepted' && row.task_open_question !== null) return 'needs_input';
  return row.task_state;
}

function refOf(row: { ticket_key: string; number: number }): string {
  return `${row.ticket_key}-${row.number}`;
}

interface ProgressRow {
  tickets: number;
  completed: number | null;
  points: number | null;
  completed_points: number | null;
}

function progressOf(row: ProgressRow): Progress {
  return { tickets: row.tickets, completed: row.completed ?? 0, points: row.points ?? 0, completedPoints: row.completed_points ?? 0 };
}

/** Progress counts for a milestone or cycle; canceled tickets do not count. */
function progressColumns(column: 'milestone_id' | 'cycle_id', alias: string): string {
  const from = `FROM tickets t JOIN ticket_statuses s ON s.id = t.status_id WHERE t.${column} = ${alias}.id`;
  return `(SELECT count(*) ${from} AND s.category != 'canceled') AS tickets,
    (SELECT count(*) ${from} AND s.category = 'completed') AS completed,
    (SELECT sum(coalesce(t.estimate, 0)) ${from} AND s.category != 'canceled') AS points,
    (SELECT sum(coalesce(t.estimate, 0)) ${from} AND s.category = 'completed') AS completed_points`;
}

const STAGE: Record<string, number> = { started: 0, unstarted: 1, backlog: 2, completed: 3, canceled: 4 };
const URGENCY: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

/** Orders open work: in progress first, then by priority, then most recently touched. */
export function byWorkOrder(a: TicketSummary, b: TicketSummary): number {
  return (
    STAGE[a.status.category]! - STAGE[b.status.category]! ||
    URGENCY[a.priority] - URGENCY[b.priority] ||
    b.updatedAt.localeCompare(a.updatedAt)
  );
}

export class Tickets {
  constructor(private readonly store: Store) {
    store.events.on('handoff', ({ from, to }: { from: Task; to: Task }) => {
      try {
        this.onHandoff(from, to);
      } catch (err) {
        console.error(`Could not move the ticket for task ${from.id} to task ${to.id}:`, err);
      }
    });
    store.events.on('task', (task: Task) => {
      // The task change is already committed; a failure here must not surface as a failed task update.
      try {
        this.onTask(task);
      } catch (err) {
        console.error(`Could not update the ticket for task ${task.id}:`, err);
      }
    });
  }

  /** Gives a project its ticket key and default workflow if it has none yet. */
  setup(projectId: number): void {
    const project = this.store.db.prepare('SELECT name, ticket_key FROM projects WHERE id = ?').get(projectId) as
      | { name: string; ticket_key: string | null }
      | undefined;
    if (!project) return;
    if (project.ticket_key === null) {
      const base = keyBase(project.name);
      const taken = this.store.db.prepare('SELECT 1 FROM projects WHERE ticket_key = ?');
      let key = base;
      for (let n = 2; taken.get(key) !== undefined; n++) key = `${base}${n}`;
      this.store.db.prepare('UPDATE projects SET ticket_key = ? WHERE id = ?').run(key, projectId);
    }
    const hasStatuses = this.store.db.prepare('SELECT 1 FROM ticket_statuses WHERE project_id = ?').get(projectId);
    if (!hasStatuses) {
      const insert = this.store.db.prepare('INSERT INTO ticket_statuses (project_id, name, category, position) VALUES (?, ?, ?, ?)');
      DEFAULT_STATUSES.forEach(([name, category], i) => insert.run(projectId, name, category, i));
    }
  }

  /* Tickets */

  create(actor: Participant, project: string, input: TicketInput & { title: string }, options: { dispatch?: boolean } = {}): Written {
    const proj = this.writable(actor, project);
    this.store.checkRate(actor, 'post');
    // Checked before anything is written, so a bad one leaves no half-made ticket.
    if (input.nextStep !== undefined) oneLine(input.nextStep, 'The next step');
    if (input.waitingOn) {
      const person = this.store.participantByName(input.waitingOn.replace(/^@/, ''));
      if (!person || person.kind !== 'user' || !this.store.canSee(person, proj.id)) throw new OrcoError('invalid', `waiting_on is a person who can see ${proj.name}`);
      if (!oneLine(input.waitingAsk ?? '', 'The ask')) throw new OrcoError('invalid', 'Say in one line what you need from them (waiting_ask)');
      if (input.waitingOptions) checkWaitingOptions(input.waitingOptions);
    }
    const title = this.title(input.title);
    const description = this.description(input.description ?? '');
    const status = input.status ? this.statusByName(proj.id, input.status) : this.statuses(proj.id).find((s) => s.category === 'backlog' || s.category === 'unstarted')!;
    if (input.status) this.store.scope.assertBuildAllowed(proj.id, input.labels ?? [], status.category);
    const assignee = input.assignee ? this.assignable(proj.id, input.assignee) : null;
    const labels = this.labelIds(proj.id, input.labels ?? []);
    const milestoneId = input.milestone ? this.milestoneByName(proj.id, input.milestone).id : null;
    const cycleId = input.cycle === undefined || input.cycle === null ? null : this.cycleRef(proj.id, input.cycle).id;
    const folderId = input.folder?.trim() ? this.folderByName(proj.id, input.folder).id : null;
    const parentId = input.parent ? this.parentRow(actor, proj.id, input.parent, null).id : null;
    const priority = this.priority(input.priority ?? 'none');
    const estimate = this.estimate(input.estimate ?? null);
    const dueDate = checkDate(input.dueDate, 'Due date');
    const criteria = (input.criteriaAdd ?? []).map((text) => text.trim()).filter(Boolean);
    if (criteria.length > MAX_CRITERIA) throw new OrcoError('invalid', `A ticket can have at most ${MAX_CRITERIA} criteria`);
    for (const text of criteria) if (text.length > MAX_CRITERION) throw new OrcoError('invalid', `A criterion can be at most ${MAX_CRITERION} characters`);
    if (input.attachmentIds?.length) this.store.ticketFiles.check(actor, proj.id, input.attachmentIds);
    const blockers = [...new Set(input.blockedByAdd ?? [])].map((ref) => this.byRef(actor, ref));
    const handoff = (input.handoff ?? '').trim();
    const blockedReason = (input.blockedReason ?? '').trim().replace(/\s+/g, ' ');
    if (blockedReason.length > MAX_BLOCKED_REASON) throw new OrcoError('invalid', `A blocked reason can be at most ${MAX_BLOCKED_REASON} characters`);
    if (handoff.length > MAX_HANDOFF) throw new OrcoError('invalid', `Handoff notes can be at most ${MAX_HANDOFF} characters`);

    this.store.begin();
    let id: number;
    try {
      const { number } = this.store.db
        .prepare('UPDATE projects SET next_ticket = next_ticket + 1 WHERE id = ? RETURNING next_ticket - 1 AS number')
        .get(proj.id) as { number: number };
      const sort = input.sort ?? this.topSort(status.id);
      const { lastInsertRowid } = this.store.db
        .prepare(
          `INSERT INTO tickets (project_id, number, title, description, status_id, priority, estimate, due_date, assignee_id,
             creator_id, parent_id, milestone_id, cycle_id, folder_id, sort, started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             CASE WHEN ? = 'started' THEN ${NOW_SQL} END, CASE WHEN ? IN ('completed', 'canceled') THEN ${NOW_SQL} END)`,
        )
        .run(proj.id, number, title, description, status.id, priority, estimate, dueDate, assignee?.id ?? null, actor.id, parentId,
          milestoneId, cycleId, folderId, sort, status.category, status.category);
      id = Number(lastInsertRowid);
      const link = this.store.db.prepare('INSERT INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)');
      for (const labelId of labels) link.run(id, labelId);
      this.applyChecklists(id, proj.id, this.labelNames(labels), criteria);
      const criterion = this.store.db.prepare('INSERT INTO ticket_criteria (ticket_id, text, position) VALUES (?, ?, ?)');
      criteria.forEach((text, i) => criterion.run(id, text, i));
      const blocked = this.store.db.prepare('INSERT INTO ticket_links (blocker_id, blocked_id) VALUES (?, ?)');
      for (const blocker of blockers) blocked.run(blocker.id, id);
      if (handoff) {
        this.store.db.prepare(`UPDATE tickets SET handoff = ?, handoff_by = ?, handoff_at = ${NOW_SQL} WHERE id = ?`).run(handoff, actor.id, id);
      }
      if (blockedReason) this.store.db.prepare('UPDATE tickets SET blocked_reason = ? WHERE id = ?').run(blockedReason, id);
      if (input.private) this.store.db.prepare('UPDATE tickets SET private = 1 WHERE id = ?').run(id);
      if (input.attachmentIds?.length) this.store.ticketFiles.attach(id, null, input.attachmentIds);
      this.activity(id, actor, 'created', null, null);
      this.store.commit();
    } catch (err) {
      this.store.rollback();
      throw err;
    }
    const created = this.row(id)!;
    this.store.audit.record(actor, 'ticket.create', { projectId: proj.id, subject: `ticket:${refOf(created)}`, detail: { title } });
    if (input.nextStep || input.waitingOn) {
      this.store.withoutRateLimit(() =>
        this.update(actor, refOf(created), { nextStep: input.nextStep, nextStepFor: input.nextStepFor, waitingOn: input.waitingOn, waitingAsk: input.waitingAsk, waitingOptions: input.waitingOptions }),
      );
    }
    const dispatch = options.dispatch ?? true;
    const warning = dispatch && assignee?.kind === 'agent' && assignee.id !== actor.id ? this.dispatch(actor, created) : undefined;
    this.changed(created);
    return { ticket: this.detail(actor, id), ...(warning ? { warning } : {}) };
  }

  /**
   * The person a ticket waits on answers in one tap: one of the ask's quick replies (Yes / No for a
   * question, Done otherwise, or the agent's own) clears it, "not_yet" snoozes it a day, anything else
   * is a one-line reply that clears it. Each posts a comment and wakes the agent
   * the ticket is assigned to, so the work goes on without anyone relaying the answer.
   */
  replyWaiting(actor: Participant, ref: string, reply: string): Ticket {
    const row = this.byRef(actor, ref);
    if (!row.waiting_on) throw new OrcoError('conflict', `${refOf(row)} is not waiting on anyone`);
    if (actor.id !== row.waiting_on_id) throw new OrcoError('forbidden', `${refOf(row)} waits on ${row.waiting_on}, not you`);
    const text = String(reply ?? '').trim();
    const choices = waitingChoices(row.waiting_ask ?? '', row.waiting_options);
    if (!text) throw new OrcoError('invalid', `Reply ${[...choices, 'not_yet'].map((c) => `"${c}"`).join(', ')} or a line of text`);
    const snooze = text === 'not_yet';
    // A quick reply reaches the agent as the literal choice, so "Yes" never has to be read from "Done".
    const choice = choices.find((c) => c.toLowerCase() === text.toLowerCase()) ?? (text === 'done' ? 'Done' : null);
    const line = snooze ? 'Not yet (asked again tomorrow)' : choice ?? oneLine(text, 'A reply');
    this.store.begin();
    try {
      this.activity(row.id, actor, 'comment', `${actor.name} on "${row.waiting_ask}": ${line}`, null);
      if (snooze) {
        this.store.db.prepare(`UPDATE tickets SET waiting_snoozed_until = ?, updated_at = ${NOW_SQL} WHERE id = ?`).run(new Date(this.store.now() + 24 * 3600_000).toISOString(), row.id);
      } else {
        this.store.db
          .prepare(`UPDATE tickets SET waiting_on = NULL, waiting_ask = NULL, waiting_since = NULL, waiting_snoozed_until = NULL, waiting_options = NULL, updated_at = ${NOW_SQL} WHERE id = ?`)
          .run(row.id);
        this.activity(row.id, actor, 'change', null, { changes: [{ field: 'waitingOn', from: row.waiting_on, to: null }] });
      }
      this.store.commit();
    } catch (err) {
      this.store.rollback();
      throw err;
    }
    this.store.audit.record(actor, 'ticket.waiting_reply', { projectId: row.project_id, subject: `ticket:${refOf(row)}`, detail: { ask: row.waiting_ask, reply: line } });
    this.wakeAssignee(row, `${actor.name} answered "${row.waiting_ask}" on ${refOf(row)}: ${line}`);
    this.changed(row);
    return this.detail(actor, row.id);
  }

  /** Tells the agent a ticket is assigned to that something it waited for happened. */
  private wakeAssignee(row: TicketRow, note: string): void {
    if (row.assignee_kind !== 'agent' || row.assignee_id === null) return;
    const agent = this.store.participantById(row.assignee_id)!;
    const task = row.task_id !== null && OPEN_STATES.includes(taskState(row)!) ? this.store.tasks.find(row.task_id) : null;
    const system = this.store.system();
    if (!system) return;
    // A mention reaches an agent waiting on wait_for_mentions; the wake reaches its bridge.
    const room = task ? task.room : this.workRoom(row.project_id);
    this.store.post(system, room, `@${agent.name} ${note.replace(/@/g, '＠')}`, task?.messageId, { skipRateLimit: true });
    if (task) this.store.events.emit('wake', { reminderId: 0, taskId: task.id, agentId: agent.id, agent: agent.name, note });
  }

  /** Open tickets waiting on this person (snoozed ones only once their snooze ends). */
  waitingFor(actor: Participant): TicketSummary[] {
    const now = new Date(this.store.now()).toISOString();
    const rows = this.store.db
      .prepare(`${TICKET_SELECT} WHERE t.waiting_on = ? AND (t.waiting_snoozed_until IS NULL OR t.waiting_snoozed_until <= ?) AND s.category NOT IN ('completed', 'canceled') ORDER BY t.waiting_since`)
      .all(actor.id, now) as unknown as TicketRow[];
    return this.summaries(rows.filter((r) => this.store.canSee(actor, r.project_id)), actor);
  }

  update(actor: Participant, ref: string, input: TicketInput): Written {
    const row = this.byRef(actor, ref);
    this.store.assertWrite(actor, row.project_id);
    this.store.checkRate(actor, 'post');
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const changes: Change[] = [];
    const set = (column: string, value: string | number | null) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

    let files: number[] = [];
    if (input.attachmentIds?.length) {
      this.store.ticketFiles.check(actor, row.project_id, input.attachmentIds);
      files = input.attachmentIds;
      const names = files.map((id) => (this.store.db.prepare('SELECT name FROM ticket_files WHERE id = ?').get(id) as { name: string }).name);
      changes.push({ field: 'files', from: null, to: names.join(', ') });
    }
    if (input.private !== undefined && (input.private ? 1 : 0) !== row.private) {
      // Who can see a ticket is a person's call: its creator or a project admin.
      if (actor.kind !== 'user' || (actor.id !== row.creator_id && this.store.roleIn(actor, row.project_id) !== 'admin')) {
        throw new OrcoError('forbidden', 'Only the person who opened a ticket or a project admin makes it private or shared');
      }
      set('private', input.private ? 1 : 0);
      changes.push({ field: 'private', from: row.private ? 'private' : 'shared', to: input.private ? 'private' : 'shared' });
    }
    if (input.title !== undefined) {
      const title = this.title(input.title);
      if (title !== row.title) {
        set('title', title);
        changes.push({ field: 'title', from: row.title, to: title });
      }
    }
    if (input.description !== undefined) {
      const description = this.description(input.description);
      if (description !== row.description) {
        set('description', description);
        // The text itself is not copied into the history (it can be long); say what happened instead.
        changes.push({ field: 'description', from: row.description ? '(earlier text)' : null, to: description ? '(updated: see description)' : '(cleared)' });
      }
    }
    let newStatus: TicketStatus | null = null;
    // Closing as a duplicate or superseded: Canceled, with a link to where the work went.
    if (input.duplicateOf !== undefined && input.supersededBy !== undefined) throw new OrcoError('invalid', 'A ticket is a duplicate or superseded, not both');
    const closeRef = input.duplicateOf ?? input.supersededBy;
    const closeReason = input.duplicateOf !== undefined ? 'duplicate' : 'superseded';
    let closeFor: TicketRow | null = null;
    if (closeRef !== undefined) {
      closeFor = this.byRef(actor, closeRef);
      if (closeFor.id === row.id) throw new OrcoError('invalid', 'A ticket cannot replace itself');
      set('closed_reason', closeReason);
      set('closed_for', closeFor.id);
      changes.push({ field: 'closedAs', from: null, to: `${closeReason === 'duplicate' ? 'duplicate of' : 'superseded by'} ${refOf(closeFor)}` });
      if (input.status === undefined && row.category !== 'canceled') {
        const canceled = this.statuses(row.project_id).find((s) => s.category === 'canceled');
        if (!canceled) throw new OrcoError('conflict', `${row.project} has no canceled status to close it with`);
        input = { ...input, status: canceled.name };
      }
    }
    if (input.status !== undefined) {
      const status = this.statusByName(row.project_id, input.status);
      if (status.id !== row.status_id) {
        // Build work waits for an approved scope (#108); "scope" tickets are the scoping itself.
        const labels = input.labels ?? (this.labelsFor([row.id]).get(row.id) ?? []).map((l) => l.name);
        this.store.scope.assertBuildAllowed(row.project_id, labels, status.category);
        // Build order (#109): a ticket that waits on a milestone or label does not start yet.
        if (status.category === 'started' || status.category === 'completed') this.store.order.assertMayStart(row.project_id, labels, row.id, refOf(row));
        newStatus = status;
        changes.push({ field: 'status', from: row.status_name, to: status.name });
      }
    }
    // Reopened: it no longer stands for another ticket.
    if (newStatus && newStatus.category !== 'canceled' && closeFor === null && row.closed_reason) {
      set('closed_reason', null);
      set('closed_for', null);
    }
    if (input.priority !== undefined) {
      const priority = this.priority(input.priority);
      if (priority !== row.priority) {
        set('priority', priority);
        changes.push({ field: 'priority', from: PRIORITIES[row.priority], to: input.priority });
      }
    }
    if (input.estimate !== undefined) {
      const estimate = this.estimate(input.estimate);
      if (estimate !== row.estimate) {
        set('estimate', estimate);
        changes.push({ field: 'estimate', from: row.estimate, to: estimate });
      }
    }
    if (input.dueDate !== undefined) {
      const dueDate = checkDate(input.dueDate, 'Due date');
      if (dueDate !== row.due_date) {
        set('due_date', dueDate);
        changes.push({ field: 'dueDate', from: row.due_date, to: dueDate });
      }
    }
    let newAssignee: Participant | null | undefined;
    if (input.assignee !== undefined) {
      const assignee = input.assignee ? this.assignable(row.project_id, input.assignee) : null;
      if ((assignee?.id ?? null) !== row.assignee_id) {
        // Handing a waiting ticket to an agent would start it (#109).
        if (assignee?.kind === 'agent' && assignee.id !== actor.id) {
          this.store.order.assertMayStart(row.project_id, input.labels ?? (this.labelsFor([row.id]).get(row.id) ?? []).map((l) => l.name), row.id, refOf(row));
        }
        newAssignee = assignee;
        set('assignee_id', assignee?.id ?? null);
        changes.push({ field: 'assignee', from: row.assignee, to: assignee?.name ?? null });
      }
    }
    let newLabels: number[] | undefined;
    if (input.labels !== undefined) {
      const ids = this.labelIds(row.project_id, input.labels);
      const current = this.labelsFor([row.id]).get(row.id) ?? [];
      const before = current.map((l) => l.id).sort();
      if (JSON.stringify(before) !== JSON.stringify([...ids].sort())) {
        newLabels = ids;
        changes.push({ field: 'labels', from: current.map((l) => l.name), to: this.labelNames(ids) });
      }
    }
    if (input.milestone !== undefined) {
      const milestone = input.milestone ? this.milestoneByName(row.project_id, input.milestone) : null;
      if ((milestone?.id ?? null) !== row.milestone_id) {
        set('milestone_id', milestone?.id ?? null);
        changes.push({ field: 'milestone', from: row.milestone, to: milestone?.name ?? null });
      }
    }
    if (input.cycle !== undefined) {
      const cycle = input.cycle === null ? null : this.cycleRef(row.project_id, input.cycle);
      if ((cycle?.id ?? null) !== row.cycle_id) {
        set('cycle_id', cycle?.id ?? null);
        changes.push({ field: 'cycle', from: row.cycle_number, to: cycle?.number ?? null });
      }
    }
    if (input.folder !== undefined) {
      const folder = input.folder?.trim() ? this.folderByName(row.project_id, input.folder) : null;
      if ((folder?.id ?? null) !== row.folder_id) {
        set('folder_id', folder?.id ?? null);
        changes.push({ field: 'folder', from: row.folder, to: folder?.name ?? null });
      }
    }
    if (input.parent !== undefined) {
      const parent = input.parent ? this.parentRow(actor, row.project_id, input.parent, row.id) : null;
      if ((parent?.id ?? null) !== row.parent_id) {
        set('parent_id', parent?.id ?? null);
        changes.push({ field: 'parent', from: row.parent_number === null ? null : `${row.ticket_key}-${row.parent_number}`, to: parent ? refOf(parent) : null });
      }
    }
    if (input.handoff !== undefined) {
      const handoff = input.handoff.trim();
      if (handoff.length > MAX_HANDOFF) throw new OrcoError('invalid', `Handoff notes can be at most ${MAX_HANDOFF} characters`);
      if (handoff !== row.handoff) {
        set('handoff', handoff);
        set('handoff_by', actor.id);
        sets.push(`handoff_at = ${NOW_SQL}`);
        // The note itself is not copied into the history (it can be long); say what happened instead.
        changes.push({ field: 'handoff', from: row.handoff ? '(earlier note)' : null, to: handoff ? '(updated: see handoff)' : '(cleared)' });
      }
    }
    if (input.blockedReason !== undefined) {
      const reason = input.blockedReason.trim().replace(/\s+/g, ' ');
      if (reason.length > MAX_BLOCKED_REASON) throw new OrcoError('invalid', `A blocked reason can be at most ${MAX_BLOCKED_REASON} characters`);
      if (reason !== row.blocked_reason) {
        set('blocked_reason', reason);
        changes.push({ field: 'blockedReason', from: row.blocked_reason || null, to: reason || null });
      }
    }
    if (input.nextStep !== undefined || input.nextStepFor !== undefined) {
      const text = input.nextStep === undefined ? (row.next_step ?? '') : oneLine(input.nextStep, 'The next step');
      let forId: number | null = input.nextStepFor === undefined ? (row.next_step_for ? this.store.participantByName(row.next_step_for)?.id ?? null : null) : null;
      if (input.nextStepFor) {
        const who = this.store.participantByName(input.nextStepFor.replace(/^@/, ''));
        if (!who || !this.store.canSee(who, row.project_id)) throw new OrcoError('invalid', `${input.nextStepFor} cannot see ${row.project}`);
        forId = who.id;
      }
      if (!text) forId = null;
      const forName = forId === null ? null : this.store.participantById(forId)!.name;
      if (text !== (row.next_step ?? '') || forName !== row.next_step_for) {
        set('next_step', text || null);
        set('next_step_for', forId);
        changes.push({ field: 'nextStep', from: row.next_step, to: text ? `${text}${forName ? ` (for ${forName})` : ''}` : null });
      }
    }
    // The quick replies belong to one ask: a new person or ask drops them unless new ones come along.
    const options = input.waitingOptions === undefined || input.waitingOptions === null ? input.waitingOptions : JSON.stringify(checkWaitingOptions(input.waitingOptions));
    const describe = (person: string, ask: string, stored: string | null) =>
      `${person}: ${ask}${stored ? ` (replies: ${waitingChoices(ask, stored).join(' / ')})` : ''}`;
    if (input.waitingOn !== undefined && (input.waitingOn === null || input.waitingOn.trim() === '')) {
      if (row.waiting_on) {
        set('waiting_on', null);
        set('waiting_ask', null);
        set('waiting_since', null);
        set('waiting_snoozed_until', null);
        set('waiting_options', null);
        changes.push({ field: 'waitingOn', from: row.waiting_on, to: null });
      }
    } else if (input.waitingOn !== undefined) {
      const person = this.store.participantByName(input.waitingOn.trim().replace(/^@/, ''));
      if (!person || person.kind !== 'user' || this.store.isSystem(person) || !this.store.canSee(person, row.project_id)) {
        throw new OrcoError('invalid', `waiting_on is a person who can see ${row.project}`);
      }
      const ask = oneLine(input.waitingAsk ?? row.waiting_ask ?? '', 'The ask');
      if (!ask) throw new OrcoError('invalid', 'Say in one line what you need from them (waiting_ask)');
      const fresh = person.name !== row.waiting_on || ask !== row.waiting_ask;
      const nextOptions = options !== undefined ? options : fresh ? null : row.waiting_options;
      if (fresh || nextOptions !== row.waiting_options) {
        set('waiting_on', person.id);
        set('waiting_ask', ask);
        set('waiting_options', nextOptions);
        if (fresh) {
          set('waiting_since', new Date(this.store.now()).toISOString());
          set('waiting_snoozed_until', null);
        }
        changes.push({ field: 'waitingOn', from: row.waiting_on, to: describe(person.name, ask, nextOptions) });
      }
    } else if ((input.waitingAsk !== undefined || options !== undefined) && row.waiting_on) {
      const ask = (input.waitingAsk !== undefined ? oneLine(input.waitingAsk, 'The ask') : '') || (row.waiting_ask ?? '');
      const nextOptions = options !== undefined ? options : ask !== row.waiting_ask ? null : row.waiting_options;
      if (ask !== row.waiting_ask || nextOptions !== row.waiting_options) {
        set('waiting_ask', ask);
        set('waiting_options', nextOptions);
        changes.push({ field: 'waitingOn', from: row.waiting_on, to: describe(row.waiting_on, ask, nextOptions) });
      }
    } else if (options) {
      throw new OrcoError('invalid', `${refOf(row)} waits on no one; set waiting_on along with waiting_options`);
    }
    const criteria = this.criteriaOps(actor, row.id, input);
    if (criteria.change) changes.push(criteria.change);
    const links = this.linkOps(actor, row, input);
    if (links.change) changes.push(links.change);
    if (newStatus) {
      set('status_id', newStatus.id);
      sets.push(`status_changed_at = ${NOW_SQL}`);
      if (newStatus.category === 'started') sets.push(`started_at = coalesce(started_at, ${NOW_SQL})`);
      sets.push(`completed_at = ${['completed', 'canceled'].includes(newStatus.category) ? NOW_SQL : 'NULL'}`);
      if (input.sort === undefined) set('sort', this.topSort(newStatus.id));
    }
    if (input.sort !== undefined) {
      if (!Number.isFinite(input.sort)) throw new OrcoError('invalid', 'Sort must be a number');
      set('sort', input.sort);
    }
    if (sets.length === 0 && newLabels === undefined && !criteria.apply && !links.apply && files.length === 0) return { ticket: this.detail(actor, row.id) };

    const openTask = row.task_id !== null && OPEN_STATES.includes(taskState(row)!);
    // Canceling the ticket stops its agent too, when this person may cancel that task.
    if (newStatus?.category === 'canceled' && newAssignee === undefined && openTask) {
      try {
        this.store.tasks.update(actor, row.task_id!, 'cancelled', `Ticket ${refOf(row)} was canceled`);
      } catch (err) {
        if (!(err instanceof OrcoError && err.code === 'forbidden')) throw err;
      }
    }
    // Reassigning away from an agent stops the work it was doing on this ticket.
    if (newAssignee !== undefined && openTask) {
      try {
        this.store.tasks.update(actor, row.task_id!, 'cancelled', `Ticket ${refOf(row)} was reassigned`);
      } catch (err) {
        if (err instanceof OrcoError && err.code === 'forbidden') {
          throw new OrcoError('conflict', `${row.assignee} is still working on task #${row.task_id}; its requester or owner must cancel it first`);
        }
        throw err;
      }
    }

    this.store.begin();
    try {
      if (sets.length) this.store.db.prepare(`UPDATE tickets SET ${sets.join(', ')}, updated_at = ${NOW_SQL} WHERE id = ?`).run(...params, row.id);
      if (newLabels !== undefined) {
        this.store.db.prepare('DELETE FROM ticket_labels WHERE ticket_id = ?').run(row.id);
        const link = this.store.db.prepare('INSERT INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)');
        for (const labelId of newLabels) link.run(row.id, labelId);
      }
      criteria.apply?.();
      if (newLabels !== undefined) {
        const added = this.applyChecklists(row.id, row.project_id, this.labelNames(newLabels));
        if (added.length) changes.push({ field: 'criteria', from: null, to: { added, done: [], undone: [], removed: [] } });
      }
      // Definition of Done (#110): required items are checked first, or an admin overrides with a reason.
      if (newStatus?.category === 'completed') {
        const open = this.requiredOpen(row.id);
        if (open.length) {
          const reason = input.doneOverride?.trim().replace(/\s+/g, ' ').slice(0, 200);
          if (!reason) {
            throw new OrcoError('conflict', `${refOf(row)} has required items unchecked: ${open.join('; ')}. Check them (criteria_done), or a project admin closes it with done_override and a reason.`);
          }
          if (actor.kind !== 'user' || (this.store.roleIn(actor, row.project_id) !== 'admin' && !this.store.isOrgAdmin(actor))) {
            throw new OrcoError('forbidden', 'Only a project or org admin closes a ticket past its required checklist');
          }
          changes.push({ field: 'override', from: open.join('; '), to: reason });
          this.store.audit.record(actor, 'ticket.done_override', { projectId: row.project_id, subject: `ticket:${refOf(row)}`, detail: { skipped: open, reason } });
        }
      }
      links.apply?.();
      if (files.length) this.store.ticketFiles.attach(row.id, null, files);
      if (!sets.length) this.store.db.prepare(`UPDATE tickets SET updated_at = ${NOW_SQL} WHERE id = ?`).run(row.id);
      const session = sessionLink(input.sessionUrl);
      if (changes.length) this.activity(row.id, actor, 'change', null, { changes, ...(session ? { session } : {}) });
      this.store.commit();
    } catch (err) {
      this.store.rollback();
      throw err;
    }
    const updated = this.row(row.id)!;
    if (changes.length) {
      this.store.audit.record(actor, 'ticket.update', { projectId: row.project_id, subject: `ticket:${refOf(row)}`, detail: { changes } });
    }
    const warning = newAssignee?.kind === 'agent' && newAssignee.id !== actor.id ? this.dispatch(actor, updated) : undefined;
    if (closeFor) {
      this.activity(closeFor.id, actor, 'change', null, { changes: [{ field: 'replaces', from: null, to: `${refOf(row)} (${closeReason})` }] });
      this.changed(closeFor);
    }
    if (newStatus && ['completed', 'canceled'].includes(newStatus.category)) this.noteUnblocked(row.id, actor);
    this.changed(updated);
    return { ticket: this.detail(actor, row.id), ...(warning ? { warning } : {}) };
  }

  /**
   * Several ticket edits in one call, all or nothing, counted once against the rate limit: an agent
   * assigning or closing many tickets at once should not need one call (and one rate-limit hit) each.
   * Each edit may carry a comment (why it closed, where the work went), posted with its change.
   */
  updateMany(actor: Participant, edits: { ref: string; input: TicketInput; comment?: string }[]): Written[] {
    if (edits.length === 0 || edits.length > MAX_BULK) throw new OrcoError('invalid', `Change 1 to ${MAX_BULK} tickets at once`);
    if (new Set(edits.map((e) => e.ref.toUpperCase())).size !== edits.length) throw new OrcoError('invalid', 'Each ticket at most once per call');
    this.store.checkRate(actor, 'post');
    this.store.begin();
    try {
      const results = this.store.withoutRateLimit(() =>
        edits.map((e) => {
          try {
            const written = this.update(actor, e.ref, e.input);
            // The why, next to the change in the history (and the handoff note left alone).
            return e.comment?.trim() ? { ...written, ticket: this.comment(actor, e.ref, e.comment) } : written;
          } catch (err) {
            if (err instanceof OrcoError) throw new OrcoError(err.code, `${e.ref}: ${err.message} (nothing was changed)`);
            throw err;
          }
        }),
      );
      this.store.commit();
      return results;
    } catch (err) {
      this.store.rollback();
      throw err;
    }
  }

  /** Checks criteria edits now and returns the writes to run inside the update's transaction. */
  private criteriaOps(actor: Participant, ticketId: number, input: TicketInput): { apply?: () => void; change?: Change } {
    const add = (input.criteriaAdd ?? []).map((text) => text.trim()).filter(Boolean);
    const done = input.criteriaDone ?? [];
    const undone = input.criteriaUndone ?? [];
    const remove = input.criteriaRemove ?? [];
    if (!add.length && !done.length && !undone.length && !remove.length) return {};
    if (remove.length && actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people can remove acceptance criteria');
    for (const text of add) if (text.length > MAX_CRITERION) throw new OrcoError('invalid', `A criterion can be at most ${MAX_CRITERION} characters`);
    const items = this.store.db
      .prepare('SELECT id, text, done, position FROM ticket_criteria WHERE ticket_id = ?')
      .all(ticketId) as unknown as { id: number; text: string; done: number; position: number }[];
    if (items.length + add.length > MAX_CRITERIA) throw new OrcoError('invalid', `A ticket can have at most ${MAX_CRITERIA} criteria`);
    const byId = new Map(items.map((c) => [c.id, c]));
    for (const id of [...done, ...undone, ...remove]) {
      if (!byId.has(id)) throw new OrcoError('not_found', `No criterion ${id} on this ticket; its criterion ids are ${[...byId.keys()].join(', ') || 'none'} (from get_ticket's criteria_items)`);
    }
    const textOf = (ids: number[]) => ids.map((id) => byId.get(id)!.text);
    const next = Math.max(-1, ...items.map((c) => c.position)) + 1;
    const change: Change = {
      field: 'criteria',
      from: null,
      to: { added: add, done: textOf(done), undone: textOf(undone), removed: textOf(remove) },
    };
    return {
      change,
      apply: () => {
        const insert = this.store.db.prepare('INSERT INTO ticket_criteria (ticket_id, text, position) VALUES (?, ?, ?)');
        add.forEach((text, i) => insert.run(ticketId, text, next + i));
        const mark = this.store.db.prepare('UPDATE ticket_criteria SET done = ? WHERE id = ?');
        for (const id of done) mark.run(1, id);
        for (const id of undone) mark.run(0, id);
        const drop = this.store.db.prepare('DELETE FROM ticket_criteria WHERE id = ?');
        for (const id of remove) drop.run(id);
      },
    };
  }

  /** Adds the checklist items of these labels as criteria (#110), skipping ones the ticket has. Returns their texts. */
  private applyChecklists(ticketId: number, projectId: number, labels: string[], also: string[] = []): string[] {
    if (!labels.length) return [];
    const existing = (this.store.db.prepare('SELECT text, position FROM ticket_criteria WHERE ticket_id = ?').all(ticketId) as { text: string; position: number }[]);
    const items = this.store.checklists.itemsFor(projectId, labels, [...existing.map((c) => c.text), ...also]).slice(0, Math.max(0, MAX_CRITERIA - existing.length - also.length));
    let position = Math.max(-1, ...existing.map((c) => c.position)) + 1 + also.length;
    const insert = this.store.db.prepare('INSERT INTO ticket_criteria (ticket_id, text, position, required, template) VALUES (?, ?, ?, ?, ?)');
    for (const item of items) insert.run(ticketId, item.text, position++, item.required ? 1 : 0, item.label);
    return items.map((i) => i.text);
  }

  /** Required criteria not checked yet. */
  private requiredOpen(ticketId: number): string[] {
    return (this.store.db.prepare('SELECT text FROM ticket_criteria WHERE ticket_id = ? AND required = 1 AND done = 0 ORDER BY position, id').all(ticketId) as { text: string }[]).map((r) => r.text);
  }

  /** Checks blocked-by edits (visibility, no cycles) and returns the writes. */
  private linkOps(actor: Participant, row: TicketRow, input: TicketInput): { apply?: () => void; change?: Change } {
    const add = [...new Set(input.blockedByAdd ?? [])].map((ref) => this.byRef(actor, ref));
    const remove = [...new Set(input.blockedByRemove ?? [])].map((ref) => this.byRef(actor, ref));
    if (!add.length && !remove.length) return {};
    const blocks = this.store.db.prepare('SELECT blocked_id FROM ticket_links WHERE blocker_id = ?');
    for (const blocker of add) {
      if (blocker.id === row.id) throw new OrcoError('invalid', 'A ticket cannot block itself');
      // Adding "blocker blocks row" makes a cycle if row already blocks blocker, directly or through others.
      const seen = new Set<number>();
      const stack = [row.id];
      while (stack.length) {
        const at = stack.pop()!;
        if (at === blocker.id) throw new OrcoError('invalid', `${refOf(blocker)} already waits on ${refOf(row)}; that would be a loop`);
        if (seen.has(at)) continue;
        seen.add(at);
        for (const next of blocks.all(at) as unknown as { blocked_id: number }[]) stack.push(next.blocked_id);
      }
    }
    return {
      change: { field: 'blockedBy', from: remove.map(refOf), to: add.map(refOf) },
      apply: () => {
        const link = this.store.db.prepare('INSERT OR IGNORE INTO ticket_links (blocker_id, blocked_id) VALUES (?, ?)');
        for (const blocker of add) link.run(blocker.id, row.id);
        const unlink = this.store.db.prepare('DELETE FROM ticket_links WHERE blocker_id = ? AND blocked_id = ?');
        for (const blocker of remove) unlink.run(blocker.id, row.id);
      },
    };
  }

  comment(actor: Participant, ref: string, body: string, attachmentIds: number[] = [], sessionUrl?: string | null): Ticket {
    const row = this.byRef(actor, ref);
    this.store.assertWrite(actor, row.project_id);
    const text = body.trim();
    if (!text && attachmentIds.length === 0) throw new OrcoError('invalid', 'Comment is empty');
    if (text.length > MAX_COMMENT) throw new OrcoError('invalid', `Comment is over ${MAX_COMMENT} characters`);
    if (attachmentIds.length) this.store.ticketFiles.check(actor, row.project_id, attachmentIds);
    this.store.checkRate(actor, 'post');
    const session = sessionLink(sessionUrl);
    const extra = { ...(attachmentIds.length ? { files: attachmentIds } : {}), ...(session ? { session } : {}) };
    const activityId = this.activity(row.id, actor, 'comment', text || null, Object.keys(extra).length ? extra : null);
    if (attachmentIds.length) this.store.ticketFiles.attach(row.id, activityId, attachmentIds);
    this.store.db.prepare(`UPDATE tickets SET updated_at = ${NOW_SQL} WHERE id = ?`).run(row.id);
    this.store.audit.record(actor, 'ticket.comment', { projectId: row.project_id, subject: `ticket:${refOf(row)}`, detail: { text } });
    this.changed(row);
    return this.detail(actor, row.id);
  }

  /**
   * Takes an unassigned ticket for yourself, atomically: two agents claiming the same ticket at once
   * cannot both win. Moves it to the first started status unless `start` is false. No task starts.
   */
  /**
   * Starts work on a ticket in one step (#104): an unassigned one is claimed, and one that is the
   * actor's moves to the first started status. Someone else's is a conflict.
   */
  start(actor: Participant, ref: string): Ticket {
    const row = this.byRef(actor, ref);
    if (row.assignee_id === null) return this.claim(actor, ref, { start: true });
    if (row.assignee_id !== actor.id) throw new OrcoError('conflict', `${refOf(row)} is assigned to ${row.assignee}`);
    if (row.category === 'backlog' || row.category === 'unstarted') {
      const started = this.statuses(row.project_id).find((st) => st.category === 'started');
      if (started) return this.update(actor, ref, { status: started.name }).ticket;
    }
    return this.detail(actor, row.id);
  }

  claim(actor: Participant, ref: string, options: { start?: boolean } = {}): Ticket {
    const row = this.byRef(actor, ref);
    this.store.assertWrite(actor, row.project_id);
    this.assignable(row.project_id, actor.name);
    const statuses = this.statuses(row.project_id);
    const current = statuses.find((s) => s.id === row.status_id)!;
    if (current.category === 'completed' || current.category === 'canceled') throw new OrcoError('conflict', `${refOf(row)} is ${current.name}`);
    const started = statuses.find((s) => s.category === 'started');
    const move = options.start !== false && started && (current.category === 'backlog' || current.category === 'unstarted') ? started : null;
    if (move) {
      const labels = (this.labelsFor([row.id]).get(row.id) ?? []).map((l) => l.name);
      this.store.scope.assertBuildAllowed(row.project_id, labels, move.category);
      this.store.order.assertMayStart(row.project_id, labels, row.id, refOf(row));
    }
    const claimed = this.store.db
      .prepare(
        `UPDATE tickets SET assignee_id = ?, updated_at = ${NOW_SQL},
           status_id = coalesce(?, status_id), sort = CASE WHEN ? IS NULL THEN sort ELSE ? END,
           started_at = CASE WHEN ? IS NULL THEN started_at ELSE coalesce(started_at, ${NOW_SQL}) END
         WHERE id = ? AND assignee_id IS NULL`,
      )
      .run(actor.id, move?.id ?? null, move?.id ?? null, move ? this.topSort(move.id) : 0, move?.id ?? null, row.id);
    if (Number(claimed.changes) === 0) {
      const now = this.row(row.id)!;
      throw new OrcoError('conflict', `${refOf(row)} is already assigned to ${now.assignee}`);
    }
    const changes: { field: string; from: string | null; to: string }[] = [{ field: 'assignee', from: null, to: actor.name }];
    if (move) changes.push({ field: 'status', from: current.name, to: move.name });
    this.activity(row.id, actor, 'change', null, { changes, claimed: true });
    this.store.audit.record(actor, 'ticket.claim', { projectId: row.project_id, subject: `ticket:${refOf(row)}`, detail: { changes } });
    this.changed(row);
    return this.detail(actor, row.id);
  }

  startTask(actor: Participant, ref: string): Written {
    const row = this.byRef(actor, ref);
    this.store.assertWrite(actor, row.project_id);
    // An agent cannot task itself; on its own ticket it gets a task from its owner instead (#66).
    if (actor.kind === 'agent' && row.assignee_id === actor.id) {
      this.taskFor(actor, ref);
      return { ticket: this.detail(actor, row.id) };
    }
    if (row.assignee_kind !== 'agent') throw new OrcoError('invalid', `Assign ${refOf(row)} to an agent first`);
    if (row.task_id !== null && OPEN_STATES.includes(taskState(row)!)) {
      throw new OrcoError('conflict', `${row.assignee} already has task #${row.task_id} for ${refOf(row)}`);
    }
    const warning = this.dispatch(actor, row);
    if (warning) throw new OrcoError('forbidden', warning);
    this.changed(row);
    return { ticket: this.detail(actor, row.id) };
  }

  /**
   * The open task an agent works its ticket under. A ticket filed without one (create_tickets) gets
   * one now, on the agent's owner's behalf, already accepted: so the agent can ask a question, which
   * always belongs to a task (#53).
   */
  taskFor(agent: Participant, ref: string): Task {
    const row = this.byRef(agent, ref);
    if (agent.kind !== 'agent' || row.assignee_id !== agent.id) {
      throw new OrcoError('forbidden', `${refOf(row)} is not assigned to you; claim it with claim_ticket first`);
    }
    if (row.task_id === null || !OPEN_STATES.includes(taskState(row)!)) {
      const owner = this.store.participantById(agent.ownerId!)!;
      const warning = this.dispatch(owner, row);
      if (warning) throw new OrcoError('conflict', warning);
      this.changed(row);
    }
    let task = this.store.tasks.get(agent, this.byRef(agent, ref).task_id!);
    if (task.state === 'requested') task = this.store.tasks.update(agent, task.id, 'accepted');
    if (task.state === 'awaiting_approval') throw new OrcoError('conflict', `Task #${task.id} for ${refOf(row)} waits for approval before you can work on it`);
    return task;
  }

  /** A ticket; with `since` (an activity id), only the activity after it. */
  get(actor: Participant, ref: string, since?: number): Ticket {
    return this.detail(actor, this.byRef(actor, ref).id, since ?? 0);
  }

  list(actor: Participant, filter: TicketFilter = {}): TicketSummary[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.project) {
      const project = this.project(actor, filter.project);
      where.push('t.project_id = ?');
      params.push(project.id);
    } else {
      const visible = this.store.projectFilter(actor, 't.project_id');
      where.push(visible.sql);
      params.push(...visible.params);
    }
    {
      const hidden = this.privateFilter(actor);
      where.push(hidden.sql);
      params.push(...hidden.params);
    }
    if (filter.status) {
      where.push('s.name = ?');
      params.push(filter.status);
    }
    const categories = filter.open ? ['backlog', 'unstarted', 'started'] : filter.categories;
    if (categories?.length) {
      for (const c of categories) if (!STATUS_CATEGORIES.includes(c as StatusCategory)) throw new OrcoError('invalid', `Unknown status category ${c}`);
      where.push(`s.category IN (${categories.map(() => '?').join(', ')})`);
      params.push(...categories);
    }
    if (filter.assignee) {
      if (filter.assignee === 'none') where.push('t.assignee_id IS NULL');
      else {
        where.push('a.name = ?');
        params.push(filter.assignee === 'me' ? actor.name : filter.assignee.replace(/^@/, ''));
      }
    }
    if (filter.label) {
      where.push('t.id IN (SELECT tl.ticket_id FROM ticket_labels tl JOIN labels l ON l.id = tl.label_id WHERE l.name = ?)');
      params.push(filter.label);
    }
    if (filter.milestone) {
      where.push('m.name = ?');
      params.push(filter.milestone);
    }
    if (filter.cycle !== undefined) {
      if (filter.cycle === 'current') {
        const today = this.today();
        where.push('cy.completed_at IS NULL AND cy.starts_on <= ? AND cy.ends_on >= ?');
        params.push(today, today);
      } else {
        where.push('cy.number = ?');
        params.push(filter.cycle);
      }
    }
    if (filter.folder?.trim()) {
      const name = filter.folder.trim();
      if (name.toLowerCase() === 'none') where.push('t.folder_id IS NULL');
      else {
        // In one project, a folder that does not exist is a mistake worth naming; across projects, a match by name.
        if (filter.project) this.folderByName(this.project(actor, filter.project).id, name);
        where.push('f.name = ?');
        params.push(name);
      }
    }
    if (filter.priority) {
      where.push('t.priority = ?');
      params.push(this.priority(filter.priority));
    }
    if (filter.blocked !== undefined) {
      const blocked = `(t.blocked_reason != '' OR EXISTS (SELECT 1 FROM ticket_links tl JOIN tickets b ON b.id = tl.blocker_id
        JOIN ticket_statuses bs ON bs.id = b.status_id WHERE tl.blocked_id = t.id AND bs.category NOT IN ('completed', 'canceled')))`;
      where.push(filter.blocked ? blocked : `NOT ${blocked}`);
    }
    if (filter.parent) {
      const parent = this.byRef(actor, filter.parent);
      where.push('t.parent_id = ?');
      params.push(parent.id);
    }
    if (filter.query?.trim()) {
      const q = filter.query.trim().slice(0, 200);
      const match = REF.exec(q);
      const pattern = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      where.push(`(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\'${match ? ' OR (p.ticket_key = ? AND t.number = ?)' : ''})`);
      params.push(pattern, pattern);
      if (match) params.push(match[1]!.toUpperCase(), Number(match[2]));
    }
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
    const rows = this.store.db
      .prepare(`${TICKET_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.position, t.sort, t.id DESC LIMIT ?`)
      .all(...params, limit) as unknown as TicketRow[];
    return this.summaries(rows, actor);
  }

  /* Workflow, labels, milestones and cycles */

  plan(actor: Participant, project: string): ProjectPlan {
    const proj = this.project(actor, project);
    const key = (this.store.db.prepare('SELECT ticket_key FROM projects WHERE id = ?').get(proj.id) as { ticket_key: string }).ticket_key;
    return {
      project: proj.name,
      key,
      scope: this.store.scope.statusOf(proj.id),
      orderRules: this.store.order.forProject(proj.id),
      statuses: this.statuses(proj.id),
      labels: this.labels(proj.id),
      milestones: this.milestones(proj.id),
      cycles: this.cycles(proj.id),
      folders: this.folderList(proj.id),
      members: this.store.members(actor, proj.name).map((p) => ({ name: p.name, kind: p.kind, owner: p.owner })),
    };
  }

  /* Folders (#91) */

  /** A project's folders in order, with how many open and total tickets each holds. */
  folders(actor: Participant, project: string): Folder[] {
    return this.folderList(this.project(actor, project).id);
  }

  /** Anyone who can change tickets in the project, agents included, may add a folder; only people rename or remove them. */
  createFolder(actor: Participant, project: string, input: { name: string; emoji?: string | null; color?: string | null }): Folder {
    const proj = this.writable(actor, project);
    this.store.checkRate(actor, 'post');
    const name = this.folderName(input.name);
    const emoji = this.folderEmoji(input.emoji);
    const color = this.folderColor(input.color);
    const existing = this.folderList(proj.id);
    if (existing.length >= MAX_FOLDERS) throw new OrcoError('invalid', `A project can have at most ${MAX_FOLDERS} folders`);
    const position = existing.reduce((max, f) => Math.max(max, f.position), -1) + 1;
    try {
      this.store.db
        .prepare('INSERT INTO ticket_folders (project_id, name, emoji, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(proj.id, name, emoji, color, position, new Date(this.store.now()).toISOString());
    } catch (err) {
      if (err instanceof Error && /UNIQUE/.test(err.message)) throw new OrcoError('conflict', `There is already a folder called ${name}`);
      throw err;
    }
    this.store.audit.record(actor, 'folder.create', { projectId: proj.id, subject: `project:${proj.name}`, detail: { name, emoji, color } });
    this.planChanged(proj.id);
    return this.folderByName(proj.id, name);
  }

  /** Renames, recolors or moves a folder; people only. */
  updateFolder(actor: Participant, project: string, id: number, input: { name?: string; emoji?: string | null; color?: string | null; position?: number }): Folder {
    const proj = this.folderKeeper(actor, project);
    const list = this.folderList(proj.id);
    const folder = list.find((f) => f.id === id);
    if (!folder) throw new OrcoError('not_found', `No folder ${id} in ${proj.name}`);
    const name = input.name === undefined ? folder.name : this.folderName(input.name);
    const emoji = input.emoji === undefined ? folder.emoji : this.folderEmoji(input.emoji);
    const color = input.color === undefined ? folder.color : this.folderColor(input.color);
    this.store.begin();
    try {
      this.store.db.prepare('UPDATE ticket_folders SET name = ?, emoji = ?, color = ? WHERE id = ?').run(name, emoji, color, id);
      if (input.position !== undefined) {
        const rest = list.filter((f) => f.id !== id);
        rest.splice(Math.min(Math.max(Math.trunc(input.position), 0), rest.length), 0, folder);
        const move = this.store.db.prepare('UPDATE ticket_folders SET position = ? WHERE id = ?');
        rest.forEach((f, i) => move.run(i, f.id));
      }
      this.store.commit();
    } catch (err) {
      this.store.rollback();
      if (err instanceof Error && /UNIQUE/.test(err.message)) throw new OrcoError('conflict', `There is already a folder called ${name}`);
      throw err;
    }
    this.store.audit.record(actor, 'folder.update', { projectId: proj.id, subject: `project:${proj.name}`, detail: { id, from: folder.name, name, emoji, color, position: input.position } });
    this.planChanged(proj.id);
    return this.folderList(proj.id).find((f) => f.id === id)!;
  }

  /** Removes a folder; its tickets stay, in no folder. People only. */
  deleteFolder(actor: Participant, project: string, id: number): void {
    const proj = this.folderKeeper(actor, project);
    const folder = this.folderList(proj.id).find((f) => f.id === id);
    if (!folder) throw new OrcoError('not_found', `No folder ${id} in ${proj.name}`);
    this.store.begin();
    try {
      this.store.db.prepare(`UPDATE tickets SET folder_id = NULL, updated_at = ${NOW_SQL} WHERE folder_id = ?`).run(id);
      this.store.db.prepare('DELETE FROM ticket_folders WHERE id = ?').run(id);
      this.store.commit();
    } catch (err) {
      this.store.rollback();
      throw err;
    }
    this.store.audit.record(actor, 'folder.delete', { projectId: proj.id, subject: `project:${proj.name}`, detail: { name: folder.name, tickets: folder.total } });
    this.planChanged(proj.id);
  }

  addStatus(actor: Participant, project: string, input: { name: string; category: StatusCategory; position?: number }): TicketStatus[] {
    const proj = this.planner(actor, project);
    const name = this.statusName(input.name);
    const category = this.category(input.category);
    const list = this.statuses(proj.id);
    const position = Math.min(Math.max(input.position ?? list.length, 0), list.length);
    try {
      this.store.db
        .prepare('INSERT INTO ticket_statuses (project_id, name, category, position) VALUES (?, ?, ?, ?)')
        .run(proj.id, name, category, -1);
    } catch (err) {
      if (err instanceof Error && /UNIQUE/.test(err.message)) throw new OrcoError('conflict', `There is already a status called ${name}`);
      throw err;
    }
    const added = this.statusByName(proj.id, name);
    list.splice(position, 0, added);
    this.renumber(list);
    return this.workflowChanged(actor, proj, 'workflow.add_status', { name, category });
  }

  updateStatus(actor: Participant, project: string, id: number, input: { name?: string; category?: StatusCategory; position?: number }): TicketStatus[] {
    const proj = this.planner(actor, project);
    const list = this.statuses(proj.id);
    const status = list.find((s) => s.id === id);
    if (!status) throw new OrcoError('not_found', `No status ${id} in ${proj.name}`);
    const name = input.name === undefined ? status.name : this.statusName(input.name);
    const category = input.category === undefined ? status.category : this.category(input.category);
    if (category !== status.category) this.checkWorkflow(list.map((s) => (s.id === id ? { ...s, category } : s)));
    try {
      this.store.db.prepare('UPDATE ticket_statuses SET name = ?, category = ? WHERE id = ?').run(name, category, id);
    } catch (err) {
      if (err instanceof Error && /UNIQUE/.test(err.message)) throw new OrcoError('conflict', `There is already a status called ${name}`);
      throw err;
    }
    if (input.position !== undefined) {
      const rest = list.filter((s) => s.id !== id);
      rest.splice(Math.min(Math.max(input.position, 0), rest.length), 0, status);
      this.renumber(rest);
    }
    return this.workflowChanged(actor, proj, 'workflow.update_status', { id, name, category, position: input.position });
  }

  removeStatus(actor: Participant, project: string, id: number, moveTo: number): TicketStatus[] {
    const proj = this.planner(actor, project);
    const list = this.statuses(proj.id);
    const status = list.find((s) => s.id === id);
    const target = list.find((s) => s.id === moveTo);
    if (!status) throw new OrcoError('not_found', `No status ${id} in ${proj.name}`);
    if (!target || target.id === id) throw new OrcoError('invalid', 'Pick another status for its tickets');
    this.checkWorkflow(list.filter((s) => s.id !== id));
    this.store.begin();
    try {
      this.store.db.prepare(`UPDATE tickets SET status_id = ?, updated_at = ${NOW_SQL} WHERE status_id = ?`).run(target.id, id);
      this.store.db.prepare('DELETE FROM ticket_statuses WHERE id = ?').run(id);
      this.renumber(list.filter((s) => s.id !== id));
      this.store.commit();
    } catch (err) {
      this.store.rollback();
      throw err;
    }
    return this.workflowChanged(actor, proj, 'workflow.remove_status', { name: status.name, movedTo: target.name });
  }

  /** Anyone in the project, agents included, may add a label; only people delete them. */
  createLabel(actor: Participant, project: string, name: string, color?: string): Label {
    const proj = this.writable(actor, project);
    this.store.checkRate(actor, 'post');
    const clean = name.trim();
    if (!LABEL_NAME.test(clean)) throw new OrcoError('invalid', 'Label names are 1-32 letters, digits, spaces or . _ / -');
    const chosen = color ?? LABEL_COLORS[this.labels(proj.id).length % LABEL_COLORS.length]!;
    if (!LABEL_COLORS.includes(chosen)) throw new OrcoError('invalid', `Label color must be one of ${LABEL_COLORS.join(', ')}`);
    try {
      this.store.db.prepare('INSERT INTO labels (project_id, name, color) VALUES (?, ?, ?)').run(proj.id, clean, chosen);
    } catch (err) {
      if (err instanceof Error && /UNIQUE/.test(err.message)) throw new OrcoError('conflict', `Label ${clean} already exists`);
      throw err;
    }
    this.store.audit.record(actor, 'workflow.add_label', { projectId: proj.id, subject: `project:${proj.name}`, detail: { name: clean, color: chosen } });
    this.planChanged(proj.id);
    return this.labels(proj.id).find((l) => l.name.toLowerCase() === clean.toLowerCase())!;
  }

  deleteLabel(actor: Participant, project: string, id: number): void {
    const proj = this.planner(actor, project);
    const label = this.labels(proj.id).find((l) => l.id === id);
    if (!label) throw new OrcoError('not_found', `No label ${id} in ${proj.name}`);
    this.store.db.prepare('DELETE FROM ticket_labels WHERE label_id = ?').run(id);
    this.store.db.prepare('DELETE FROM labels WHERE id = ?').run(id);
    this.store.audit.record(actor, 'workflow.remove_label', { projectId: proj.id, subject: `project:${proj.name}`, detail: { name: label.name } });
    this.planChanged(proj.id);
  }

  createMilestone(actor: Participant, project: string, input: { name: string; description?: string; targetDate?: string | null }): Milestone {
    const proj = this.writable(actor, project);
    this.store.checkRate(actor, 'post');
    const name = input.name.trim();
    if (!name || name.length > 80) throw new OrcoError('invalid', 'Milestone names are 1-80 characters');
    const description = (input.description ?? '').trim().slice(0, 2000);
    const targetDate = checkDate(input.targetDate, 'Target date');
    try {
      this.store.db
        .prepare('INSERT INTO milestones (project_id, name, description, target_date) VALUES (?, ?, ?, ?)')
        .run(proj.id, name, description, targetDate);
    } catch (err) {
      if (err instanceof Error && /UNIQUE/.test(err.message)) throw new OrcoError('conflict', `Milestone ${name} already exists`);
      throw err;
    }
    this.store.audit.record(actor, 'milestone.create', { projectId: proj.id, subject: `project:${proj.name}`, detail: { name, targetDate } });
    this.planChanged(proj.id);
    return this.milestoneByName(proj.id, name);
  }

  updateMilestone(actor: Participant, project: string, id: number, input: { name?: string; description?: string; targetDate?: string | null }): Milestone {
    const proj = this.writable(actor, project);
    this.store.checkRate(actor, 'post');
    const current = this.milestones(proj.id).find((m) => m.id === id);
    if (!current) throw new OrcoError('not_found', `No milestone ${id} in ${proj.name}`);
    const name = input.name === undefined ? current.name : input.name.trim();
    if (!name || name.length > 80) throw new OrcoError('invalid', 'Milestone names are 1-80 characters');
    const description = input.description === undefined ? current.description : input.description.trim().slice(0, 2000);
    const targetDate = input.targetDate === undefined ? current.targetDate : checkDate(input.targetDate, 'Target date');
    try {
      this.store.db.prepare('UPDATE milestones SET name = ?, description = ?, target_date = ? WHERE id = ?').run(name, description, targetDate, id);
    } catch (err) {
      if (err instanceof Error && /UNIQUE/.test(err.message)) throw new OrcoError('conflict', `Milestone ${name} already exists`);
      throw err;
    }
    this.store.audit.record(actor, 'milestone.update', { projectId: proj.id, subject: `project:${proj.name}`, detail: { id, name, targetDate } });
    this.planChanged(proj.id);
    return this.milestones(proj.id).find((m) => m.id === id)!;
  }

  deleteMilestone(actor: Participant, project: string, id: number): void {
    const proj = this.planner(actor, project);
    const milestone = this.milestones(proj.id).find((m) => m.id === id);
    if (!milestone) throw new OrcoError('not_found', `No milestone ${id} in ${proj.name}`);
    this.store.db.prepare('UPDATE tickets SET milestone_id = NULL WHERE milestone_id = ?').run(id);
    this.store.db.prepare('DELETE FROM milestones WHERE id = ?').run(id);
    this.store.audit.record(actor, 'milestone.delete', { projectId: proj.id, subject: `project:${proj.name}`, detail: { name: milestone.name } });
    this.planChanged(proj.id);
  }

  createCycle(actor: Participant, project: string, input: { startsOn?: string; endsOn?: string } = {}): Cycle {
    const proj = this.writable(actor, project);
    this.store.checkRate(actor, 'post');
    const existing = this.cycles(proj.id);
    const last = existing.at(-1);
    const afterLast = last ? addDays(last.endsOn, 1) : null;
    const startsOn = checkDate(input.startsOn, 'Start date') ?? (afterLast && afterLast > this.today() ? afterLast : this.today());
    const endsOn = checkDate(input.endsOn, 'End date') ?? addDays(startsOn, DEFAULT_CYCLE_DAYS - 1);
    if (endsOn < startsOn) throw new OrcoError('invalid', 'A cycle must end on or after its start');
    const overlap = existing.find((c) => c.startsOn <= endsOn && c.endsOn >= startsOn);
    if (overlap) throw new OrcoError('conflict', `That overlaps ${overlap.name} (${overlap.startsOn} to ${overlap.endsOn})`);
    const number = (last?.number ?? 0) + 1;
    this.store.db.prepare('INSERT INTO cycles (project_id, number, starts_on, ends_on) VALUES (?, ?, ?, ?)').run(proj.id, number, startsOn, endsOn);
    this.store.audit.record(actor, 'cycle.create', { projectId: proj.id, subject: `project:${proj.name}`, detail: { number, startsOn, endsOn } });
    this.planChanged(proj.id);
    return this.cycles(proj.id).find((c) => c.number === number)!;
  }

  completeCycle(actor: Participant, project: string, id: number): { cycle: Cycle; movedTo: number | null; moved: number } {
    const proj = this.writable(actor, project);
    this.store.checkRate(actor, 'post');
    const list = this.cycles(proj.id);
    const cycle = list.find((c) => c.id === id);
    if (!cycle) throw new OrcoError('not_found', `No cycle ${id} in ${proj.name}`);
    if (cycle.completedAt) throw new OrcoError('conflict', `${cycle.name} is already complete`);
    const next = list.find((c) => !c.completedAt && c.id !== id && c.startsOn > cycle.startsOn) ?? null;
    const unfinished = this.store.db
      .prepare(
        `SELECT t.id FROM tickets t JOIN ticket_statuses s ON s.id = t.status_id
         WHERE t.cycle_id = ? AND s.category NOT IN ('completed', 'canceled')`,
      )
      .all(id) as unknown as { id: number }[];
    this.store.begin();
    try {
      const move = this.store.db.prepare(`UPDATE tickets SET cycle_id = ?, updated_at = ${NOW_SQL} WHERE id = ?`);
      for (const t of unfinished) {
        move.run(next?.id ?? null, t.id);
        this.activity(t.id, actor, 'change', null, { changes: [{ field: 'cycle', from: cycle.number, to: next?.number ?? null }] });
      }
      this.store.db.prepare(`UPDATE cycles SET completed_at = ${NOW_SQL} WHERE id = ?`).run(id);
      this.store.commit();
    } catch (err) {
      this.store.rollback();
      throw err;
    }
    this.store.audit.record(actor, 'cycle.complete', {
      projectId: proj.id,
      subject: `project:${proj.name}`,
      detail: { number: cycle.number, moved: unfinished.length, movedTo: next?.number ?? null },
    });
    this.planChanged(proj.id);
    return { cycle: this.cycles(proj.id).find((c) => c.id === id)!, movedTo: next?.number ?? null, moved: unfinished.length };
  }

  /* Agents */

  private dispatch(actor: Participant, row: TicketRow): string | undefined {
    const room = this.store.db
      .prepare("SELECT name FROM rooms WHERE project_id = ? ORDER BY name = 'general' DESC, id LIMIT 1")
      .get(row.project_id) as { name: string };
    const ref = refOf(row);
    // The task message is parsed for @mentions; ticket text must not ping people, so the title's @ is
    // swapped for a look-alike. Agents read the rest with get_ticket (see the MCP instructions).
    const request = `Work on ticket ${ref}: ${row.title.replace(/@/g, '＠')}`;
    try {
      const task = this.store.tasks.create(actor, { agent: row.assignee!, room: `${row.project}/${room.name}`, request });
      this.store.db.prepare('UPDATE tickets SET task_id = ? WHERE id = ?').run(task.id, row.id);
      this.activity(row.id, actor, 'task', null, { taskId: task.id, state: task.state, agent: task.assignee });
      return undefined;
    } catch (err) {
      if (!(err instanceof OrcoError)) throw err;
      const warning = `Could not start a task for ${row.assignee}: ${err.message}`;
      this.activity(row.id, actor, 'task', warning, { agent: row.assignee, error: err.code });
      return warning;
    }
  }

  private onTask(task: Task): void {
    const row = this.store.db.prepare(`${TICKET_SELECT} WHERE t.task_id = ?`).get(task.id) as TicketRow | undefined;
    if (!row) return;
    const statuses = this.statuses(row.project_id);
    const current = statuses.find((s) => s.id === row.status_id)!;
    let target: TicketStatus | undefined;
    if (task.state === 'accepted' && (current.category === 'backlog' || current.category === 'unstarted')) {
      target = statuses.find((s) => s.category === 'started');
    } else if (task.state === 'done' && current.category !== 'completed' && current.category !== 'canceled') {
      const started = statuses.filter((s) => s.category === 'started');
      const index = started.findIndex((s) => s.id === current.id);
      target = index === -1 ? started[1] ?? statuses.find((s) => s.category === 'completed') : started[index + 1] ?? statuses.find((s) => s.category === 'completed');
    }
    const agent = this.store.participantByName(task.assignee);
    const actor = task.state === 'cancelled' || task.state === 'declined' ? null : agent;
    if (!['accepted', 'needs_input', 'done', 'failed', 'declined', 'cancelled'].includes(task.state)) return;
    // A task event also fires when a question is answered; only record each state once.
    const last = this.store.db
      .prepare("SELECT detail FROM ticket_activity WHERE ticket_id = ? AND kind = 'task' ORDER BY id DESC LIMIT 1")
      .get(row.id) as { detail: string | null } | undefined;
    const lastState = last?.detail ? (JSON.parse(last.detail) as { taskId?: number; state?: string }) : null;
    if (lastState?.taskId === task.id && (lastState.state === task.state || (lastState.state === 'answered' && task.state === 'accepted'))) return;
    // Back to accepted right after a question means the question was answered.
    const answered = task.state === 'accepted' && lastState?.taskId === task.id && lastState.state === 'needs_input';
    const note = task.state === 'needs_input' ? task.question?.question ?? null : answered ? task.question?.answer ?? null : task.note;
    const answerer = answered && task.question?.answeredBy ? this.store.participantByName(task.question.answeredBy) : null;
    this.activity(row.id, answered ? answerer : actor, 'task', note, {
      taskId: task.id,
      state: answered ? 'answered' : task.state,
      agent: task.assignee,
      ...(answered ? { by: task.question?.answeredBy } : {}),
    });
    if (target && target.id !== current.id) {
      this.store.db
        .prepare(
          `UPDATE tickets SET status_id = ?, sort = ?, updated_at = ${NOW_SQL}, status_changed_at = ${NOW_SQL},
             started_at = CASE WHEN ? = 'started' THEN coalesce(started_at, ${NOW_SQL}) ELSE started_at END,
             completed_at = CASE WHEN ? IN ('completed', 'canceled') THEN ${NOW_SQL} ELSE NULL END
           WHERE id = ?`,
        )
        .run(target.id, this.topSort(target.id), target.category, target.category, row.id);
      this.activity(row.id, actor, 'change', null, { changes: [{ field: 'status', from: current.name, to: target.name }] });
      this.store.audit.record(actor, 'ticket.update', {
        projectId: row.project_id,
        subject: `ticket:${refOf(row)}`,
        detail: { changes: [{ field: 'status', from: current.name, to: target.name }], via: `task:${task.id}` },
      });
      if (['completed', 'canceled'].includes(target.category)) this.noteUnblocked(row.id, actor);
    } else {
      this.store.db.prepare(`UPDATE tickets SET updated_at = ${NOW_SQL} WHERE id = ?`).run(row.id);
    }
    this.changed(row);
  }

  /**
   * Notes a review on a ticket and moves it: to review (the next started status), back to work (the
   * first started status), or to done (the first completed status).
   */
  reviewStep(ticketId: number, actor: Participant | null, to: 'review' | 'rework' | 'done' | null, note: string): void {
    const row = this.row(ticketId);
    if (!row) return;
    const statuses = this.statuses(row.project_id);
    const current = statuses.find((s) => s.id === row.status_id)!;
    const started = statuses.filter((s) => s.category === 'started');
    let target: TicketStatus | undefined;
    if (to === 'review') {
      const index = started.findIndex((s) => s.id === current.id);
      target = index === -1 ? (started[1] ?? started[0]) : started[index + 1];
    } else if (to === 'rework') {
      target = started[0];
    } else if (to === 'done') {
      target = statuses.find((s) => s.category === 'completed');
    }
    this.activity(row.id, actor, 'comment', note, null);
    if (target && target.id !== current.id) {
      this.store.db
        .prepare(
          `UPDATE tickets SET status_id = ?, sort = ?, updated_at = ${NOW_SQL}, status_changed_at = ${NOW_SQL},
             started_at = CASE WHEN ? = 'started' THEN coalesce(started_at, ${NOW_SQL}) ELSE started_at END,
             completed_at = CASE WHEN ? IN ('completed', 'canceled') THEN ${NOW_SQL} ELSE NULL END
           WHERE id = ?`,
        )
        .run(target.id, this.topSort(target.id), target.category, target.category, row.id);
      const changes = [{ field: 'status', from: current.name, to: target.name }];
      this.activity(row.id, actor, 'change', null, { changes });
      this.store.audit.record(actor, 'ticket.update', { projectId: row.project_id, subject: `ticket:${refOf(row)}`, detail: { changes, via: 'review' } });
      if (['completed', 'canceled'].includes(target.category)) this.noteUnblocked(row.id, actor);
    } else {
      this.store.db.prepare(`UPDATE tickets SET updated_at = ${NOW_SQL} WHERE id = ?`).run(row.id);
    }
    this.changed(row);
  }

  /** The room a project's ticket work is announced in (its #general, or its first room). */
  workRoom(projectId: number): string {
    const room = this.store.db
      .prepare("SELECT r.name, p.name AS project FROM rooms r JOIN projects p ON p.id = r.project_id WHERE r.project_id = ? ORDER BY r.name = 'general' DESC, r.id LIMIT 1")
      .get(projectId) as { name: string; project: string };
    return `${room.project}/${room.name}`;
  }

  /** A ticket follows its task when the agent hands the work to another agent. */
  private onHandoff(from: Task, to: Task): void {
    const row = this.store.db.prepare(`${TICKET_SELECT} WHERE t.task_id = ?`).get(from.id) as TicketRow | undefined;
    if (!row) return;
    const agent = this.store.participantByName(to.assignee)!;
    const actor = this.store.participantByName(from.assignee);
    this.store.db
      .prepare(`UPDATE tickets SET assignee_id = ?, task_id = ?, updated_at = ${NOW_SQL} WHERE id = ?`)
      .run(agent.id, to.id, row.id);
    const changes = [{ field: 'assignee', from: from.assignee, to: to.assignee }];
    this.activity(row.id, actor, 'change', null, { changes });
    this.activity(row.id, actor, 'task', null, { taskId: to.id, state: to.state, agent: to.assignee });
    this.store.audit.record(actor, 'ticket.update', { projectId: row.project_id, subject: `ticket:${refOf(row)}`, detail: { changes, via: `task:${from.id}` } });
    this.changed(row);
  }

  /* Helpers */

  private project(actor: Participant, name: string): Project {
    const project = this.store.visibleProject(actor, name);
    this.setup(project.id);
    return project;
  }

  private planner(actor: Participant, name: string): Project {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people change workflow statuses or delete labels and milestones');
    return this.writable(actor, name);
  }

  /** A project the actor may change tickets in (not read-only). */
  private writable(actor: Participant, name: string): Project {
    const project = this.project(actor, name);
    this.store.assertWrite(actor, project.id);
    return project;
  }

  private byRef(actor: Participant, ref: string): TicketRow {
    const match = REF.exec(ref.trim().replace(/^#/, ''));
    if (!match) throw new OrcoError('invalid', `Ticket references look like API-12, got ${ref}`);
    const row = this.store.db
      .prepare(`${TICKET_SELECT} WHERE p.ticket_key = ? AND t.number = ?`)
      .get(match[1]!.toUpperCase(), Number(match[2])) as TicketRow | undefined;
    const found = row ?? this.movedRow(match[1]!.toUpperCase(), Number(match[2]));
    if (!found || !this.store.canSee(actor, found.project_id) || !this.sees(actor, found.id)) throw new OrcoError('not_found', `No ticket ${ref}`);
    return found;
  }

  /** A ref a ticket had before it moved to another project opens it where it is now (#97). */
  private movedRow(key: string, number: number): TicketRow | undefined {
    const moved = this.store.db.prepare('SELECT ticket_id FROM ticket_moves WHERE ticket_key = ? AND number = ?').get(key, number) as { ticket_id: number } | undefined;
    return moved ? this.row(moved.ticket_id) : undefined;
  }

  /**
   * SQL keeping private tickets (#97) to their creator, assignee and waiting-on person, the project's
   * admins, and the agents of any of them. Add it wherever tickets are listed by title.
   */
  privateFilter(actor: Participant, alias = 't'): { sql: string; params: number[] } {
    if (this.store.isSystem(actor)) return { sql: '1', params: [] };
    const human = this.store.humanOf(actor);
    return {
      sql: `(${alias}.private = 0 OR ${alias}.creator_id IN (?, ?) OR ${alias}.assignee_id IN (?, ?) OR ${alias}.waiting_on IN (?, ?)
        OR EXISTS (SELECT 1 FROM project_access pa WHERE pa.project_id = ${alias}.project_id AND pa.user_id = ? AND pa.role = 'admin'))`,
      params: [actor.id, human, actor.id, human, actor.id, human, human],
    };
  }

  /** Whether the actor may see this ticket, private or not (project access is checked separately). */
  sees(actor: Participant, ticketId: number): boolean {
    const f = this.privateFilter(actor);
    return this.store.db.prepare(`SELECT 1 FROM tickets t WHERE t.id = ? AND ${f.sql}`).get(ticketId, ...f.params) !== undefined;
  }

  /**
   * Moves a ticket to another project (#97): it takes the next number there and keeps its comments,
   * criteria, links and history; its old ref keeps opening it. Statuses map by name (or by category),
   * labels by name; milestone, cycle and folder belong to the old project and are cleared. The mover
   * must be able to change tickets in both projects.
   */
  move(actor: Participant, ref: string, projectName: string): Written {
    const row = this.byRef(actor, ref);
    this.store.assertWrite(actor, row.project_id);
    const target = this.writable(actor, projectName);
    if (target.id === row.project_id) return { ticket: this.detail(actor, row.id) };
    const statuses = this.statuses(target.id);
    const status = statuses.find((st) => st.name.toLowerCase() === row.status_name.toLowerCase()) ?? statuses.find((st) => st.category === row.category) ?? statuses[0]!;
    const targetLabels = this.labels(target.id);
    const oldLabels = this.labelsFor([row.id]).get(row.id) ?? [];
    const keep = oldLabels.map((l) => targetLabels.find((t) => t.name.toLowerCase() === l.name.toLowerCase())).filter((l): l is Label => l !== undefined);
    const oldRef = refOf(row);
    this.store.begin();
    try {
      const { number } = this.store.db
        .prepare('UPDATE projects SET next_ticket = next_ticket + 1 WHERE id = ? RETURNING next_ticket - 1 AS number')
        .get(target.id) as { number: number };
      this.store.db.prepare('INSERT OR REPLACE INTO ticket_moves (ticket_key, number, ticket_id) VALUES (?, ?, ?)').run(row.ticket_key, row.number, row.id);
      this.store.db
        .prepare('UPDATE tickets SET project_id = ?, number = ?, status_id = ?, milestone_id = NULL, cycle_id = NULL, folder_id = NULL, parent_id = NULL, sort = ? WHERE id = ?')
        .run(target.id, number, status.id, this.topSort(status.id), row.id);
      this.store.db.prepare('UPDATE tickets SET parent_id = NULL WHERE parent_id = ? AND project_id != ?').run(row.id, target.id);
      this.store.db.prepare('UPDATE ticket_files SET project_id = ? WHERE ticket_id = ?').run(target.id, row.id);
      this.store.db.prepare('DELETE FROM ticket_labels WHERE ticket_id = ?').run(row.id);
      const link = this.store.db.prepare('INSERT INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)');
      for (const l of keep) link.run(row.id, l.id);
      this.activity(row.id, actor, 'change', null, { changes: [{ field: 'project', from: `${row.project} (${oldRef})`, to: target.name }] });
      this.store.commit();
    } catch (err) {
      this.store.rollback();
      throw err;
    }
    const moved = this.row(row.id)!;
    this.store.audit.record(actor, 'ticket.move', { projectId: target.id, subject: `ticket:${refOf(moved)}`, detail: { from: oldRef, to: refOf(moved), fromProject: row.project } });
    this.changed(row);
    this.changed(moved);
    return { ticket: this.detail(actor, row.id) };
  }

  private row(id: number): TicketRow | undefined {
    return this.store.db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(id) as TicketRow | undefined;
  }

  private detail(actor: Participant, id: number, since = 0): Ticket {
    const row = this.row(id)!;
    const [summary] = this.summaries([row], actor);
    const children = (this.store.db.prepare(`${TICKET_SELECT} WHERE t.parent_id = ? ORDER BY t.number`).all(id) as unknown as TicketRow[]).filter((r) => this.sees(actor, r.id));
    const activity = this.store.db
      .prepare(
        `SELECT ta.id, p.name AS actor, p.kind AS actor_kind, ta.kind, ta.body, ta.detail, ta.created_at
         FROM ticket_activity ta LEFT JOIN participants p ON p.id = ta.actor_id
         WHERE ta.ticket_id = ? AND ta.id > ? ORDER BY ta.id`,
      )
      .all(id, since) as unknown as {
      id: number;
      actor: string | null;
      actor_kind: 'user' | 'agent' | null;
      kind: TicketActivity['kind'];
      body: string | null;
      detail: string | null;
      created_at: string;
    }[];
    const criteriaItems = this.store.db
      .prepare('SELECT id, text, done, required, template FROM ticket_criteria WHERE ticket_id = ? ORDER BY position, id')
      .all(id) as unknown as { id: number; text: string; done: number; required: number; template: string | null }[];
    // A linked ticket in a project the viewer cannot see still shows that a link exists, and nothing else.
    const link = (sql: string) =>
      (this.store.db.prepare(sql).all(id) as unknown as TicketRow[]).map((r) =>
        this.store.canSee(actor, r.project_id) && this.sees(actor, r.id)
          ? { ref: refOf(r), title: r.title, status: r.status_name, category: r.category }
          : { ref: HIDDEN_REF, title: 'A ticket in a project you cannot see', status: '', category: r.category },
      );
    const last = this.store.db.prepare('SELECT max(id) AS id FROM ticket_activity WHERE ticket_id = ?').get(id) as { id: number | null };
    return {
      ...summary!,
      description: row.description,
      creator: row.creator,
      handoff: row.handoff ? { text: row.handoff, by: row.handoff_by, at: row.handoff_at } : null,
      criteriaItems: criteriaItems.map((c) => ({ id: c.id, text: c.text, done: c.done === 1, required: c.required === 1, template: c.template })),
      blockers: link(`${TICKET_SELECT} WHERE t.id IN (SELECT blocker_id FROM ticket_links WHERE blocked_id = ?) ORDER BY t.id`),
      blocking: link(`${TICKET_SELECT} WHERE t.id IN (SELECT blocked_id FROM ticket_links WHERE blocker_id = ?) ORDER BY t.id`),
      lastActivityId: last.id ?? 0,
      closedAs:
        row.closed_reason && row.closed_for !== null
          ? { reason: row.closed_reason, ticket: link(`${TICKET_SELECT} WHERE t.id = (SELECT closed_for FROM tickets WHERE id = ?)`)[0]! }
          : null,
      replaces: (this.store.db.prepare(`${TICKET_SELECT} WHERE t.closed_for = ? ORDER BY t.id`).all(id) as unknown as TicketRow[]).map((r) => ({
        ...(this.store.canSee(actor, r.project_id) && this.sees(actor, r.id) ? { ref: refOf(r), title: r.title, status: r.status_name } : { ref: HIDDEN_REF, title: 'A ticket in a project you cannot see', status: '' }),
        category: r.category,
        reason: r.closed_reason!,
      })),
      decisions: this.store.decisions.forTicket(id).map((d) => ({ id: d.id, title: d.title, decision: d.decision, decidedBy: d.decidedBy, at: d.at })),
      approvals: this.store.approvals
        .forTicket(id)
        .map((a) => ({ id: a.id, summary: a.summary, scope: a.scope, state: a.state, decidedBy: a.decidedBy, validUntil: a.validUntil, inForce: a.inForce, actionKind: a.actionKind, standing: a.standing })),
      children: this.summaries(children, actor),
      files: this.store.ticketFiles.forTicket(id),
      spend: this.store.controls.ticketSpend(id),
      commits: this.store.commits.forTicket(id),
      artifacts: this.store.artifacts.forTicket(id).map(({ versions: _v, ...a }) => a),
      activity: activity.map((a) => ({
        id: a.id,
        actor: a.actor,
        actorKind: a.actor_kind,
        kind: a.kind,
        body: a.body,
        detail: a.detail === null ? null : this.redactDetail(actor, JSON.parse(a.detail)),
        createdAt: a.created_at,
      })),
    };
  }

  /** History entries name linked tickets; those in projects the viewer cannot see are hidden. */
  private redactDetail(actor: Participant, detail: unknown): unknown {
    const changes = (detail as { changes?: { field: string; from: unknown; to: unknown }[] } | null)?.changes;
    if (!Array.isArray(changes)) return detail;
    const hide = (refs: unknown) => (Array.isArray(refs) ? refs.map((ref) => (this.refVisible(actor, String(ref)) ? ref : HIDDEN_REF)) : refs);
    return {
      ...(detail as object),
      changes: changes.map((c) => {
        if (c.field === 'blockedBy') return { ...c, from: hide(c.from), to: hide(c.to) };
        if (c.field === 'unblocked') return this.refVisible(actor, String(c.from)) ? c : { ...c, from: HIDDEN_REF };
        // "duplicate of API-2", "API-1 (duplicate)": the ticket ref is the first word that looks like one.
        if (c.field === 'closedAs' || c.field === 'replaces') {
          const text = String(c.to);
          const ref = /[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}/.exec(text)?.[0];
          return ref && !this.refVisible(actor, ref) ? { ...c, to: text.replace(ref, HIDDEN_REF) } : c;
        }
        return c;
      }),
    };
  }

  private refVisible(actor: Participant, ref: string): boolean {
    const match = REF.exec(ref);
    if (!match) return true;
    const project = this.store.db.prepare('SELECT id FROM projects WHERE ticket_key = ? COLLATE NOCASE').get(match[1]!) as { id: number } | undefined;
    return project !== undefined && this.store.canSee(actor, project.id);
  }

  private summaries(rows: TicketRow[], actor: Participant): TicketSummary[] {
    const ids = rows.map((r) => r.id);
    const labels = this.labelsFor(ids);
    const criteria = this.criteriaCounts(ids);
    const blockedBy = this.openBlockers(ids, actor);
    const rulesByProject = new Map<number, ReturnType<Store['order']['forProject']>>();
    const waitsOn = (row: TicketRow): string[] => {
      if (row.category !== 'backlog' && row.category !== 'unstarted') return [];
      if (!rulesByProject.has(row.project_id)) rulesByProject.set(row.project_id, this.store.order.forProject(row.project_id));
      const rules = rulesByProject.get(row.project_id)!;
      if (!rules.length) return [];
      return this.store.order.waitsOn(row.project_id, (labels.get(row.id) ?? []).map((l) => l.name), row.id, rules);
    };
    return rows.map((row) => {
      const state = taskState(row);
      return {
        id: row.id,
        ref: refOf(row),
        project: row.project,
        projectId: row.project_id,
        number: row.number,
        title: row.title,
        status: { id: row.status_id, name: row.status_name, category: row.category },
        priority: PRIORITIES[row.priority]!,
        estimate: row.estimate,
        dueDate: row.due_date,
        assignee: row.assignee ? { name: row.assignee, kind: row.assignee_kind! } : null,
        labels: labels.get(row.id) ?? [],
        milestone: row.milestone_id === null ? null : { id: row.milestone_id, name: row.milestone! },
        cycle: row.cycle_id === null ? null : { id: row.cycle_id, number: row.cycle_number! },
        private: row.private === 1,
        waitsOn: waitsOn(row),
        folder: row.folder_id === null ? null : { id: row.folder_id, name: row.folder!, emoji: row.folder_emoji },
        parent: row.parent_number === null ? null : `${row.ticket_key}-${row.parent_number}`,
        task: row.task_id === null || state === null ? null : { id: row.task_id, state, since: row.task_since!, steps: stepCount(row.task_steps) },
        blockedBy: blockedBy.get(row.id) ?? [],
        blockedReason: row.blocked_reason || null,
        nextStep: row.next_step ? { text: row.next_step, for: row.next_step_for } : null,
        statusChangedAt: row.status_changed_at ?? row.created_at,
        waitingOn: row.waiting_on
          ? {
              person: row.waiting_on,
              ask: row.waiting_ask ?? '',
              since: row.waiting_since ?? row.updated_at,
              snoozedUntil: row.waiting_snoozed_until,
              options: waitingChoices(row.waiting_ask ?? '', row.waiting_options),
            }
          : null,
        blocked: (blockedBy.get(row.id)?.length ?? 0) > 0 || row.blocked_reason !== '',
        criteria: criteria.get(row.id) ?? { done: 0, total: 0 },
        sort: row.sort,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      };
    });
  }

  private criteriaCounts(ids: number[]): Map<number, { done: number; total: number }> {
    const map = new Map<number, { done: number; total: number }>();
    if (ids.length === 0) return map;
    const rows = this.store.db
      .prepare(
        `SELECT ticket_id, count(*) AS total, sum(done) AS done FROM ticket_criteria
         WHERE ticket_id IN (${ids.map(() => '?').join(', ')}) GROUP BY ticket_id`,
      )
      .all(...ids) as unknown as { ticket_id: number; total: number; done: number }[];
    for (const r of rows) map.set(r.ticket_id, { done: r.done, total: r.total });
    return map;
  }

  private openBlockers(ids: number[], actor: Participant): Map<number, string[]> {
    const map = new Map<number, string[]>();
    if (ids.length === 0) return map;
    const rows = this.store.db
      .prepare(
        `SELECT tl.blocked_id, b.id, p.ticket_key, b.number, b.project_id FROM ticket_links tl
         JOIN tickets b ON b.id = tl.blocker_id JOIN ticket_statuses s ON s.id = b.status_id JOIN projects p ON p.id = b.project_id
         WHERE tl.blocked_id IN (${ids.map(() => '?').join(', ')}) AND s.category NOT IN ('completed', 'canceled')
         ORDER BY b.id`,
      )
      .all(...ids) as unknown as { blocked_id: number; id: number; ticket_key: string; number: number; project_id: number }[];
    for (const r of rows) map.set(r.blocked_id, [...(map.get(r.blocked_id) ?? []), this.store.canSee(actor, r.project_id) && this.sees(actor, r.id) ? refOf(r) : HIDDEN_REF]);
    return map;
  }

  private labelsFor(ids: number[]): Map<number, Label[]> {
    const map = new Map<number, Label[]>();
    if (ids.length === 0) return map;
    const rows = this.store.db
      .prepare(
        `SELECT tl.ticket_id, l.id, l.name, l.color FROM ticket_labels tl JOIN labels l ON l.id = tl.label_id
         WHERE tl.ticket_id IN (${ids.map(() => '?').join(', ')}) ORDER BY l.name`,
      )
      .all(...ids) as unknown as (Label & { ticket_id: number })[];
    for (const r of rows) {
      const list = map.get(r.ticket_id) ?? [];
      list.push({ id: r.id, name: r.name, color: r.color });
      map.set(r.ticket_id, list);
    }
    return map;
  }

  /** The ticket a task works, if any. */
  ticketIdForTask(taskId: number): number | null {
    return (this.store.db.prepare('SELECT id FROM tickets WHERE task_id = ?').get(taskId) as { id: number } | undefined)?.id ?? null;
  }

  /** Writes a line into a ticket's history (a question answered, an approval asked or given). */
  note(ticketId: number, actor: Participant | null, kind: 'comment' | 'change', body: string | null, detail: unknown = null): void {
    const row = this.row(ticketId);
    if (!row) return;
    this.activity(ticketId, actor, kind, body, detail);
    this.store.db.prepare(`UPDATE tickets SET updated_at = ${NOW_SQL} WHERE id = ?`).run(ticketId);
    this.changed(row);
  }

  /** A ticket's id from its ref, for a person or agent who can see it. */
  idOf(actor: Participant, ref: string): number {
    return this.byRef(actor, ref).id;
  }

  /**
   * A ticket just closed: each ticket it was the last open blocker of gets a history line and a fresh
   * updated_at, so catch_up and the board show that its work is ready.
   */
  private noteUnblocked(blockerId: number, actor: Participant | null): void {
    const blocker = this.row(blockerId);
    if (!blocker) return;
    const waiting = this.store.db
      .prepare(
        `SELECT tl.blocked_id FROM ticket_links tl JOIN tickets t ON t.id = tl.blocked_id JOIN ticket_statuses s ON s.id = t.status_id
         WHERE tl.blocker_id = ? AND s.category NOT IN ('completed', 'canceled')
           AND NOT EXISTS (SELECT 1 FROM ticket_links o JOIN tickets b ON b.id = o.blocker_id JOIN ticket_statuses bs ON bs.id = b.status_id
                           WHERE o.blocked_id = tl.blocked_id AND bs.category NOT IN ('completed', 'canceled'))`,
      )
      .all(blockerId) as { blocked_id: number }[];
    for (const { blocked_id } of waiting) {
      this.activity(blocked_id, actor, 'change', null, { changes: [{ field: 'unblocked', from: refOf(blocker), to: blocker.status_name }] });
      this.store.db.prepare(`UPDATE tickets SET updated_at = ${NOW_SQL} WHERE id = ?`).run(blocked_id);
      const unblocked = this.row(blocked_id);
      if (unblocked) this.changed(unblocked);
    }
  }

  private activity(ticketId: number, actor: Participant | null, kind: TicketActivity['kind'], body: string | null, detail: unknown): number {
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO ticket_activity (ticket_id, actor_id, kind, body, detail) VALUES (?, ?, ?, ?, ?)')
      .run(ticketId, actor?.id ?? null, kind, body, detail === null ? null : JSON.stringify(detail));
    return Number(lastInsertRowid);
  }

  private changed(row: { project_id: number; ticket_key: string; number: number }): void {
    this.store.events.emit('ticket', { projectId: row.project_id, ref: refOf(row) });
  }

  private planChanged(projectId: number): void {
    this.store.events.emit('ticket', { projectId, ref: null });
  }

  private workflowChanged(actor: Participant, project: Project, action: string, detail: unknown): TicketStatus[] {
    this.store.audit.record(actor, action, { projectId: project.id, subject: `project:${project.name}`, detail });
    this.planChanged(project.id);
    return this.statuses(project.id);
  }

  private statuses(projectId: number): TicketStatus[] {
    const rows = this.store.db
      .prepare('SELECT id, name, category, position FROM ticket_statuses WHERE project_id = ? ORDER BY position, id')
      .all(projectId) as unknown as TicketStatus[];
    return rows.map((r) => ({ id: r.id, name: r.name, category: r.category, position: r.position }));
  }

  private statusByName(projectId: number, name: string): TicketStatus {
    const status = this.statuses(projectId).find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
    if (!status) {
      throw new OrcoError('not_found', `No status ${name}; use one of ${this.statuses(projectId).map((s) => s.name).join(', ')}`);
    }
    return status;
  }

  private renumber(list: TicketStatus[]): void {
    const update = this.store.db.prepare('UPDATE ticket_statuses SET position = ? WHERE id = ?');
    list.forEach((s, i) => update.run(i, s.id));
  }

  private checkWorkflow(list: { category: StatusCategory }[]): void {
    const has = (...cats: StatusCategory[]) => list.some((s) => cats.includes(s.category));
    if (!has('backlog', 'unstarted')) throw new OrcoError('invalid', 'Keep at least one backlog or unstarted status');
    if (!has('started')) throw new OrcoError('invalid', 'Keep at least one started status');
    if (!has('completed')) throw new OrcoError('invalid', 'Keep at least one completed status');
  }

  private statusName(name: string): string {
    const clean = name.trim();
    if (!clean || clean.length > 40) throw new OrcoError('invalid', 'Status names are 1-40 characters');
    return clean;
  }

  private category(category: string): StatusCategory {
    if (!STATUS_CATEGORIES.includes(category as StatusCategory)) {
      throw new OrcoError('invalid', `Status category must be one of ${STATUS_CATEGORIES.join(', ')}`);
    }
    return category as StatusCategory;
  }

  private labels(projectId: number): Label[] {
    const rows = this.store.db.prepare('SELECT id, name, color FROM labels WHERE project_id = ? ORDER BY name').all(projectId) as unknown as Label[];
    return rows.map((r) => ({ id: r.id, name: r.name, color: r.color }));
  }

  private labelIds(projectId: number, names: string[]): number[] {
    const all = this.labels(projectId);
    const ids = new Set<number>();
    for (const name of names) {
      const label = all.find((l) => l.name.toLowerCase() === name.trim().toLowerCase());
      if (!label) {
        throw new OrcoError('not_found', `No label ${name}${all.length ? `; use one of ${all.map((l) => l.name).join(', ')}` : '; a person can create labels in the project settings'}`);
      }
      ids.add(label.id);
    }
    return [...ids];
  }

  private labelNames(ids: number[]): string[] {
    if (ids.length === 0) return [];
    const rows = this.store.db
      .prepare(`SELECT name FROM labels WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY name`)
      .all(...ids) as unknown as { name: string }[];
    return rows.map((r) => r.name);
  }

  private milestones(projectId: number): Milestone[] {
    const rows = this.store.db
      .prepare(
        `SELECT ms.id, ms.name, ms.description, ms.target_date, ${progressColumns('milestone_id', 'ms')}
         FROM milestones ms WHERE ms.project_id = ? ORDER BY ms.target_date IS NULL, ms.target_date, ms.name`,
      )
      .all(projectId) as unknown as (ProgressRow & { id: number; name: string; description: string; target_date: string | null })[];
    return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, targetDate: r.target_date, progress: progressOf(r) }));
  }

  private folderList(projectId: number): Folder[] {
    const rows = this.store.db
      .prepare(
        `SELECT f.id, f.name, f.emoji, f.color, f.position, count(t.id) AS total,
           coalesce(sum(CASE WHEN s.category NOT IN ('completed', 'canceled') THEN 1 ELSE 0 END), 0) AS open
         FROM ticket_folders f
         LEFT JOIN tickets t ON t.folder_id = f.id
         LEFT JOIN ticket_statuses s ON s.id = t.status_id
         WHERE f.project_id = ?
         GROUP BY f.id
         ORDER BY f.position, f.name`,
      )
      .all(projectId) as unknown as Folder[];
    return rows.map((r) => ({ id: r.id, name: r.name, emoji: r.emoji, color: r.color, position: r.position, open: Number(r.open), total: Number(r.total) }));
  }

  private folderByName(projectId: number, name: string): Folder {
    const all = this.folderList(projectId);
    const folder = all.find((f) => f.name.toLowerCase() === name.trim().toLowerCase());
    if (!folder) {
      throw new OrcoError('not_found', `No folder ${name.trim()}${all.length ? `; folders are ${all.map((f) => f.name).join(', ')}` : ''} (create_folder makes one)`);
    }
    return folder;
  }

  /** A project in which the actor may rename, reorder or remove folders: people only. */
  private folderKeeper(actor: Participant, project: string): Project {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people rename, reorder or remove folders; agents can create them');
    return this.writable(actor, project);
  }

  private folderName(value: string): string {
    const name = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!FOLDER_NAME.test(name)) throw new OrcoError('invalid', 'Folder names are 1-40 characters on one line');
    if (name.toLowerCase() === 'none') throw new OrcoError('invalid', '"none" means "no folder" in filters; pick another name');
    return name;
  }

  private folderEmoji(value: string | null | undefined): string | null {
    const emoji = String(value ?? '').trim();
    if (!emoji) return null;
    if (emoji.length > 16 || /\s/.test(emoji)) throw new OrcoError('invalid', 'A folder emoji is one emoji or a short symbol');
    return emoji;
  }

  private folderColor(value: string | null | undefined): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (!LABEL_COLORS.includes(value)) throw new OrcoError('invalid', `Folder color must be one of ${LABEL_COLORS.join(', ')}`);
    return value;
  }

  private milestoneByName(projectId: number, name: string): Milestone {
    const all = this.milestones(projectId);
    const milestone = all.find((m) => m.name.toLowerCase() === name.trim().toLowerCase());
    if (!milestone) throw new OrcoError('not_found', `No milestone ${name}${all.length ? `; use one of ${all.map((m) => m.name).join(', ')}` : ''}`);
    return milestone;
  }

  private cycles(projectId: number): Cycle[] {
    const today = this.today();
    const rows = this.store.db
      .prepare(
        `SELECT cy.id, cy.number, cy.starts_on, cy.ends_on, cy.completed_at, ${progressColumns('cycle_id', 'cy')}
         FROM cycles cy WHERE cy.project_id = ? ORDER BY cy.number`,
      )
      .all(projectId) as unknown as (ProgressRow & { id: number; number: number; starts_on: string; ends_on: string; completed_at: string | null })[];
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      name: `Cycle ${r.number}`,
      startsOn: r.starts_on,
      endsOn: r.ends_on,
      completedAt: r.completed_at,
      current: r.completed_at === null && r.starts_on <= today && r.ends_on >= today,
      progress: progressOf(r),
    }));
  }

  private cycleRef(projectId: number, ref: number | 'current'): Cycle {
    const all = this.cycles(projectId);
    const cycle = ref === 'current' ? all.find((c) => c.current) : all.find((c) => c.number === Number(ref));
    if (!cycle) throw new OrcoError('not_found', ref === 'current' ? 'There is no current cycle' : `No cycle ${ref}`);
    if (cycle.completedAt) throw new OrcoError('invalid', `${cycle.name} is complete; pick a later cycle`);
    return cycle;
  }

  private assignable(projectId: number, name: string): Participant {
    const person = this.store.participantByName(name.replace(/^@/, ''));
    if (!person) throw new OrcoError('not_found', `No user or agent named ${name}`);
    if (!this.store.canSee(person, projectId)) throw new OrcoError('forbidden', `${person.name} is not in this project; add its owner first`);
    return person;
  }

  private parentRow(actor: Participant, projectId: number, ref: string, selfId: number | null): TicketRow {
    const parent = this.byRef(actor, ref);
    if (parent.project_id !== projectId) throw new OrcoError('invalid', 'A parent ticket must be in the same project');
    for (let at: TicketRow | undefined = parent; at; at = at.parent_id === null ? undefined : this.row(at.parent_id)) {
      if (at.id === selfId) throw new OrcoError('invalid', 'A ticket cannot be its own ancestor');
    }
    return parent;
  }

  private topSort(statusId: number): number {
    const row = this.store.db.prepare('SELECT min(sort) AS low FROM tickets WHERE status_id = ?').get(statusId) as { low: number | null };
    return row.low === null ? 0 : row.low - 1;
  }

  private title(raw: string): string {
    const title = raw.trim().replace(/\s+/g, ' ');
    if (!title) throw new OrcoError('invalid', 'Ticket title is empty');
    if (title.length > MAX_TITLE) throw new OrcoError('invalid', `Ticket title is over ${MAX_TITLE} characters`);
    return title;
  }

  private description(raw: string): string {
    const description = raw.trim();
    if (description.length > MAX_DESCRIPTION) throw new OrcoError('invalid', `Description is over ${MAX_DESCRIPTION} characters`);
    return description;
  }

  private priority(value: string): number {
    const index = PRIORITIES.indexOf(value as Priority);
    if (index === -1) throw new OrcoError('invalid', `Priority must be one of ${PRIORITIES.join(', ')}`);
    return index;
  }

  private estimate(value: number | null): number | null {
    if (value === null) return null;
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new OrcoError('invalid', 'Estimate must be a whole number of points from 0 to 100');
    return value;
  }

  private today(): string {
    return new Date(this.store.now()).toISOString().slice(0, 10);
  }
}
