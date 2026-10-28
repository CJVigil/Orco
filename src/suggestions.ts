import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';
import type { Ticket } from './tickets.js';
import type { TaskFollowup } from './tasks.js';

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4_000;

export interface Suggestion {
  id: number;
  taskId: number;
  project: string;
  author: string;
  title: string;
  description: string;
  state: 'open' | 'accepted' | 'dismissed';
  ticket: string | null;
  decidedBy: string | null;
  createdAt: string;
}

interface SuggestionRow {
  id: number;
  task_id: number;
  project_id: number;
  project: string;
  author: string;
  title: string;
  description: string;
  state: Suggestion['state'];
  ticket: string | null;
  decided_by: string | null;
  created_at: string;
}

const SELECT = `
  SELECT s.id, s.task_id, s.project_id, p.name AS project, a.name AS author, s.title, s.description, s.state,
         CASE WHEN tk.id IS NULL THEN NULL ELSE p.ticket_key || '-' || tk.number END AS ticket,
         d.name AS decided_by, s.created_at
  FROM suggestions s
  JOIN projects p ON p.id = s.project_id
  JOIN participants a ON a.id = s.author_id
  LEFT JOIN tickets tk ON tk.id = s.ticket_id
  LEFT JOIN participants d ON d.id = s.decided_by
`;

function toSuggestion(row: SuggestionRow): Suggestion {
  return {
    id: row.id,
    taskId: row.task_id,
    project: row.project,
    author: row.author,
    title: row.title,
    description: row.description,
    state: row.state,
    ticket: row.ticket,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
  };
}

/**
 * Follow-up work an agent noticed while finishing a task. It does not file tickets on its own; a
 * person turns each suggestion into a ticket or dismisses it.
 */
export class Suggestions {
  constructor(private readonly store: Store) {}

  check(input: { title: string; description?: string }): void {
    const title = input.title.trim();
    if (!title) throw new OrcoError('invalid', 'A follow-up needs a title');
    if (title.length > MAX_TITLE) throw new OrcoError('invalid', `Follow-up titles are at most ${MAX_TITLE} characters`);
    if ((input.description ?? '').length > MAX_DESCRIPTION) throw new OrcoError('invalid', `Follow-up descriptions are at most ${MAX_DESCRIPTION} characters`);
  }

  /** Records a suggestion; if the agent's owner lets it, files it as a ticket straight away. */
  create(actor: Participant, taskId: number, projectId: number, input: { title: string; description?: string }): void {
    this.check(input);
    const title = input.title.trim().replace(/\s+/g, ' ');
    const description = (input.description ?? '').trim();
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO suggestions (task_id, project_id, author_id, title, description) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, projectId, actor.id, title, description);
    const id = Number(lastInsertRowid);
    this.store.audit.record(actor, 'suggestion.create', { projectId, subject: `suggestion:${id}`, detail: { taskId, title } });
    if (actor.kind === 'agent' && this.store.autoFilesFollowups(actor)) {
      const project = (this.store.db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string }).name;
      const footer = `Filed by ${actor.name} while working task #${taskId}.`;
      // Bounded (ten follow-ups at most) and part of one task update, so it counts once.
      const { ticket } = this.store.withoutRateLimit(() =>
        this.store.tickets.create(actor, project, { title, description: description ? `${description}\n\n${footer}` : footer }),
      );
      this.store.db
        .prepare("UPDATE suggestions SET state = 'accepted', ticket_id = ?, decided_by = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
        .run(ticket.id, actor.id, id);
      this.store.audit.record(actor, 'suggestion.accept', { projectId, subject: `suggestion:${id}`, detail: { taskId, ticket: ticket.ref, auto: true } });
    }
    this.store.events.emit('suggestion', { projectId });
  }

  forTask(taskId: number): TaskFollowup[] {
    const rows = this.store.db.prepare(`${SELECT} WHERE s.task_id = ? ORDER BY s.id`).all(taskId) as unknown as SuggestionRow[];
    return rows.map((row) => ({ id: row.id, title: row.title, state: row.state, ticket: row.ticket }));
  }

  /** Open suggestions from tasks this person asked for, or that their agents worked. */
  pendingFor(actor: Participant): Suggestion[] {
    if (actor.kind !== 'user') return [];
    const rows = this.store.db
      .prepare(
        `${SELECT}
         JOIN tasks t ON t.id = s.task_id
         JOIN participants rq ON rq.id = t.requester_id
         JOIN participants ag ON ag.id = t.assignee_id
         WHERE s.state = 'open' AND (rq.id = ? OR rq.owner_id = ? OR ag.owner_id = ?)
         ORDER BY s.id`,
      )
      .all(actor.id, actor.id, actor.id) as unknown as SuggestionRow[];
    return rows.filter((row) => this.store.canSee(actor, row.project_id)).map(toSuggestion);
  }

  /** Files the suggestion as a ticket, optionally edited first. People only. */
  accept(actor: Participant, id: number, edits: { title?: string; description?: string } = {}): { suggestion: Suggestion; ticket: Ticket } {
    const row = this.open(actor, id);
    const title = edits.title?.trim() || row.title;
    const description = edits.description ?? row.description;
    const footer = `Suggested by ${row.author} while working task #${row.task_id}.`;
    const { ticket } = this.store.tickets.create(actor, row.project, { title, description: description ? `${description}\n\n${footer}` : footer });
    this.store.db
      .prepare("UPDATE suggestions SET state = 'accepted', ticket_id = ?, decided_by = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(ticket.id, actor.id, id);
    this.decided(actor, row, 'accepted', ticket.ref);
    return { suggestion: this.get(id), ticket };
  }

  dismiss(actor: Participant, id: number): Suggestion {
    const row = this.open(actor, id);
    this.store.db
      .prepare("UPDATE suggestions SET state = 'dismissed', decided_by = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(actor.id, id);
    this.decided(actor, row, 'dismissed', null);
    return this.get(id);
  }

  private decided(actor: Participant, row: SuggestionRow, state: string, ticket: string | null): void {
    this.store.audit.record(actor, `suggestion.${state === 'accepted' ? 'accept' : 'dismiss'}`, {
      projectId: row.project_id,
      subject: `suggestion:${row.id}`,
      detail: { taskId: row.task_id, ...(ticket ? { ticket } : {}) },
    });
    this.store.events.emit('suggestion', { projectId: row.project_id });
    const task = this.store.tasks.find(row.task_id);
    if (task) this.store.events.emit('task', task);
  }

  private open(actor: Participant, id: number): SuggestionRow {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people turn suggestions into tickets');
    const row = this.store.db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as SuggestionRow | undefined;
    if (!row || !this.store.canSee(actor, row.project_id)) throw new OrcoError('not_found', `No suggestion ${id}`);
    if (row.state !== 'open') throw new OrcoError('conflict', `Suggestion ${id} was already ${row.state}`);
    return row;
  }

  private get(id: number): Suggestion {
    return toSuggestion(this.store.db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as unknown as SuggestionRow);
  }
}
