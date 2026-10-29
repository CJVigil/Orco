import { isText } from './attachments.js';
import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

export const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES_PER_PROJECT = 500;
const MAX_NOTE = 300;
const PATH = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63}){0,4}$/i;

export interface ProjectFile {
  path: string;
  version: number;
  size: number;
  updatedBy: string;
  updatedAt: string;
  createdBy: string;
}

export interface FileVersion {
  version: number;
  size: number;
  author: string;
  note: string;
  at: string;
}

export interface FileContent extends ProjectFile {
  content: string;
  note: string;
}

/**
 * Text files a project keeps, versioned: a design doc, a runbook, a generated report. Anyone in the
 * project reads and writes them; writes name the version they started from, so two writers cannot
 * silently overwrite each other. Only people delete files.
 */
export class Files {
  constructor(private readonly store: Store) {}

  list(actor: Participant, project: string, prefix = ''): ProjectFile[] {
    const proj = this.store.visibleProject(actor, project);
    const rows = this.store.db
      .prepare(
        `SELECT f.path, v.version, v.size, a.name AS updated_by, v.created_at AS updated_at, c.name AS created_by
         FROM files f
         JOIN file_versions v ON v.file_id = f.id AND v.version = (SELECT max(version) FROM file_versions WHERE file_id = f.id)
         JOIN participants a ON a.id = v.author_id JOIN participants c ON c.id = f.created_by
         WHERE f.project_id = ? AND f.path LIKE ? ESCAPE '\\' ORDER BY f.path`,
      )
      .all(proj.id, `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`) as unknown as {
      path: string;
      version: number;
      size: number;
      updated_by: string;
      updated_at: string;
      created_by: string;
    }[];
    return rows.map((r) => ({ path: r.path, version: r.version, size: r.size, updatedBy: r.updated_by, updatedAt: r.updated_at, createdBy: r.created_by }));
  }

  read(actor: Participant, project: string, path: string, version?: number): FileContent {
    const proj = this.store.visibleProject(actor, project);
    const file = this.file(proj.id, path);
    const row = this.store.db
      .prepare(
        `SELECT v.version, v.content, v.size, v.note, v.created_at, a.name AS author FROM file_versions v JOIN participants a ON a.id = v.author_id
         WHERE v.file_id = ? AND v.version = coalesce(?, (SELECT max(version) FROM file_versions WHERE file_id = ?))`,
      )
      .get(file.id, version ?? null, file.id) as { version: number; content: string; size: number; note: string; created_at: string; author: string } | undefined;
    if (!row) throw new OrcoError('not_found', `${path} has no version ${version}`);
    return { path: file.path, version: row.version, size: row.size, updatedBy: row.author, updatedAt: row.created_at, createdBy: file.created_by, content: row.content, note: row.note };
  }

  history(actor: Participant, project: string, path: string): FileVersion[] {
    const proj = this.store.visibleProject(actor, project);
    const file = this.file(proj.id, path);
    const rows = this.store.db
      .prepare('SELECT v.version, v.size, v.note, v.created_at, a.name AS author FROM file_versions v JOIN participants a ON a.id = v.author_id WHERE v.file_id = ? ORDER BY v.version DESC')
      .all(file.id) as unknown as { version: number; size: number; note: string; created_at: string; author: string }[];
    return rows.map((r) => ({ version: r.version, size: r.size, author: r.author, note: r.note, at: r.created_at }));
  }

  /**
   * Writes a new version. `baseVersion` is the version the writer started from (0 or omitted for a
   * new file); if someone else wrote in between, the write is refused so the writer can merge.
   */
  write(actor: Participant, project: string, path: string, content: string, options: { baseVersion?: number; note?: string } = {}): ProjectFile {
    const proj = this.store.writableProject(actor, project);
    const clean = this.path(path);
    const data = Buffer.from(content, 'utf8');
    if (data.length > MAX_FILE_BYTES) throw new OrcoError('invalid', `Files are at most ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    if (data.length && !isText(data)) throw new OrcoError('invalid', 'Files are plain text: no binary data, HTML or SVG');
    const note = (options.note ?? '').trim().slice(0, MAX_NOTE);
    this.store.checkRate(actor, 'post');
    const existing = this.store.db.prepare('SELECT id FROM files WHERE project_id = ? AND path = ?').get(proj.id, clean) as { id: number } | undefined;
    const latest = existing
      ? (this.store.db.prepare('SELECT max(version) AS v FROM file_versions WHERE file_id = ?').get(existing.id) as { v: number }).v
      : 0;
    if (options.baseVersion !== undefined && options.baseVersion !== latest) {
      throw new OrcoError('conflict', `${clean} is at version ${latest} now, not ${options.baseVersion}; read it again and merge your change`);
    }
    if (existing && options.baseVersion === undefined) {
      throw new OrcoError('conflict', `${clean} exists (version ${latest}); pass base_version ${latest} to replace it`);
    }
    this.store.begin();
    try {
      let fileId = existing?.id;
      if (!fileId) {
        const count = (this.store.db.prepare('SELECT count(*) AS n FROM files WHERE project_id = ?').get(proj.id) as { n: number }).n;
        if (count >= MAX_FILES_PER_PROJECT) throw new OrcoError('conflict', `${project} has ${MAX_FILES_PER_PROJECT} files already`);
        fileId = Number(this.store.db.prepare('INSERT INTO files (project_id, path, created_by) VALUES (?, ?, ?)').run(proj.id, clean, actor.id).lastInsertRowid);
      }
      this.store.db
        .prepare('INSERT INTO file_versions (file_id, version, content, size, author_id, note) VALUES (?, ?, ?, ?, ?, ?)')
        .run(fileId, latest + 1, content, data.length, actor.id, note);
      this.store.commit();
    } catch (err) {
      this.store.rollback();
      throw err;
    }
    this.store.audit.record(actor, 'file.write', { projectId: proj.id, subject: `file:${project}/${clean}`, detail: { version: latest + 1, size: data.length, note } });
    this.store.events.emit('files', { projectId: proj.id, path: clean });
    return this.list(actor, project).find((f) => f.path === clean)!;
  }

  delete(actor: Participant, project: string, path: string): void {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people delete files');
    const proj = this.store.visibleProject(actor, project);
    const file = this.file(proj.id, path);
    this.store.db.prepare('DELETE FROM file_versions WHERE file_id = ?').run(file.id);
    this.store.db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
    this.store.audit.record(actor, 'file.delete', { projectId: proj.id, subject: `file:${project}/${file.path}` });
    this.store.events.emit('files', { projectId: proj.id, path: file.path });
  }

  private file(projectId: number, path: string): { id: number; path: string; created_by: string } {
    const row = this.store.db
      .prepare('SELECT f.id, f.path, c.name AS created_by FROM files f JOIN participants c ON c.id = f.created_by WHERE f.project_id = ? AND f.path = ?')
      .get(projectId, this.path(path)) as { id: number; path: string; created_by: string } | undefined;
    if (!row) throw new OrcoError('not_found', `No file ${path}`);
    return row;
  }

  private path(raw: string): string {
    const path = raw.trim().replace(/^\/+/, '');
    if (!PATH.test(path) || path.split('/').some((part) => part === '.' || part === '..' || /^\.+$/.test(part))) {
      throw new OrcoError('invalid', 'Paths are up to 5 folders deep, made of letters, digits, dots, dashes and underscores, like docs/design.md');
    }
    return path;
  }
}
