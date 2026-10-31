import type { ApprovalState } from './approvals.js';
import { MAX_APPROVAL_TTL_SECONDS } from './approvals.js';
import { checkTimeZone, nextRun, parseCron } from './cron.js';
import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';
import { OPEN_STATES, type Task } from './tasks.js';

const MAX_REQUEST = 4_000;
const MAX_PER_PERSON = 50;

export interface Schedule {
  id: number;
  room: string;
  projectId: number | null;
  creator: string;
  agent: string;
  request: string;
  cron: string;
  tz: string;
  budgetMinutes: number | null;
  budgetCents: number | null;
  enabled: boolean;
  nextRun: string;
  lastRun: string | null;
  lastTaskId: number | null;
  lastError: string | null;
  /** For a schedule an agent proposed: its owner's decision. Null for schedules people set up. */
  approval: ApprovalState | null;
  /** Whose request each run is: the person who set it up, or who approved an agent's proposal. */
  runAs: string | null;
  createdAt: string;
}

function checkExpiry(minutes: number | null | undefined): number | null {
  if (minutes === undefined || minutes === null) return null;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 43_200) throw new OrcoError('invalid', 'expires_in_minutes is 1 to 43200 (30 days)');
  return minutes;
}

export interface ScheduleInput {
  room: string;
  agent: string;
  request: string;
  cron: string;
  tz?: string;
  budgetMinutes?: number | null;
  budgetCents?: number | null;
  /** Each run expires this long after it was due if it has not started. */
  expiresInMinutes?: number | null;
}

interface ScheduleRow {
  id: number;
  room_id: number;
  room: string;
  project: string | null;
  project_id: number | null;
  creator_id: number;
  creator: string;
  creator_kind: 'user' | 'agent';
  creator_owner_id: number | null;
  run_as_id: number | null;
  run_as: string | null;
  approval_id: number | null;
  approval_state: ApprovalState | null;
  agent_id: number;
  agent: string;
  agent_owner_id: number | null;
  request: string;
  cron: string;
  tz: string;
  budget_minutes: number | null;
  expires_minutes: number | null;
  budget_cents: number | null;
  enabled: number;
  next_run: number;
  last_run: number | null;
  last_task_id: number | null;
  last_error: string | null;
  created_at: string;
}

const SELECT = `
  SELECT s.id, s.room_id, r.name AS room, p.name AS project, r.project_id, s.creator_id, c.name AS creator,
         c.kind AS creator_kind, c.owner_id AS creator_owner_id, s.run_as_id, ra.name AS run_as,
         s.approval_id, ap.state AS approval_state,
         s.agent_id, a.name AS agent, a.owner_id AS agent_owner_id, s.request, s.cron, s.tz, s.budget_minutes,
         s.budget_cents, s.expires_minutes, s.enabled, s.next_run, s.last_run, s.last_task_id, s.last_error, s.created_at
  FROM schedules s
  JOIN rooms r ON r.id = s.room_id
  LEFT JOIN projects p ON p.id = r.project_id
  JOIN participants c ON c.id = s.creator_id
  JOIN participants a ON a.id = s.agent_id
  LEFT JOIN participants ra ON ra.id = s.run_as_id
  LEFT JOIN approvals ap ON ap.id = s.approval_id
`;

function toSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    room: row.project ? `${row.project}/${row.room}` : row.room,
    projectId: row.project_id,
    creator: row.creator,
    agent: row.agent,
    request: row.request,
    cron: row.cron,
    tz: row.tz,
    budgetMinutes: row.budget_minutes,
    budgetCents: row.budget_cents,
    enabled: row.enabled === 1,
    nextRun: new Date(row.next_run).toISOString(),
    lastRun: row.last_run === null ? null : new Date(row.last_run).toISOString(),
    lastTaskId: row.last_task_id,
    lastError: row.last_error,
    approval: row.approval_state,
    runAs: row.run_as,
    createdAt: row.created_at,
  };
}

/**
 * Recurring tasks ("every Monday at 9, triage new tickets"). The server only keeps the schedule; when
 * one is due it creates an ordinary task as the person who set it up, so consent rules apply as usual
 * and the bridge wakes the agent. A run is skipped while the previous one is still open. An agent can
 * propose a schedule: it stays paused until the agent's owner approves, and then runs as the owner.
 */
export class Schedules {
  constructor(private readonly store: Store) {}

  create(actor: Participant, input: ScheduleInput): Schedule {
    this.store.unscoped(actor, 'set up schedules');
    const { room, agent, request, cron, tz } = this.check(actor, input);
    this.store.assertWrite(actor, room.projectId);
    const count = (this.store.db.prepare('SELECT count(*) AS n FROM schedules WHERE creator_id = ?').get(actor.id) as { n: number }).n;
    if (count >= MAX_PER_PERSON) throw new OrcoError('conflict', `You have ${MAX_PER_PERSON} schedules already`);
    const next = nextRun(parseCron(cron), this.store.now(), tz);
    const proposed = actor.kind === 'agent';
    const { lastInsertRowid } = this.store.db
      .prepare(
        `INSERT INTO schedules (room_id, creator_id, agent_id, request, cron, tz, budget_minutes, budget_cents, next_run, enabled, run_as_id, expires_minutes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(room.id, actor.id, agent.id, request, cron, tz, input.budgetMinutes ?? null, input.budgetCents ?? null, next, proposed ? 0 : 1, proposed ? null : actor.id, checkExpiry(input.expiresInMinutes));
    const id = Number(lastInsertRowid);
    if (proposed) {
      const approval = this.store.approvals.request(actor, {
        room: room.ref,
        summary: `Schedule a recurring task for ${agent.name} (${cron}, ${tz}): ${request}`.slice(0, 300),
        details: `Each run is created as you, so it counts as your request. You can pause or delete it later under Tickets → Schedules.`,
        approver: 'owner',
        ttlSeconds: MAX_APPROVAL_TTL_SECONDS,
      });
      this.store.db.prepare('UPDATE schedules SET approval_id = ? WHERE id = ?').run(approval.id, id);
    }
    const schedule = this.byId(id)!;
    this.store.audit.record(actor, 'schedule.create', { projectId: room.projectId, subject: `schedule:${id}`, detail: { agent: agent.name, room: room.ref, request, cron, tz, proposed } });
    this.changed(schedule);
    return schedule;
  }

  /** The owner's decision on an agent's proposed schedule. Called by Approvals. */
  onApproval(approvalId: number, decision: 'approved' | 'denied', actor: Participant): void {
    const row = this.store.db.prepare(`${SELECT} WHERE s.approval_id = ?`).get(approvalId) as ScheduleRow | undefined;
    if (!row) return;
    if (decision === 'approved') {
      const next = nextRun(parseCron(row.cron), this.store.now(), row.tz);
      this.store.db.prepare('UPDATE schedules SET enabled = 1, run_as_id = ?, next_run = ?, last_error = NULL WHERE id = ?').run(actor.id, next, row.id);
    } else {
      this.store.db.prepare('UPDATE schedules SET enabled = 0, last_error = ? WHERE id = ?').run(`Not approved by ${actor.name}.`, row.id);
    }
    this.changed(this.byId(row.id)!);
  }

  /**
   * The person who set it up (or the owner of the agent that proposed it) may change anything; the
   * proposing agent may pause or resume it once approved; the scheduled agent's owner may pause it.
   */
  update(actor: Participant, id: number, input: Partial<ScheduleInput> & { enabled?: boolean }): Schedule {
    const row = this.visible(actor, id);
    const isManager = actor.kind === 'user' && (row.creator_id === actor.id || (row.creator_kind === 'agent' && row.creator_owner_id === actor.id));
    const isProposer = actor.kind === 'agent' && row.creator_id === actor.id;
    const isOwner = row.agent_owner_id === actor.id;
    const onlyToggle = Object.keys(input).every((key) => key === 'enabled' || input[key as keyof typeof input] === undefined);
    if (!isManager && !((isOwner || isProposer) && onlyToggle)) {
      throw new OrcoError(
        'forbidden',
        isProposer ? 'Propose a new schedule instead of changing this one' : isOwner ? `Only ${row.creator} can change what this schedule asks; you can pause it` : `Schedule ${id} is ${row.creator}'s`,
      );
    }
    if (isProposer && input.enabled && row.run_as_id === null) throw new OrcoError('forbidden', 'This schedule is waiting for your owner\'s approval');
    const current = toSchedule(row);
    const merged = isManager && !onlyToggle ? this.check(actor, { ...current, ...stripUndefined(input) }) : null;
    // A person who edits or turns on an agent's proposal takes it on: runs become their requests.
    const runAs = isManager && (merged || input.enabled) ? actor.id : row.run_as_id;
    if (input.enabled && runAs === null) throw new OrcoError('forbidden', 'This schedule is waiting for approval');
    const cron = merged?.cron ?? row.cron;
    const tz = merged?.tz ?? row.tz;
    const enabled = input.enabled ?? row.enabled === 1;
    const next = nextRun(parseCron(cron), this.store.now(), tz);
    this.store.db
      .prepare(
        `UPDATE schedules SET room_id = ?, agent_id = ?, request = ?, cron = ?, tz = ?, budget_minutes = ?, budget_cents = ?,
           enabled = ?, next_run = ?, last_error = CASE WHEN ? THEN NULL ELSE last_error END, run_as_id = ? WHERE id = ?`,
      )
      .run(
        merged?.room.id ?? row.room_id,
        merged?.agent.id ?? row.agent_id,
        merged?.request ?? row.request,
        cron,
        tz,
        input.budgetMinutes !== undefined ? input.budgetMinutes : row.budget_minutes,
        input.budgetCents !== undefined ? input.budgetCents : row.budget_cents,
        enabled ? 1 : 0,
        next,
        enabled && row.enabled === 0 ? 1 : 0,
        runAs,
        id,
      );
    const schedule = this.byId(id)!;
    this.store.audit.record(actor, 'schedule.update', { projectId: schedule.projectId, subject: `schedule:${id}`, detail: { ...stripUndefined(input) } });
    this.changed(schedule);
    return schedule;
  }

  delete(actor: Participant, id: number): void {
    const row = this.visible(actor, id);
    const allowed = [row.creator_id, row.agent_owner_id, row.creator_kind === 'agent' ? row.creator_owner_id : null].includes(actor.id);
    if (!allowed) throw new OrcoError('forbidden', `Schedule ${id} is ${row.creator}'s`);
    if (row.approval_id !== null) this.store.approvals.withdraw(row.approval_id);
    this.store.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    this.store.audit.record(actor, 'schedule.delete', { projectId: row.project_id, subject: `schedule:${id}`, detail: { request: row.request } });
    this.store.events.emit('schedule', { projectId: row.project_id });
  }

  list(actor: Participant, project?: string): Schedule[] {
    const projectId = project ? this.store.visibleProject(actor, project).id : undefined;
    const rows = this.store.db.prepare(`${SELECT} ORDER BY s.next_run`).all() as unknown as ScheduleRow[];
    return rows
      .filter((row) => this.store.canSee(actor, row.project_id) && (projectId === undefined || row.project_id === projectId))
      .map(toSchedule);
  }

  /** Creates the tasks that are due. Called once a minute by the server. */
  runDue(): Task[] {
    const now = this.store.now();
    const due = this.store.db
      .prepare(`${SELECT} WHERE s.enabled = 1 AND s.run_as_id IS NOT NULL AND s.next_run <= ? ORDER BY s.next_run`)
      .all(now) as unknown as ScheduleRow[];
    const created: Task[] = [];
    for (const row of due) {
      let next: number;
      try {
        next = nextRun(parseCron(row.cron), now, row.tz);
      } catch {
        this.store.db.prepare("UPDATE schedules SET enabled = 0, last_error = 'The schedule no longer parses' WHERE id = ?").run(row.id);
        continue;
      }
      const previous = row.last_task_id === null ? null : this.store.tasks.find(row.last_task_id);
      let error: string | null = null;
      let taskId = row.last_task_id;
      if (previous && OPEN_STATES.includes(previous.state)) {
        error = `Skipped a run: task #${previous.id} from the last run is still ${previous.state}.`;
      } else {
        try {
          const creator = this.store.participantById(row.run_as_id ?? row.creator_id)!;
          const room = this.store.db.prepare('SELECT name FROM rooms WHERE id = ?').get(row.room_id) as { name: string };
          const task = this.store.tasks.create(creator, {
            agent: row.agent,
            room: row.project ? `${row.project}/${room.name}` : room.name,
            request: row.request,
            budgetMinutes: row.budget_minutes,
            budgetCents: row.budget_cents,
            scheduleId: row.id,
            expiresAt: row.expires_minutes ? now + row.expires_minutes * 60_000 : null,
          });
          taskId = task.id;
          created.push(task);
        } catch (err) {
          if (!(err instanceof OrcoError)) throw err;
          error = `Could not start the task: ${err.message}`;
        }
      }
      this.store.db.prepare('UPDATE schedules SET next_run = ?, last_run = ?, last_task_id = ?, last_error = ? WHERE id = ?').run(next, now, taskId, error, row.id);
      this.store.audit.record(null, 'schedule.run', { projectId: row.project_id, subject: `schedule:${row.id}`, detail: { taskId, error } });
      this.changed(this.byId(row.id)!);
    }
    return created;
  }

  private check(actor: Participant, input: ScheduleInput) {
    const room = this.store.room(actor, input.room);
    const agent = this.store.participantByName(input.agent.replace(/^@/, ''));
    if (!agent || agent.kind !== 'agent') throw new OrcoError('not_found', `No agent named ${input.agent}`);
    if (!this.store.canSee(agent, room.projectId)) throw new OrcoError('forbidden', `${agent.name} cannot see ${room.ref}`);
    const request = input.request.trim();
    if (!request) throw new OrcoError('invalid', 'Say what the agent should do each time');
    if (request.length > MAX_REQUEST) throw new OrcoError('invalid', `The request is over ${MAX_REQUEST} characters`);
    const cron = input.cron.trim().replace(/\s+/g, ' ');
    parseCron(cron);
    const tz = checkTimeZone(input.tz?.trim() || 'UTC');
    for (const [value, max, what] of [
      [input.budgetMinutes, 7 * 24 * 60, 'A time budget is 1 to 10080 minutes'],
      [input.budgetCents, 1_000_000, 'A cost budget is 1 to 1000000 cents'],
    ] as const) {
      if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 1 || value > max)) throw new OrcoError('invalid', what);
    }
    return { room, agent, request, cron, tz };
  }

  private visible(actor: Participant, id: number): ScheduleRow {
    const row = this.store.db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as ScheduleRow | undefined;
    if (!row || !this.store.canSee(actor, row.project_id)) throw new OrcoError('not_found', `No schedule ${id}`);
    return row;
  }

  private changed(schedule: Schedule): void {
    this.store.events.emit('schedule', { projectId: schedule.projectId });
  }

  private byId(id: number): Schedule | null {
    const row = this.store.db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as ScheduleRow | undefined;
    return row ? toSchedule(row) : null;
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
