import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/*
 * The agent journal and the shared papercuts log (#146).
 *
 * Journal: one append-only timeline per agent of what it did and decided. Every tool call that
 * changes something is written automatically (see buildMcpServer), so it does not depend on the agent
 * remembering; the journal tool adds decisions and lessons with their why. Searchable by agent,
 * project, ticket, resource and time window, for incident review and audit, with a daily digest.
 *
 * Papercuts: shared "tried it, didn't work" entries in a fixed format: Symptom (the exact error) /
 * Cause / Fix / (who, date). Never deleted; corrected in place with "CORRECTED <date>:". The same
 * symptom is not logged twice. A papercut that keeps coming up can be proposed as an org note (#144).
 * Unlike org memory, none of this loads into context; agents read it when it is relevant.
 */
export type JournalKind = 'action' | 'decision' | 'lesson';

export interface JournalEntry {
  id: number;
  agent: string;
  at: string;
  kind: JournalKind;
  tool: string | null;
  summary: string;
  why: string | null;
  resource: string | null;
  ticket: string | null;
  link: string | null;
  project: string | null;
}

export interface Papercut {
  id: number;
  symptom: string;
  cause: string;
  fix: string;
  author: string;
  created: string;
  corrections: string[];
  /** The four lines as they are shared. */
  text: string;
}

const MAX_SUMMARY = 300;
const MAX_FIELD = 2000;
const REF = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;

const one = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const day = (iso: string) => iso.slice(0, 10);

/** A symptom reduced to what identifies it: lower case, numbers, ids and paths blurred. */
export function normalizeSymptom(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, '#')
    .replace(/\d+/g, '#')
    .replace(/(\/[\w.-]+)+/g, '/…')
    .replace(/[^\p{L}\p{N}#/…]+/gu, ' ')
    .trim();
}

const words = (text: string) => new Set(normalizeSymptom(text).split(' ').filter((w) => w.length > 1));

/** Overlap of two symptoms, 0..1 (Jaccard on words). */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

interface EntryRow {
  id: number;
  agent: string;
  at: string;
  kind: JournalKind;
  tool: string | null;
  summary: string;
  why: string | null;
  resource: string | null;
  ticket: string | null;
  link: string | null;
  project: string | null;
  project_id: number | null;
  agent_owner_id: number | null;
  agent_id: number;
}

const ENTRY_SELECT = `
  SELECT j.id, a.name AS agent, a.id AS agent_id, a.owner_id AS agent_owner_id, j.at, j.kind, j.tool, j.summary, j.why, j.resource,
         j.ticket, j.link, p.name AS project, j.project_id
  FROM journal j JOIN participants a ON a.id = j.agent_id LEFT JOIN projects p ON p.id = j.project_id
`;

export class Journal {
  constructor(private readonly store: Store) {}

  private toEntry(r: EntryRow): JournalEntry {
    return { id: r.id, agent: r.agent, at: r.at, kind: r.kind, tool: r.tool, summary: r.summary, why: r.why, resource: r.resource, ticket: r.ticket, link: r.link, project: r.project };
  }

  /** Who may read an entry: anyone who can see its project; for entries without one, the agent and its owner. */
  private visible(actor: Participant, r: EntryRow): boolean {
    if (r.project_id !== null) return this.store.canSee(actor, r.project_id);
    return actor.id === r.agent_id || actor.id === r.agent_owner_id || this.store.isOrgAdmin(actor);
  }

  private projectIdOf(actor: Participant, input: { project?: string | null; ticket?: string | null; room?: string | null }): number | null {
    const tries: (() => number | null)[] = [
      () => (input.ticket ? this.store.tickets.get(actor, input.ticket).projectId : null),
      () => (input.project ? this.store.visibleProject(actor, input.project).id : null),
      () => (input.room ? this.store.room(actor, input.room).projectId : null),
    ];
    for (const t of tries) {
      try {
        const id = t();
        if (id !== null) return id;
      } catch {
        // Not something this agent can see: try the next, else the entry stays without a project.
      }
    }
    return null;
  }

  /** Writes one entry. Agents only: people's actions are in the audit log already. */
  record(agent: Participant, input: { kind: JournalKind; tool?: string | null; summary: string; why?: string | null; resource?: string | null; ticket?: string | null; link?: string | null; project?: string | null; room?: string | null }): JournalEntry | null {
    if (agent.kind !== 'agent') return null;
    const summary = one(this.store.maskInput(agent, input.summary), MAX_SUMMARY);
    if (!summary) throw new OrcoError('invalid', 'Say what happened in one line');
    const ticket = (input.ticket ?? REF.exec(summary)?.[1] ?? null)?.toUpperCase() ?? null;
    const projectId = this.projectIdOf(agent, { project: input.project, ticket, room: input.room });
    const link = input.link ? one(input.link, 500) : null;
    if (link && !/^https?:\/\//.test(link) && !/^#/.test(link)) throw new OrcoError('invalid', 'A link is an http(s) address');
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO journal (agent_id, at, kind, tool, summary, why, resource, ticket, link, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        agent.id,
        new Date(this.store.now()).toISOString(),
        input.kind,
        input.tool ?? null,
        summary,
        input.why ? one(this.store.maskInput(agent, input.why), MAX_SUMMARY) : null,
        input.resource ? one(input.resource, 200) : null,
        ticket,
        link,
        projectId,
      );
    return this.toEntry(this.store.db.prepare(`${ENTRY_SELECT} WHERE j.id = ?`).get(Number(lastInsertRowid)) as unknown as EntryRow);
  }

  /** Entries an actor may see, newest first, by agent, project, ticket, resource and time window. */
  search(actor: Participant, f: { agent?: string; project?: string; ticket?: string; resource?: string; from?: string; to?: string; kind?: JournalKind; limit?: number } = {}): JournalEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.agent) {
      where.push('a.name = ?');
      params.push(f.agent.replace(/^@/, ''));
    }
    if (f.project) {
      where.push('j.project_id = ?');
      params.push(this.store.visibleProject(actor, f.project).id);
    }
    if (f.ticket) {
      where.push('j.ticket = ?');
      params.push(f.ticket.toUpperCase());
    }
    if (f.resource) {
      where.push("(j.resource LIKE ? ESCAPE '\\' OR j.summary LIKE ? ESCAPE '\\')");
      const like = `%${f.resource.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    for (const [key, op] of [['from', '>='], ['to', '<=']] as const) {
      const v = f[key];
      if (!v) continue;
      const at = new Date(v);
      if (Number.isNaN(at.getTime())) throw new OrcoError('invalid', `${key} is a date or time, like 2026-11-05T06:00`);
      where.push(`j.at ${op} ?`);
      params.push(at.toISOString());
    }
    if (f.kind) {
      where.push('j.kind = ?');
      params.push(f.kind);
    }
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
    const rows = this.store.db.prepare(`${ENTRY_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY j.id DESC LIMIT ?`).all(...params, limit * 4) as unknown as EntryRow[];
    return rows.filter((r) => this.visible(actor, r)).slice(0, limit).map((r) => this.toEntry(r));
  }

  /** "12 tickets filed, 4 branches built, 1 prod change": a day's actions per agent or project. */
  digest(actor: Participant, f: { agent?: string; project?: string; date?: string }): { date: string; lines: string[]; byTool: Record<string, number>; decisions: number; lessons: number } {
    const date = f.date && /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? f.date : day(new Date(this.store.now()).toISOString());
    const entries = this.search(actor, { agent: f.agent, project: f.project, from: `${date}T00:00:00.000Z`, to: `${date}T23:59:59.999Z`, limit: 500 });
    const byTool: Record<string, number> = {};
    for (const e of entries) if (e.kind === 'action' && e.tool) byTool[e.tool] = (byTool[e.tool] ?? 0) + 1;
    const label: Record<string, [string, string]> = {
      create_ticket: ['ticket filed', 'tickets filed'],
      create_tickets: ['batch of tickets filed', 'batches of tickets filed'],
      update_ticket: ['ticket update', 'ticket updates'],
      comment_ticket: ['ticket comment', 'ticket comments'],
      post: ['message', 'messages'],
      create_task: ['task given', 'tasks given'],
      update_task: ['task update', 'task updates'],
      write_project_file: ['file written', 'files written'],
      request_approval: ['approval asked', 'approvals asked'],
      acquire_lock: ['lock taken', 'locks taken'],
      publish_artifact: ['artifact published', 'artifacts published'],
      outline_publish: ['wiki publish', 'wiki publishes'],
    };
    const lines = Object.entries(byTool)
      .sort((a, b) => b[1] - a[1])
      .map(([tool, n]) => `${n} ${(label[tool] ?? [tool.replace(/_/g, ' '), tool.replace(/_/g, ' ')])[n === 1 ? 0 : 1]}`);
    const decisions = entries.filter((e) => e.kind === 'decision').length;
    const lessons = entries.filter((e) => e.kind === 'lesson').length;
    if (decisions) lines.push(`${decisions} decision${decisions === 1 ? '' : 's'}`);
    if (lessons) lines.push(`${lessons} lesson${lessons === 1 ? '' : 's'}`);
    return { date, lines, byTool, decisions, lessons };
  }

  /* Papercuts */

  private toPapercut(r: { id: number; symptom: string; cause: string; fix: string; author: string; created_at: string; corrections: string }): Papercut {
    const corrections = JSON.parse(r.corrections) as string[];
    const text = [`Symptom: ${r.symptom}`, `Cause: ${r.cause}`, `Fix: ${r.fix}`, `(${r.author}, ${day(r.created_at)})`, ...corrections].join('\n');
    return { id: r.id, symptom: r.symptom, cause: r.cause, fix: r.fix, author: r.author, created: r.created_at, corrections, text };
  }

  private papercutRows() {
    return this.store.db.prepare('SELECT c.id, c.symptom, c.cause, c.fix, p.name AS author, c.created_at, c.corrections FROM papercuts c JOIN participants p ON p.id = c.author_id ORDER BY c.id').all() as unknown as {
      id: number;
      symptom: string;
      cause: string;
      fix: string;
      author: string;
      created_at: string;
      corrections: string;
    }[];
  }

  /** Papercuts most like the text (an error message, a symptom), best first. */
  searchPapercuts(_actor: Participant, text: string, limit = 5): (Papercut & { match: number })[] {
    const q = text.trim();
    if (q.length < 3) throw new OrcoError('invalid', 'Search with the error text, at least 3 characters');
    const lower = q.toLowerCase();
    return this.papercutRows()
      .map((r) => {
        const all = `${r.symptom} ${r.cause} ${r.fix}`.toLowerCase();
        const exact = r.symptom.toLowerCase().includes(lower) || lower.includes(r.symptom.toLowerCase()) ? 1 : 0;
        const match = Math.max(exact, similarity(q, r.symptom), all.includes(lower) ? 0.5 : 0);
        return { ...this.toPapercut(r), match: Math.round(match * 100) / 100 };
      })
      .filter((p) => p.match >= 0.25)
      .sort((a, b) => b.match - a.match)
      .slice(0, Math.min(Math.max(limit, 1), 20));
  }

  /**
   * Adds a papercut, only a failure that was verified. One with the same symptom (nearly the same
   * words, numbers and paths aside) is refused with the existing one, to correct instead.
   */
  addPapercut(actor: Participant, input: { symptom: string; cause: string; fix: string }): Papercut {
    const symptom = this.store.maskInput(actor, String(input.symptom ?? '')).trim().slice(0, MAX_FIELD);
    const cause = this.store.maskInput(actor, String(input.cause ?? '')).trim().slice(0, MAX_FIELD);
    const fix = this.store.maskInput(actor, String(input.fix ?? '')).trim().slice(0, MAX_FIELD);
    if (!symptom || !cause || !fix) throw new OrcoError('invalid', 'A papercut has all three: Symptom (the exact error text), Cause and Fix');
    const same = this.papercutRows().find((r) => normalizeSymptom(r.symptom) === normalizeSymptom(symptom) || similarity(r.symptom, symptom) >= 0.8);
    if (same) throw new OrcoError('conflict', `Papercut ${same.id} already covers this symptom; correct it with papercut_correct instead`);
    const { lastInsertRowid } = this.store.db
      .prepare("INSERT INTO papercuts (symptom, cause, fix, author_id, created_at, corrections) VALUES (?, ?, ?, ?, ?, '[]')")
      .run(symptom, cause, fix, actor.id, new Date(this.store.now()).toISOString());
    this.store.audit.record(actor, 'papercut.add', { projectId: null, subject: `papercut:${lastInsertRowid}`, detail: { symptom: symptom.slice(0, 200) } });
    return this.papercut(Number(lastInsertRowid));
  }

  /** Newest first, for the Papercuts page. */
  listPapercuts(limit = 100): Papercut[] {
    return this.papercutRows().reverse().slice(0, limit).map((r) => this.toPapercut(r));
  }

  papercut(id: number): Papercut {
    const row = this.papercutRows().find((r) => r.id === id);
    if (!row) throw new OrcoError('not_found', `No papercut ${id}`);
    return this.toPapercut(row);
  }

  /** Never deleted: a correction is appended as "CORRECTED <date>: …". */
  correctPapercut(actor: Participant, id: number, correction: string): Papercut {
    const p = this.papercut(id);
    const text = this.store.maskInput(actor, String(correction ?? '')).replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD);
    if (!text) throw new OrcoError('invalid', 'Say what was wrong and what is right');
    const line = `CORRECTED ${day(new Date(this.store.now()).toISOString())}: ${text} (${actor.name})`;
    this.store.db.prepare('UPDATE papercuts SET corrections = ? WHERE id = ?').run(JSON.stringify([...p.corrections, line]), id);
    this.store.audit.record(actor, 'papercut.correct', { projectId: null, subject: `papercut:${id}`, detail: { correction: text.slice(0, 200) } });
    return this.papercut(id);
  }

  /** A papercut that keeps coming up becomes an org-memory proposal (#144); an org admin decides. */
  promotePapercut(actor: Participant, id: number): ReturnType<Store['orgNotes']['propose']> {
    const p = this.papercut(id);
    const name = `Papercut: ${p.symptom.replace(/\s+/g, ' ').slice(0, 60)}`;
    return this.store.orgNotes.propose(actor, { name, description: p.fix.split('\n')[0]!.slice(0, 200), type: 'howto', body: p.text, source: `papercut ${p.id}` });
  }
}
