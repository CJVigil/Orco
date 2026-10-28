import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';
import { OPEN_STATES } from './tasks.js';

const MAX_AHEAD_MS = 7 * 24 * 3600_000;
const MAX_PENDING_PER_TASK = 5;
const MAX_NOTE = 500;

export interface Reminder {
  id: number;
  taskId: number;
  dueAt: string;
  note: string;
  fired: boolean;
}

export interface Wake {
  reminderId: number;
  taskId: number;
  agentId: number;
  agent: string;
  note: string;
}

interface ReminderRow {
  id: number;
  task_id: number;
  agent_id: number;
  due_at: number;
  note: string;
  fired_at: number | null;
}

function toReminder(row: ReminderRow): Reminder {
  return { id: row.id, taskId: row.task_id, dueAt: new Date(row.due_at).toISOString(), note: row.note, fired: row.fired_at !== null };
}

/**
 * "Wake me later": an agent working a task asks to be started again at a time ("check CI in 10
 * minutes"). When it is due, Orco notes it in the task thread and sends a `wake` event; the bridge
 * starts the agent with the note. Reminders on a task that has closed are dropped.
 */
export class Reminders {
  constructor(private readonly store: Store) {}

  create(actor: Participant, taskId: number, when: { inMinutes?: number; at?: string }, note: string): Reminder {
    const task = this.store.tasks.get(actor, taskId);
    if (task.assignee !== actor.name) throw new OrcoError('forbidden', `Only ${task.assignee} can set reminders on task ${taskId}`);
    if (!OPEN_STATES.includes(task.state)) throw new OrcoError('conflict', `Task ${taskId} is ${task.state}`);
    const text = note.trim();
    if (!text) throw new OrcoError('invalid', 'Say what to do when the reminder fires');
    if (text.length > MAX_NOTE) throw new OrcoError('invalid', `Keep the note under ${MAX_NOTE} characters`);
    const now = this.store.now();
    let due: number;
    if (when.at !== undefined) {
      due = Date.parse(when.at);
      if (Number.isNaN(due)) throw new OrcoError('invalid', 'at must be a date and time like 2026-11-03T09:00:00Z');
    } else if (when.inMinutes !== undefined && Number.isInteger(when.inMinutes)) {
      due = now + when.inMinutes * 60_000;
    } else {
      throw new OrcoError('invalid', 'Give in_minutes or at');
    }
    if (due < now + 60_000) throw new OrcoError('invalid', 'A reminder is at least a minute away');
    if (due > now + MAX_AHEAD_MS) throw new OrcoError('invalid', 'A reminder is at most 7 days away');
    const pending = (this.store.db.prepare('SELECT count(*) AS n FROM reminders WHERE task_id = ? AND fired_at IS NULL').get(taskId) as { n: number }).n;
    if (pending >= MAX_PENDING_PER_TASK) throw new OrcoError('conflict', `Task ${taskId} has ${MAX_PENDING_PER_TASK} reminders waiting already`);
    this.store.checkRate(actor, 'post');
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO reminders (task_id, agent_id, due_at, note) VALUES (?, ?, ?, ?)')
      .run(taskId, actor.id, due, text);
    this.store.audit.record(actor, 'reminder.create', { projectId: task.projectId, subject: `task:${taskId}`, detail: { dueAt: new Date(due).toISOString(), note: text } });
    return this.byId(Number(lastInsertRowid))!;
  }

  pendingFor(actor: Participant): Reminder[] {
    const rows = this.store.db.prepare('SELECT * FROM reminders WHERE agent_id = ? AND fired_at IS NULL ORDER BY due_at').all(actor.id) as unknown as ReminderRow[];
    return rows.map(toReminder);
  }

  cancel(actor: Participant, id: number): void {
    const row = this.store.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as ReminderRow | undefined;
    if (!row || row.agent_id !== actor.id) throw new OrcoError('not_found', `No reminder ${id} of yours`);
    if (row.fired_at !== null) throw new OrcoError('conflict', `Reminder ${id} already fired`);
    this.store.db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
  }

  /** Fires the reminders that are due. Called once a minute by the server. */
  fireDue(): Wake[] {
    const now = this.store.now();
    const due = this.store.db.prepare('SELECT * FROM reminders WHERE fired_at IS NULL AND due_at <= ? ORDER BY due_at').all(now) as unknown as ReminderRow[];
    const woken: Wake[] = [];
    for (const row of due) {
      this.store.db.prepare('UPDATE reminders SET fired_at = ? WHERE id = ?').run(now, row.id);
      const task = this.store.tasks.find(row.task_id);
      const agent = this.store.participantById(row.agent_id);
      if (!task || !agent || !OPEN_STATES.includes(task.state) || task.assignee !== agent.name) continue;
      this.store.post(agent, task.room, `Reminder for task #${task.id}: ${row.note}`, task.messageId, { skipRateLimit: true });
      const wake: Wake = { reminderId: row.id, taskId: task.id, agentId: agent.id, agent: agent.name, note: row.note };
      this.store.events.emit('wake', wake);
      woken.push(wake);
    }
    return woken;
  }

  private byId(id: number): Reminder | null {
    const row = this.store.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as ReminderRow | undefined;
    return row ? toReminder(row) : null;
  }
}
