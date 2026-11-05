import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/*
 * Org memory (#144): shared notes every agent loads, like a team MEMORY.md, kept as an
 * Obsidian-compatible vault: one Markdown note per fact with frontmatter, [[links]] between notes, and
 * an INDEX.md of one line per note that goes into every agent's context.
 *
 * Guardrails: agents only propose; an org admin approves before a note goes live, so a misread remark
 * never becomes every agent's "fact". Each note says who wrote it, when, and which ticket or message it
 * came from. Situational facts carry an expiry and are flagged when it passes, not loaded as current.
 * Deciding is for people only: agents get no tool that approves or deletes a note.
 */
export const NOTE_TYPES = ['rule', 'fact', 'howto', 'contact', 'status'] as const;
export type OrgNoteType = (typeof NOTE_TYPES)[number];
export type OrgNoteState = 'proposed' | 'live' | 'rejected';

export interface OrgNote {
  id: number;
  /** The file name in the vault and the [[link]] target. */
  slug: string;
  name: string;
  description: string;
  type: OrgNoteType;
  body: string;
  author: string;
  /** Where it came from: a ticket ref (API-12) or a message (message 123), if any. */
  source: string | null;
  state: OrgNoteState;
  created: string;
  expires: string | null;
  expired: boolean;
  approvedBy: string | null;
  /** An agent asked for it to be forgotten; an org admin decides. */
  forgetRequestedBy: string | null;
  /** Tickets it mentions, for "notes about this" on them. */
  tickets: string[];
  /** [[links]] to other notes. */
  links: string[];
}

const MAX_BODY = 8000;
const MAX_INDEX = 6000;
const REF = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

export const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'note';

interface Row {
  id: number;
  slug: string;
  name: string;
  description: string;
  type: OrgNoteType;
  body: string;
  author: string;
  source: string | null;
  state: OrgNoteState;
  created_at: string;
  expires: string | null;
  approver: string | null;
  forgetter: string | null;
}

const SELECT = `
  SELECT n.id, n.slug, n.name, n.description, n.type, n.body, a.name AS author, n.source, n.state, n.created_at, n.expires,
         ap.name AS approver, fg.name AS forgetter
  FROM org_notes n JOIN participants a ON a.id = n.author_id
  LEFT JOIN participants ap ON ap.id = n.approved_by LEFT JOIN participants fg ON fg.id = n.forget_requested_by
`;

export class OrgNotes {
  constructor(private readonly store: Store) {}

  private toNote(row: Row): OrgNote {
    const today = new Date(this.store.now()).toISOString().slice(0, 10);
    const text = `${row.body} ${row.source ?? ''}`;
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      type: row.type,
      body: row.body,
      author: row.author,
      source: row.source,
      state: row.state,
      created: row.created_at,
      expires: row.expires,
      expired: row.expires !== null && row.expires < today,
      approvedBy: row.approver,
      forgetRequestedBy: row.forgetter,
      tickets: [...new Set([...text.matchAll(REF)].map((m) => m[1]!))],
      links: [...new Set([...row.body.matchAll(/\[\[([^\]|#]{1,80})(?:[|#][^\]]*)?\]\]/g)].map((m) => slugify(m[1]!)))],
    };
  }

  private assertPerson(actor: Participant) {
    if (actor.kind !== 'user' || actor.scope) throw new OrcoError('forbidden', 'Only people approve or remove org notes');
    if (!this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins approve or remove org notes');
  }

  /** Live notes everyone loads, and (for org admins) the ones waiting for a decision. */
  list(actor: Participant, options: { state?: OrgNoteState | 'all' } = {}): OrgNote[] {
    const state = options.state ?? 'live';
    if (state !== 'live' && !(actor.kind === 'user' && this.store.isOrgAdmin(actor))) {
      // Anyone sees their own proposals; the queue as a whole is for org admins.
      const own = this.store.db.prepare(`${SELECT} WHERE n.author_id = ? AND n.state = 'proposed' ORDER BY n.id`).all(actor.id) as unknown as Row[];
      return own.map((r) => this.toNote(r));
    }
    const rows = this.store.db.prepare(`${SELECT} ${state === 'all' ? '' : 'WHERE n.state = ?'} ORDER BY n.type, n.name`).all(...(state === 'all' ? [] : [state])) as unknown as Row[];
    return rows.map((r) => this.toNote(r));
  }

  read(_actor: Participant, slugOrName: string): OrgNote {
    const slug = slugify(slugOrName);
    const row = this.store.db.prepare(`${SELECT} WHERE n.slug = ?`).get(slug) as Row | undefined;
    if (!row || row.state === 'rejected') throw new OrcoError('not_found', `No org note ${slugOrName}; org_notes lists them`);
    return this.toNote(row);
  }

  /** One line per live note, for every agent's context: expired ones flagged, not stated as current. */
  index(): string {
    const notes = (this.store.db.prepare(`${SELECT} WHERE n.state = 'live' ORDER BY n.type, n.name`).all() as unknown as Row[]).map((r) => this.toNote(r));
    if (!notes.length) return '';
    const lines = ['# Org memory', '', 'Approved by an org admin. Read a note in full with org_notes when it is relevant.', ''];
    for (const n of notes) {
      const line = `- [[${n.slug}]] (${n.type}) ${n.description || n.name}${n.expires ? (n.expired ? ` (EXPIRED ${n.expires}: may no longer hold)` : ` (until ${n.expires})`) : ''}`;
      if (lines.join('\n').length + line.length > MAX_INDEX) {
        lines.push(`- … ${notes.length - (lines.length - 4)} more: list them with org_notes`);
        break;
      }
      lines.push(line);
    }
    return lines.join('\n');
  }

  /** Org notes that mention a ticket ("notes about this" on the ticket). */
  aboutTicket(ref: string): OrgNote[] {
    return this.list({ kind: 'user' } as Participant).filter((n) => n.tickets.includes(ref.toUpperCase()));
  }

  /**
   * Proposes a note. From an org admin it is live at once; from anyone else (agents included) it waits
   * for an org admin. A note with the same name is replaced the same way (a new proposal).
   */
  propose(actor: Participant, input: { name: string; description?: string; type?: string; body: string; source?: string | null; expires?: string | null }): OrgNote {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new OrcoError('invalid', 'Name the note in 1-80 characters');
    const body = this.store.hideSecrets(actor, input.body.trim());
    if (!body) throw new OrcoError('invalid', 'The note is empty');
    if (body.length > MAX_BODY) throw new OrcoError('invalid', `Notes are at most ${MAX_BODY} characters; keep one fact per note`);
    const type = (input.type ?? 'fact') as OrgNoteType;
    if (!NOTE_TYPES.includes(type)) throw new OrcoError('invalid', `The type is one of ${NOTE_TYPES.join(', ')}`);
    const expires = input.expires?.trim() || null;
    if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw new OrcoError('invalid', 'expires is a date, YYYY-MM-DD');
    if (type === 'status' && !expires) throw new OrcoError('invalid', 'A status ("X is down", "Y is out") needs expires');
    const description = (input.description ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
    const source = input.source?.trim().slice(0, 100) || null;
    const live = actor.kind === 'user' && !actor.scope && this.store.isOrgAdmin(actor);
    const slug = slugify(name);
    const now = new Date(this.store.now()).toISOString();
    const existing = this.store.db.prepare('SELECT id, state FROM org_notes WHERE slug = ?').get(slug) as { id: number; state: OrgNoteState } | undefined;
    if (existing && existing.state === 'live' && !live) {
      // A change to a live note is proposed under its own slug, so the live one stays until approved.
      const proposal = `${slug}-proposed-${this.store.now().toString(36)}`;
      return this.insert(actor, { slug: proposal, name, description, type, body, source, expires, state: 'proposed', now, replaces: slug });
    }
    if (existing) this.store.db.prepare('DELETE FROM org_notes WHERE id = ?').run(existing.id);
    return this.insert(actor, { slug, name, description, type, body, source, expires, state: live ? 'live' : 'proposed', now, replaces: null });
  }

  private insert(actor: Participant, n: { slug: string; name: string; description: string; type: OrgNoteType; body: string; source: string | null; expires: string | null; state: OrgNoteState; now: string; replaces: string | null }): OrgNote {
    const { lastInsertRowid } = this.store.db
      .prepare(
        'INSERT INTO org_notes (slug, name, description, type, body, author_id, source, state, created_at, expires, approved_by, replaces) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(n.slug, n.name, n.description, n.type, n.body, actor.id, n.source, n.state, n.now, n.expires, n.state === 'live' ? actor.id : null, n.replaces);
    this.store.audit.record(actor, n.state === 'live' ? 'org_note.write' : 'org_note.propose', { projectId: null, subject: `org_note:${n.slug}`, detail: { name: n.name, source: n.source } });
    this.store.events.emit('org_notes', {});
    return this.toNote(this.store.db.prepare(`${SELECT} WHERE n.id = ?`).get(Number(lastInsertRowid)) as unknown as Row);
  }

  /** An org admin approves a proposal: it goes live (replacing the note it was a change to). */
  approve(actor: Participant, id: number): OrgNote {
    this.assertPerson(actor);
    const row = this.store.db.prepare('SELECT id, slug, state, replaces FROM org_notes WHERE id = ?').get(id) as { id: number; slug: string; state: OrgNoteState; replaces: string | null } | undefined;
    if (!row || row.state !== 'proposed') throw new OrcoError('not_found', `No proposed org note ${id}`);
    if (row.replaces) {
      this.store.db.prepare('DELETE FROM org_notes WHERE slug = ?').run(row.replaces);
      this.store.db.prepare('UPDATE org_notes SET slug = ?, replaces = NULL WHERE id = ?').run(row.replaces, id);
    }
    this.store.db.prepare("UPDATE org_notes SET state = 'live', approved_by = ?, approved_at = ? WHERE id = ?").run(actor.id, new Date(this.store.now()).toISOString(), id);
    this.store.audit.record(actor, 'org_note.approve', { projectId: null, subject: `org_note:${row.replaces ?? row.slug}`, detail: {} });
    this.store.events.emit('org_notes', {});
    return this.toNote(this.store.db.prepare(`${SELECT} WHERE n.id = ?`).get(id) as unknown as Row);
  }

  reject(actor: Participant, id: number): void {
    this.assertPerson(actor);
    const { changes } = this.store.db.prepare("UPDATE org_notes SET state = 'rejected' WHERE id = ? AND state = 'proposed'").run(id);
    if (!changes) throw new OrcoError('not_found', `No proposed org note ${id}`);
    this.store.audit.record(actor, 'org_note.reject', { projectId: null, subject: `org_note:${id}`, detail: {} });
    this.store.events.emit('org_notes', {});
  }

  /**
   * Forgets a note. An org admin removes it; anyone else (an agent that learned it no longer holds)
   * asks, and the request waits in the queue with the note.
   */
  forget(actor: Participant, slugOrName: string, reason?: string): { removed: boolean } {
    const note = this.read(actor, slugOrName);
    if (actor.kind === 'user' && !actor.scope && this.store.isOrgAdmin(actor)) {
      this.store.db.prepare('DELETE FROM org_notes WHERE id = ?').run(note.id);
      this.store.audit.record(actor, 'org_note.forget', { projectId: null, subject: `org_note:${note.slug}`, detail: { reason: reason ?? null } });
      this.store.events.emit('org_notes', {});
      return { removed: true };
    }
    this.store.db.prepare('UPDATE org_notes SET forget_requested_by = ?, forget_reason = ? WHERE id = ?').run(actor.id, reason?.slice(0, 300) ?? null, note.id);
    this.store.audit.record(actor, 'org_note.forget_request', { projectId: null, subject: `org_note:${note.slug}`, detail: { reason: reason ?? null } });
    this.store.events.emit('org_notes', {});
    return { removed: false };
  }

  /** Keeps a note an agent asked to forget. */
  keep(actor: Participant, id: number): void {
    this.assertPerson(actor);
    this.store.db.prepare('UPDATE org_notes SET forget_requested_by = NULL, forget_reason = NULL WHERE id = ?').run(id);
    this.store.events.emit('org_notes', {});
  }

  /* The vault: Markdown files with frontmatter, openable in Obsidian. Server-side (CLI) only. */

  /** Writes every live note as <slug>.md, plus INDEX.md, into a folder. */
  exportVault(dir: string): number {
    mkdirSync(dir, { recursive: true });
    const notes = (this.store.db.prepare(`${SELECT} WHERE n.state = 'live' ORDER BY n.slug`).all() as unknown as Row[]).map((r) => this.toNote(r));
    const yaml = (v: string) => JSON.stringify(v);
    for (const n of notes) {
      const front = [
        '---',
        `name: ${yaml(n.name)}`,
        `description: ${yaml(n.description)}`,
        `type: ${n.type}`,
        `author: ${yaml(n.author)}`,
        ...(n.source ? [`source: ${yaml(n.source)}`] : []),
        `created: ${n.created.slice(0, 10)}`,
        ...(n.expires ? [`expires: ${n.expires}`] : []),
        ...(n.approvedBy ? [`approved_by: ${yaml(n.approvedBy)}`] : []),
        '---',
        '',
      ].join('\n');
      writeFileSync(join(dir, `${n.slug}.md`), `${front}${n.body}\n`);
    }
    writeFileSync(join(dir, 'INDEX.md'), `${this.index()}\n`);
    return notes.length;
  }

  /**
   * Reads a vault folder back: each <slug>.md becomes that live note, written by the server's
   * operator (edited in Obsidian by whoever runs Orco). INDEX.md is generated, so it is skipped.
   */
  importVault(dir: string, operator: Participant): number {
    let count = 0;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md') || file === 'INDEX.md') continue;
      const text = readFileSync(join(dir, file), 'utf8');
      const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
      const meta: Record<string, string> = {};
      for (const line of (m?.[1] ?? '').split('\n')) {
        const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
        if (!kv) continue;
        let value = kv[2]!.trim();
        if (value.startsWith('"')) {
          try {
            value = JSON.parse(value) as string;
          } catch {
            // Keep it as written.
          }
        }
        meta[kv[1]!] = value;
      }
      const name = meta.name || file.replace(/\.md$/, '');
      this.propose(operator, { name, description: meta.description, type: meta.type, body: (m?.[2] ?? text).trim(), source: meta.source ?? null, expires: meta.expires ?? null });
      count++;
    }
    return count;
  }
}
