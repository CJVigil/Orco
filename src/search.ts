import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

export const SEARCH_KINDS = ['message', 'ticket', 'note', 'task'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export interface SearchHit {
  kind: SearchKind;
  /** Message id, ticket ref, note id or task id. */
  ref: string;
  title: string;
  snippet: string;
  room: string | null;
  project: string | null;
  /** For messages: the thread to open (the message itself when it starts one). */
  threadId: number | null;
  by: string | null;
  at: string;
}

const MAX_TERMS = 8;
const SNIPPET = 160;

function escapeLike(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** A short excerpt around the first matching term, on one line. */
function snippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0), flat.length);
  const start = at === flat.length ? 0 : Math.max(0, at - SNIPPET / 3);
  const piece = flat.slice(start, start + SNIPPET);
  return `${start > 0 ? '…' : ''}${piece}${start + SNIPPET < flat.length ? '…' : ''}`;
}

/**
 * Searches what an actor can see: messages (including relayed external text), tickets (title,
 * description, handoff and comments), project notes, and task requests and results. Every word must
 * appear; newest first.
 */
export function searchAll(
  store: Store,
  actor: Participant,
  query: string,
  options: { project?: string; kinds?: SearchKind[]; limit?: number } = {},
): SearchHit[] {
  const q = query.trim();
  if (q.length < 2) throw new OrcoError('invalid', 'Search for at least 2 characters');
  if (q.length > 200) throw new OrcoError('invalid', 'That search is too long');
  const terms = [...new Set(q.split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS);
  const kinds = new Set(options.kinds?.length ? options.kinds : SEARCH_KINDS);
  for (const kind of kinds) if (!SEARCH_KINDS.includes(kind)) throw new OrcoError('invalid', `Search kinds are ${SEARCH_KINDS.join(', ')}`);
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const project = options.project ? store.visibleProject(actor, options.project) : null;

  /** `(col LIKE ? OR col2 LIKE ?) AND ...` for every term, with its parameters. */
  const match = (columns: string[]) => ({
    sql: terms.map(() => `(${columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`).join(' AND '),
    params: terms.flatMap((t) => columns.map(() => escapeLike(t))),
  });
  const scope = (column: string, allowServer: boolean) => {
    if (project) return { sql: `${column} = ?`, params: [project.id] };
    const visible = store.projectFilter(actor, column);
    return allowServer ? { sql: `(${column} IS NULL OR ${visible.sql})`, params: visible.params } : visible;
  };
  const hits: SearchHit[] = [];

  if (kinds.has('message')) {
    const m = match(['m.text', 'm.external_text']);
    const v = scope('r.project_id', true);
    const rows = store.db
      .prepare(
        `SELECT m.id, m.thread_id, m.text, m.external_text, m.created_at, a.name AS author, r.name AS room, p.name AS project
         FROM messages m JOIN rooms r ON r.id = m.room_id LEFT JOIN projects p ON p.id = r.project_id
         JOIN participants a ON a.id = m.author_id
         WHERE ${m.sql} AND ${v.sql} ORDER BY m.id DESC LIMIT ?`,
      )
      .all(...m.params, ...v.params, limit) as unknown as {
      id: number;
      thread_id: number | null;
      text: string;
      external_text: string | null;
      created_at: string;
      author: string;
      room: string;
      project: string | null;
    }[];
    for (const row of rows) {
      const room = row.project ? `${row.project}/${row.room}` : row.room;
      const text = terms.every((t) => row.text.toLowerCase().includes(t.toLowerCase())) ? row.text : `${row.text} ${row.external_text ?? ''}`;
      hits.push({ kind: 'message', ref: String(row.id), title: `${row.author} in #${room}`, snippet: snippet(text, terms), room, project: row.project, threadId: row.thread_id ?? row.id, by: row.author, at: row.created_at });
    }
  }

  if (kinds.has('ticket')) {
    const m = match(['t.title', 't.description', 't.handoff', "coalesce((SELECT group_concat(body, ' ') FROM ticket_activity WHERE ticket_id = t.id AND kind = 'comment'), '')"]);
    const v = scope('t.project_id', false);
    const rows = store.db
      .prepare(
        `SELECT p.ticket_key || '-' || t.number AS ref, t.title, t.description, t.handoff, p.name AS project, t.updated_at,
                coalesce((SELECT group_concat(body, ' ') FROM ticket_activity WHERE ticket_id = t.id AND kind = 'comment'), '') AS comments
         FROM tickets t JOIN projects p ON p.id = t.project_id
         WHERE ${m.sql} AND ${v.sql} ORDER BY t.updated_at DESC LIMIT ?`,
      )
      .all(...m.params, ...v.params, limit) as unknown as {
      ref: string;
      title: string;
      description: string;
      handoff: string;
      project: string;
      updated_at: string;
      comments: string;
    }[];
    for (const row of rows) {
      const body = [row.description, row.handoff, row.comments].filter(Boolean).join(' ');
      hits.push({ kind: 'ticket', ref: row.ref, title: `${row.ref} ${row.title}`, snippet: snippet(body || row.title, terms), room: null, project: row.project, threadId: null, by: null, at: row.updated_at });
    }
  }

  if (kinds.has('note')) {
    const m = match(['n.title', 'n.body']);
    const v = scope('n.project_id', false);
    const rows = store.db
      .prepare(
        `SELECT n.id, n.title, n.body, n.updated_at, p.name AS project, u.name AS updated_by
         FROM notes n JOIN projects p ON p.id = n.project_id JOIN participants u ON u.id = n.updated_by
         WHERE ${m.sql} AND ${v.sql} ORDER BY n.updated_at DESC LIMIT ?`,
      )
      .all(...m.params, ...v.params, limit) as unknown as { id: number; title: string; body: string; updated_at: string; project: string; updated_by: string }[];
    for (const row of rows) {
      hits.push({ kind: 'note', ref: String(row.id), title: row.title, snippet: snippet(row.body, terms), room: null, project: row.project, threadId: null, by: row.updated_by, at: row.updated_at });
    }
  }

  if (kinds.has('task')) {
    const m = match(['t.request', "coalesce(t.note, '')"]);
    const v = scope('r.project_id', true);
    const rows = store.db
      .prepare(
        `SELECT t.id, t.message_id, t.request, t.note, t.state, t.updated_at, a.name AS assignee, r.name AS room, p.name AS project
         FROM tasks t JOIN rooms r ON r.id = t.room_id LEFT JOIN projects p ON p.id = r.project_id
         JOIN participants a ON a.id = t.assignee_id
         WHERE ${m.sql} AND ${v.sql} ORDER BY t.id DESC LIMIT ?`,
      )
      .all(...m.params, ...v.params, limit) as unknown as {
      id: number;
      message_id: number;
      request: string;
      note: string | null;
      state: string;
      updated_at: string;
      assignee: string;
      room: string;
      project: string | null;
    }[];
    for (const row of rows) {
      const room = row.project ? `${row.project}/${row.room}` : row.room;
      hits.push({
        kind: 'task',
        ref: String(row.id),
        title: `#${row.id} for ${row.assignee} (${row.state})`,
        snippet: snippet(`${row.request} ${row.note ?? ''}`, terms),
        room,
        project: row.project,
        threadId: row.message_id,
        by: row.assignee,
        at: row.updated_at,
      });
    }
  }

  return hits.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
