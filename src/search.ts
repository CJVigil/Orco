import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

export const SEARCH_KINDS = ['message', 'ticket', 'note', 'task', 'file'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export interface SearchHit {
  kind: SearchKind;
  /** Message id, ticket ref, note id, task id, or a project file's path. */
  ref: string;
  title: string;
  snippet: string;
  room: string | null;
  project: string | null;
  /** For messages: the thread to open (the message itself when it starts one). */
  threadId: number | null;
  by: string | null;
  at: string;
  /** How well it matched (#141): higher is better. */
  score?: number;
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
function loadHits(
  store: Store,
  actor: Participant,
  query: string,
  options: { project?: string; kinds?: SearchKind[]; limit?: number } = {},
  /** Restrict each kind to these ids (from the full-text index), instead of matching every word. */
  ids?: Map<SearchKind, number[]>,
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
  const match = (columns: string[], kind?: SearchKind, idColumn?: string) => {
    const only = kind && ids ? ids.get(kind) ?? [] : null;
    if (only) return { sql: only.length ? `${idColumn} IN (${only.map(() => '?').join(', ')})` : '0', params: only };
    return {
      sql: terms.map(() => `(${columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`).join(' AND '),
      params: terms.flatMap((t) => columns.map(() => escapeLike(t))),
    };
  };
  const scope = (column: string, allowServer: boolean) => {
    if (project) return { sql: `${column} = ?`, params: [project.id] };
    const visible = store.projectFilter(actor, column);
    return allowServer ? { sql: `(${column} IS NULL OR ${visible.sql})`, params: visible.params } : visible;
  };
  const hits: SearchHit[] = [];

  if (kinds.has('message')) {
    const m = match(['m.text', 'm.external_text'], 'message', 'm.id');
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
    const m = match(['t.title', 't.description', 't.handoff', "coalesce((SELECT group_concat(body, ' ') FROM ticket_activity WHERE ticket_id = t.id AND kind = 'comment'), '')"], 'ticket', 't.id');
    const v = scope('t.project_id', false);
    const hidden = store.tickets.privateFilter(actor);
    const rows = store.db
      .prepare(
        `SELECT p.ticket_key || '-' || t.number AS ref, t.title, t.description, t.handoff, p.name AS project, t.updated_at,
                coalesce((SELECT group_concat(body, ' ') FROM ticket_activity WHERE ticket_id = t.id AND kind = 'comment'), '') AS comments
         FROM tickets t JOIN projects p ON p.id = t.project_id
         WHERE ${m.sql} AND ${v.sql} AND ${hidden.sql} ORDER BY t.updated_at DESC LIMIT ?`,
      )
      .all(...m.params, ...v.params, ...hidden.params, limit) as unknown as {
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
    const m = match(['n.title', 'n.body'], 'note', 'n.id');
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
    const m = match(['t.request', "coalesce(t.note, '')"], 'task', 't.id');
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

  if (kinds.has('file')) {
    const m = match(['f.path', 'v.content'], 'file', 'f.id');
    const v = scope('f.project_id', false);
    const rows = store.db
      .prepare(
        `SELECT f.id, f.path, v.content, v.created_at, p.name AS project, a.name AS author
         FROM files f JOIN projects p ON p.id = f.project_id
         JOIN file_versions v ON v.file_id = f.id AND v.version = (SELECT max(version) FROM file_versions WHERE file_id = f.id)
         JOIN participants a ON a.id = v.author_id
         WHERE ${m.sql} AND ${v.sql} ORDER BY v.created_at DESC LIMIT ?`,
      )
      .all(...m.params, ...v.params, limit) as unknown as { id: number; path: string; content: string; created_at: string; project: string; author: string }[];
    for (const row of rows) {
      hits.push({ kind: 'file', ref: row.path, title: row.path, snippet: snippet(row.content, terms), room: null, project: row.project, threadId: null, by: row.author, at: row.created_at });
    }
  }

  return hits;
}

/* Ranked search (#141) */

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** True when a and b differ by at most one letter (substitution, insertion, deletion or swap). */
export function oneEditApart(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** How well one term matches: a whole word beats a prefix beats a substring beats one typo. Title counts more. */
function termScore(term: string, titleWords: string[], bodyWords: string[], text: string): number {
  const t = term.toLowerCase();
  if (titleWords.includes(t)) return 6;
  if (bodyWords.includes(t)) return 4;
  if (titleWords.some((w) => w.startsWith(t))) return 3.5;
  if (bodyWords.some((w) => w.startsWith(t))) return 3;
  if (text.includes(t)) return 2;
  if (t.length >= 4) {
    if (titleWords.some((w) => oneEditApart(w, t))) return 2;
    if (bodyWords.some((w) => w.length >= 4 && oneEditApart(w, t))) return 1.5;
  }
  return 0;
}

export function scoreHit(hit: SearchHit, terms: string[], query: string, body: string): number {
  const title = hit.title.toLowerCase();
  const titleWords = words(hit.title);
  const all = `${hit.title} ${body}`.toLowerCase();
  const bodyWords = words(body);
  let total = 0;
  for (const term of terms) {
    const s = termScore(term, titleWords, bodyWords, all);
    if (s === 0) return 0;
    total += s;
  }
  if (hit.kind === 'ticket' && hit.ref.toLowerCase() === query.toLowerCase()) total += 100;
  if (title.includes(query.toLowerCase())) total += 5;
  return total;
}

/** The FTS query for the terms: each term's trigrams, OR'd, so one wrong letter still shares most of them. */
function ftsQuery(terms: string[]): string {
  const grams = new Set<string>();
  for (const term of terms) {
    const t = term.toLowerCase();
    if (t.length <= 3) grams.add(t);
    else for (let i = 0; i + 3 <= t.length; i++) grams.add(t.slice(i, i + 3));
  }
  return [...grams].map((g) => `"${g.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * Searches what an actor can see: messages (including relayed external text), tickets (title,
 * description, handoff and comments), project notes, task requests and results, and project files
 * at their newest version. Ranked (#141): an exact ticket ref first, then whole words, prefixes and
 * one-letter typos, title above body, newer first among equals. Every word must match in one of
 * those ways. Terms under three letters fall back to plain matching.
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
  const terms = [...new Set(words(q))].slice(0, MAX_TERMS);
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const kinds = new Set(options.kinds?.length ? options.kinds : SEARCH_KINDS);
  for (const kind of kinds) if (!SEARCH_KINDS.includes(kind)) throw new OrcoError('invalid', `Search kinds are ${SEARCH_KINDS.join(', ')}`);
  if (!terms.length || terms.every((t) => t.length < 3)) {
    return loadHits(store, actor, q, options).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }
  const candidates = store.db
    .prepare('SELECT kind, key FROM search_fts WHERE search_fts MATCH ? ORDER BY bm25(search_fts) LIMIT 500')
    .all(ftsQuery(terms.filter((t) => t.length >= 3))) as { kind: SearchKind; key: number }[];
  const ids = new Map<SearchKind, number[]>();
  for (const c of candidates) {
    if (!kinds.has(c.kind)) continue;
    const list = ids.get(c.kind) ?? [];
    if (!list.includes(Number(c.key))) list.push(Number(c.key));
    ids.set(c.kind, list);
  }
  // A ticket ref typed in full is found whatever the index says.
  const ref = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(q);
  if (ref && kinds.has('ticket')) {
    const row = store.db.prepare('SELECT t.id FROM tickets t JOIN projects p ON p.id = t.project_id WHERE p.ticket_key = ? AND t.number = ?').get(ref[1]!.toUpperCase(), Number(ref[2])) as { id: number } | undefined;
    if (row) ids.set('ticket', [...new Set([row.id, ...(ids.get('ticket') ?? [])])]);
  }
  const loaded = loadHits(store, actor, q, { ...options, limit: 100 }, ids);
  const bodies = new Map(loaded.map((h) => [h, bodyOf(store, h)]));
  return loaded
    .map((h) => ({ ...h, score: scoreHit(h, terms, q, bodies.get(h) ?? h.snippet) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || b.at.localeCompare(a.at))
    .slice(0, limit);
}

/** The full text a hit was found in, for scoring (the snippet is only an excerpt). */
function bodyOf(store: Store, hit: SearchHit): string {
  const get = (sql: string, ...p: (string | number)[]) => (store.db.prepare(sql).get(...p) as { body: string | null } | undefined)?.body ?? '';
  switch (hit.kind) {
    case 'message':
      return get("SELECT text || ' ' || coalesce(external_text, '') AS body FROM messages WHERE id = ?", Number(hit.ref));
    case 'ticket': {
      const m = /^([A-Za-z0-9]+)-(\d+)$/.exec(hit.ref);
      if (!m) return hit.snippet;
      return get(
        `SELECT t.description || ' ' || t.handoff || ' ' || coalesce((SELECT group_concat(body, ' ') FROM ticket_activity WHERE ticket_id = t.id AND kind = 'comment'), '') AS body
         FROM tickets t JOIN projects p ON p.id = t.project_id WHERE p.ticket_key = ? AND t.number = ?`,
        m[1]!,
        Number(m[2]),
      );
    }
    case 'note':
      return get('SELECT body FROM notes WHERE id = ?', Number(hit.ref));
    case 'task':
      return get("SELECT request || ' ' || coalesce(note, '') AS body FROM tasks WHERE id = ?", Number(hit.ref));
    case 'file':
      return hit.snippet.length < 160 ? hit.snippet : get(
        `SELECT v.content AS body FROM files f JOIN projects p ON p.id = f.project_id JOIN file_versions v ON v.file_id = f.id
         WHERE f.path = ? AND p.name = ? ORDER BY v.version DESC LIMIT 1`,
        hit.ref,
        hit.project ?? '',
      );
  }
}
