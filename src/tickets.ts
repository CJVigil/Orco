import { OrcoError } from './errors.js';
import type { Participant, Project, Store } from './store.js';
import { OPEN_STATES, type Task, type TaskState } from './tasks.js';

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
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LABEL_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._/-]{0,31}$/u;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 20_000;
const MAX_COMMENT = 10_000;
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
  parent: string | null;
  task: { id: number; state: TaskState; since: string } | null;
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

export interface Ticket extends TicketSummary {
  description: string;
  creator: string;
  children: TicketSummary[];
  activity: TicketActivity[];
}

export interface TicketInput {
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
  parent?: string | null;
  sort?: number;
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
  priority?: Priority;
  parent?: string;
  query?: string;
  limit?: number;
}

export interface ProjectPlan {
  project: string;
  key: string;
  statuses: TicketStatus[];
  labels: Label[];
  milestones: Milestone[];
  cycles: Cycle[];
  members: { name: string; kind: 'user' | 'agent'; owner: string | null }[];
}

export interface Written {
  ticket: Ticket;
  warning?: string;
}

interface TicketRow {
  id: number;
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
  task_approval_state: string | null;
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
         t.cycle_id, cy.number AS cycle_number, t.task_id, tk.state AS task_state, tk.updated_at AS task_since,
         ap.state AS task_approval_state, t.sort, t.created_at, t.updated_at, t.started_at, t.completed_at
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
`;

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

function taskState(row: { task_state: TaskState | null; task_approval_state: string | null }): TaskState | null {
  if (row.task_state === 'requested' && row.task_approval_state === 'pending') return 'awaiting_approval';
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

export class Tickets {
  constructor(private readonly store: Store) {
    store.events.on('task', (task: Task) => this.onTask(task));
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

  create(actor: Participant, project: string, input: TicketInput & { title: string }): Written {
    const proj = this.project(actor, project);
    this.store.checkRate(actor, 'post');
    const title = this.title(input.title);
    const description = this.description(input.description ?? '');
    const status = input.status ? this.statusByName(proj.id, input.status) : this.statuses(proj.id).find((s) => s.category === 'backlog' || s.category === 'unstarted')!;
    const assignee = input.assignee ? this.assignable(proj.id, input.assignee) : null;
    const labels = this.labelIds(proj.id, input.labels ?? []);
    const milestoneId = input.milestone ? this.milestoneByName(proj.id, input.milestone).id : null;
    const cycleId = input.cycle === undefined || input.cycle === null ? null : this.cycleRef(proj.id, input.cycle).id;
    const parentId = input.parent ? this.parentRow(actor, proj.id, input.parent, null).id : null;
    const priority = this.priority(input.priority ?? 'none');
    const estimate = this.estimate(input.estimate ?? null);
    const dueDate = checkDate(input.dueDate, 'Due date');

    this.store.db.exec('BEGIN');
    let id: number;
    try {
      const { number } = this.store.db
        .prepare('UPDATE projects SET next_ticket = next_ticket + 1 WHERE id = ? RETURNING next_ticket - 1 AS number')
        .get(proj.id) as { number: number };
      const sort = input.sort ?? this.topSort(status.id);
      const { lastInsertRowid } = this.store.db
        .prepare(
          `INSERT INTO tickets (project_id, number, title, description, status_id, priority, estimate, due_date, assignee_id,
             creator_id, parent_id, milestone_id, cycle_id, sort, started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             CASE WHEN ? = 'started' THEN ${NOW_SQL} END, CASE WHEN ? IN ('completed', 'canceled') THEN ${NOW_SQL} END)`,
        )
        .run(proj.id, number, title, description, status.id, priority, estimate, dueDate, assignee?.id ?? null, actor.id, parentId,
          milestoneId, cycleId, sort, status.category, status.category);
      id = Number(lastInsertRowid);
      const link = this.store.db.prepare('INSERT INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)');
      for (const labelId of labels) link.run(id, labelId);
      this.activity(id, actor, 'created', null, null);
      this.store.db.exec('COMMIT');
    } catch (err) {
      this.store.db.exec('ROLLBACK');
      throw err;
    }
    const created = this.row(id)!;
    this.store.audit.record(actor, 'ticket.create', { projectId: proj.id, subject: `ticket:${refOf(created)}`, detail: { title } });
    const warning = assignee?.kind === 'agent' ? this.dispatch(actor, created) : undefined;
    this.changed(created);
    return { ticket: this.detail(id), ...(warning ? { warning } : {}) };
  }

  update(actor: Participant, ref: string, input: TicketInput): Written {
    const row = this.byRef(actor, ref);
    this.store.checkRate(actor, 'post');
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const changes: { field: string; from: unknown; to: unknown }[] = [];
    const set = (column: string, value: string | number | null) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

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
        changes.push({ field: 'description', from: null, to: null });
      }
    }
    let newStatus: TicketStatus | null = null;
    if (input.status !== undefined) {
      const status = this.statusByName(row.project_id, input.status);
      if (status.id !== row.status_id) {
        newStatus = status;
        changes.push({ field: 'status', from: row.status_name, to: status.name });
      }
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
    if (input.parent !== undefined) {
      const parent = input.parent ? this.parentRow(actor, row.project_id, input.parent, row.id) : null;
      if ((parent?.id ?? null) !== row.parent_id) {
        set('parent_id', parent?.id ?? null);
        changes.push({ field: 'parent', from: row.parent_number === null ? null : `${row.ticket_key}-${row.parent_number}`, to: parent ? refOf(parent) : null });
      }
    }
    if (newStatus) {
      set('status_id', newStatus.id);
      if (newStatus.category === 'started') sets.push(`started_at = coalesce(started_at, ${NOW_SQL})`);
      sets.push(`completed_at = ${['completed', 'canceled'].includes(newStatus.category) ? NOW_SQL : 'NULL'}`);
      if (input.sort === undefined) set('sort', this.topSort(newStatus.id));
    }
    if (input.sort !== undefined) {
      if (!Number.isFinite(input.sort)) throw new OrcoError('invalid', 'Sort must be a number');
      set('sort', input.sort);
    }
    if (sets.length === 0 && newLabels === undefined) return { ticket: this.detail(row.id) };

    // Reassigning away from an agent stops the work it was doing on this ticket.
    if (newAssignee !== undefined && row.task_id !== null && OPEN_STATES.includes(taskState(row)!)) {
      try {
        this.store.tasks.update(actor, row.task_id, 'cancelled', `Ticket ${refOf(row)} was reassigned`);
      } catch (err) {
        if (err instanceof OrcoError && err.code === 'forbidden') {
          throw new OrcoError('conflict', `${row.assignee} is still working on task #${row.task_id}; its requester or owner must cancel it first`);
        }
        throw err;
      }
    }

    this.store.db.exec('BEGIN');
    try {
      if (sets.length) this.store.db.prepare(`UPDATE tickets SET ${sets.join(', ')}, updated_at = ${NOW_SQL} WHERE id = ?`).run(...params, row.id);
      if (newLabels !== undefined) {
        this.store.db.prepare('DELETE FROM ticket_labels WHERE ticket_id = ?').run(row.id);
        const link = this.store.db.prepare('INSERT INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)');
        for (const labelId of newLabels) link.run(row.id, labelId);
        if (!sets.length) this.store.db.prepare(`UPDATE tickets SET updated_at = ${NOW_SQL} WHERE id = ?`).run(row.id);
      }
      if (changes.length) this.activity(row.id, actor, 'change', null, { changes });
      this.store.db.exec('COMMIT');
    } catch (err) {
      this.store.db.exec('ROLLBACK');
      throw err;
    }
    const updated = this.row(row.id)!;
    if (changes.length) {
      this.store.audit.record(actor, 'ticket.update', { projectId: row.project_id, subject: `ticket:${refOf(row)}`, detail: { changes } });
    }
    const warning = newAssignee?.kind === 'agent' ? this.dispatch(actor, updated) : undefined;
    this.changed(updated);
    return { ticket: this.detail(row.id), ...(warning ? { warning } : {}) };
  }

  comment(actor: Participant, ref: string, body: string): Ticket {
    const row = this.byRef(actor, ref);
    const text = body.trim();
    if (!text) throw new OrcoError('invalid', 'Comment is empty');
    if (text.length > MAX_COMMENT) throw new OrcoError('invalid', `Comment is over ${MAX_COMMENT} characters`);
    this.store.checkRate(actor, 'post');
    this.activity(row.id, actor, 'comment', text, null);
    this.store.db.prepare(`UPDATE tickets SET updated_at = ${NOW_SQL} WHERE id = ?`).run(row.id);
    this.store.audit.record(actor, 'ticket.comment', { projectId: row.project_id, subject: `ticket:${refOf(row)}`, detail: { text } });
    this.changed(row);
    return this.detail(row.id);
  }

  startTask(actor: Participant, ref: string): Written {
    const row = this.byRef(actor, ref);
    if (row.assignee_kind !== 'agent') throw new OrcoError('invalid', `Assign ${refOf(row)} to an agent first`);
    if (row.task_id !== null && OPEN_STATES.includes(taskState(row)!)) {
      throw new OrcoError('conflict', `${row.assignee} already has task #${row.task_id} for ${refOf(row)}`);
    }
    const warning = this.dispatch(actor, row);
    if (warning) throw new OrcoError('forbidden', warning);
    this.changed(row);
    return { ticket: this.detail(row.id) };
  }

  get(actor: Participant, ref: string): Ticket {
    return this.detail(this.byRef(actor, ref).id);
  }

  list(actor: Participant, filter: TicketFilter = {}): TicketSummary[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.project) {
      const project = this.project(actor, filter.project);
      where.push('t.project_id = ?');
      params.push(project.id);
    } else {
      where.push('t.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)');
      params.push(this.store.humanOf(actor));
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
    if (filter.priority) {
      where.push('t.priority = ?');
      params.push(this.priority(filter.priority));
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
    return this.summaries(rows);
  }

  /* Workflow, labels, milestones and cycles */

  plan(actor: Participant, project: string): ProjectPlan {
    const proj = this.project(actor, project);
    const key = (this.store.db.prepare('SELECT ticket_key FROM projects WHERE id = ?').get(proj.id) as { ticket_key: string }).ticket_key;
    return {
      project: proj.name,
      key,
      statuses: this.statuses(proj.id),
      labels: this.labels(proj.id),
      milestones: this.milestones(proj.id),
      cycles: this.cycles(proj.id),
      members: this.store.members(actor, proj.name).map((p) => ({ name: p.name, kind: p.kind, owner: p.owner })),
    };
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
    this.store.db.exec('BEGIN');
    try {
      this.store.db.prepare(`UPDATE tickets SET status_id = ?, updated_at = ${NOW_SQL} WHERE status_id = ?`).run(target.id, id);
      this.store.db.prepare('DELETE FROM ticket_statuses WHERE id = ?').run(id);
      this.renumber(list.filter((s) => s.id !== id));
      this.store.db.exec('COMMIT');
    } catch (err) {
      this.store.db.exec('ROLLBACK');
      throw err;
    }
    return this.workflowChanged(actor, proj, 'workflow.remove_status', { name: status.name, movedTo: target.name });
  }

  createLabel(actor: Participant, project: string, name: string, color?: string): Label {
    const proj = this.planner(actor, project);
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
    const proj = this.planner(actor, project);
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
    const proj = this.planner(actor, project);
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
    const proj = this.planner(actor, project);
    const existing = this.cycles(proj.id);
    const last = existing.at(-1);
    const startsOn = checkDate(input.startsOn, 'Start date') ?? (last ? addDays(last.endsOn, 1) : this.today());
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
    const proj = this.planner(actor, project);
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
    this.store.db.exec('BEGIN');
    try {
      const move = this.store.db.prepare(`UPDATE tickets SET cycle_id = ?, updated_at = ${NOW_SQL} WHERE id = ?`);
      for (const t of unfinished) {
        move.run(next?.id ?? null, t.id);
        this.activity(t.id, actor, 'change', null, { changes: [{ field: 'cycle', from: cycle.number, to: next?.number ?? null }] });
      }
      this.store.db.prepare(`UPDATE cycles SET completed_at = ${NOW_SQL} WHERE id = ?`).run(id);
      this.store.db.exec('COMMIT');
    } catch (err) {
      this.store.db.exec('ROLLBACK');
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
    const description = row.description.length > 1500 ? `${row.description.slice(0, 1500)}…` : row.description;
    const request =
      `Ticket ${ref}: ${row.title}${description ? `\n\n${description}` : ''}\n\n` +
      `Read it with get_ticket("${ref}"). Keep it current with update_ticket and comment_ticket, ` +
      'and mark this task done when the work is ready for review.';
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
    if (!['accepted', 'done', 'failed', 'declined', 'cancelled'].includes(task.state)) return;
    this.activity(row.id, actor, 'task', task.note, { taskId: task.id, state: task.state, agent: task.assignee });
    if (target && target.id !== current.id) {
      this.store.db
        .prepare(
          `UPDATE tickets SET status_id = ?, sort = ?, updated_at = ${NOW_SQL},
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
    } else {
      this.store.db.prepare(`UPDATE tickets SET updated_at = ${NOW_SQL} WHERE id = ?`).run(row.id);
    }
    this.changed(row);
  }

  /* Helpers */

  private project(actor: Participant, name: string): Project {
    const project = this.store.visibleProject(actor, name);
    this.setup(project.id);
    return project;
  }

  private planner(actor: Participant, name: string): Project {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people can change workflows, labels, milestones and cycles');
    return this.project(actor, name);
  }

  private byRef(actor: Participant, ref: string): TicketRow {
    const match = REF.exec(ref.trim().replace(/^#/, ''));
    if (!match) throw new OrcoError('invalid', `Ticket references look like API-12, got ${ref}`);
    const row = this.store.db
      .prepare(`${TICKET_SELECT} WHERE p.ticket_key = ? AND t.number = ?`)
      .get(match[1]!.toUpperCase(), Number(match[2])) as TicketRow | undefined;
    if (!row || !this.store.canSee(actor, row.project_id)) throw new OrcoError('not_found', `No ticket ${ref}`);
    return row;
  }

  private row(id: number): TicketRow | undefined {
    return this.store.db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(id) as TicketRow | undefined;
  }

  private detail(id: number): Ticket {
    const row = this.row(id)!;
    const [summary] = this.summaries([row]);
    const children = this.store.db.prepare(`${TICKET_SELECT} WHERE t.parent_id = ? ORDER BY t.number`).all(id) as unknown as TicketRow[];
    const activity = this.store.db
      .prepare(
        `SELECT ta.id, p.name AS actor, p.kind AS actor_kind, ta.kind, ta.body, ta.detail, ta.created_at
         FROM ticket_activity ta LEFT JOIN participants p ON p.id = ta.actor_id
         WHERE ta.ticket_id = ? ORDER BY ta.id`,
      )
      .all(id) as unknown as {
      id: number;
      actor: string | null;
      actor_kind: 'user' | 'agent' | null;
      kind: TicketActivity['kind'];
      body: string | null;
      detail: string | null;
      created_at: string;
    }[];
    return {
      ...summary!,
      description: row.description,
      creator: row.creator,
      children: this.summaries(children),
      activity: activity.map((a) => ({
        id: a.id,
        actor: a.actor,
        actorKind: a.actor_kind,
        kind: a.kind,
        body: a.body,
        detail: a.detail === null ? null : JSON.parse(a.detail),
        createdAt: a.created_at,
      })),
    };
  }

  private summaries(rows: TicketRow[]): TicketSummary[] {
    const labels = this.labelsFor(rows.map((r) => r.id));
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
        parent: row.parent_number === null ? null : `${row.ticket_key}-${row.parent_number}`,
        task: row.task_id === null || state === null ? null : { id: row.task_id, state, since: row.task_since! },
        sort: row.sort,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      };
    });
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

  private activity(ticketId: number, actor: Participant | null, kind: TicketActivity['kind'], body: string | null, detail: unknown): void {
    this.store.db
      .prepare('INSERT INTO ticket_activity (ticket_id, actor_id, kind, body, detail) VALUES (?, ?, ?, ?, ?)')
      .run(ticketId, actor?.id ?? null, kind, body, detail === null ? null : JSON.stringify(detail));
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
