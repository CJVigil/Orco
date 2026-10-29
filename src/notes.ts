import { OrcoError } from './errors.js';
import type { Participant, Project, Store } from './store.js';

export interface Note {
  id: number;
  project: string;
  projectId: number;
  title: string;
  body: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

interface NoteRow {
  id: number;
  project_id: number;
  project: string;
  title: string;
  body: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

const NOTE_SELECT = `
  SELECT n.id, n.project_id, p.name AS project, n.title, n.body, c.name AS created_by, u.name AS updated_by,
         n.created_at, n.updated_at
  FROM notes n
  JOIN projects p ON p.id = n.project_id
  JOIN participants c ON c.id = n.created_by
  JOIN participants u ON u.id = n.updated_by
`;

const MAX_TITLE = 80;
const MAX_BODY = 8_000;
const MAX_NOTES = 100;

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    project: row.project,
    projectId: row.project_id,
    title: row.title,
    body: row.body,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Project notes: the short, durable facts every session would otherwise relearn (how to deploy,
 * what not to touch). Anyone in the project can write and edit them; only people delete them.
 */
export class Notes {
  constructor(private readonly store: Store) {}

  list(actor: Participant, project: string): Note[] {
    const proj = this.store.visibleProject(actor, project);
    const rows = this.store.db.prepare(`${NOTE_SELECT} WHERE n.project_id = ? ORDER BY n.title`).all(proj.id) as unknown as NoteRow[];
    return rows.map(toNote);
  }

  /** Creates a note, or replaces the one with this id (or, without an id, the one with this title). */
  save(actor: Participant, project: string, input: { id?: number; title: string; body: string }): Note {
    const proj = this.store.writableProject(actor, project);
    const title = input.title.trim().replace(/\s+/g, ' ');
    const body = input.body.trim();
    if (!title || title.length > MAX_TITLE) throw new OrcoError('invalid', `Note titles are 1-${MAX_TITLE} characters`);
    if (!body) throw new OrcoError('invalid', 'The note is empty');
    if (body.length > MAX_BODY) throw new OrcoError('invalid', `Notes can be at most ${MAX_BODY} characters`);
    this.store.checkRate(actor, 'post');
    const existing = input.id !== undefined ? this.row(proj, input.id) : this.byTitle(proj, title);
    if (input.id !== undefined && !existing) throw new OrcoError('not_found', `No note ${input.id} in ${proj.name}`);
    let id: number;
    try {
      if (existing) {
        // Matched by title, the note keeps its title as written; matched by id, it can be renamed.
        const newTitle = input.id !== undefined ? title : existing.title;
        this.store.db
          .prepare("UPDATE notes SET title = ?, body = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
          .run(newTitle, body, actor.id, existing.id);
        id = existing.id;
      } else {
        const count = this.store.db.prepare('SELECT count(*) AS n FROM notes WHERE project_id = ?').get(proj.id) as { n: number };
        if (count.n >= MAX_NOTES) throw new OrcoError('invalid', `A project can keep at most ${MAX_NOTES} notes; merge or delete some`);
        const { lastInsertRowid } = this.store.db
          .prepare('INSERT INTO notes (project_id, title, body, created_by, updated_by) VALUES (?, ?, ?, ?, ?)')
          .run(proj.id, title, body, actor.id, actor.id);
        id = Number(lastInsertRowid);
      }
    } catch (err) {
      if (err instanceof Error && /UNIQUE/.test(err.message)) throw new OrcoError('conflict', `There is already a note called ${title}`);
      throw err;
    }
    this.store.audit.record(actor, existing ? 'note.update' : 'note.create', {
      projectId: proj.id,
      subject: `note:${id}`,
      detail: { title, body, previous: existing ? { title: existing.title, body: existing.body } : undefined },
    });
    this.store.events.emit('notes', { projectId: proj.id });
    return this.row(proj, id)!;
  }

  delete(actor: Participant, project: string, id: number): void {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people can delete notes');
    const proj = this.store.writableProject(actor, project);
    const note = this.row(proj, id);
    if (!note) throw new OrcoError('not_found', `No note ${id} in ${proj.name}`);
    this.store.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    this.store.audit.record(actor, 'note.delete', { projectId: proj.id, subject: `note:${id}`, detail: { title: note.title, body: note.body } });
    this.store.events.emit('notes', { projectId: proj.id });
  }

  private row(project: Project, id: number): Note | null {
    const row = this.store.db.prepare(`${NOTE_SELECT} WHERE n.id = ? AND n.project_id = ?`).get(id, project.id) as NoteRow | undefined;
    return row ? toNote(row) : null;
  }

  private byTitle(project: Project, title: string): Note | null {
    const row = this.store.db.prepare(`${NOTE_SELECT} WHERE n.project_id = ? AND n.title = ?`).get(project.id, title) as NoteRow | undefined;
    return row ? toNote(row) : null;
  }
}
