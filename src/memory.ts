import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

const MAX_NOTES = 50;
const MAX_TITLE = 100;
const MAX_BODY = 4_000;

export interface MemoryNote {
  id: number;
  title: string;
  body: string;
  updatedBy: string;
  updatedAt: string;
}

interface MemoryRow {
  id: number;
  title: string;
  body: string;
  updated_by: string;
  updated_at: string;
}

const SELECT = `
  SELECT m.id, m.title, m.body, u.name AS updated_by, m.updated_at
  FROM agent_memory m JOIN participants u ON u.id = m.updated_by
`;

/**
 * An agent's private notes, kept between sessions: things a fresh start would otherwise relearn
 * ("this repo's tests need --runInBand"). Only the agent and its owner can see them; project notes
 * are for what the whole team should know.
 */
export class Memory {
  constructor(private readonly store: Store) {}

  list(actor: Participant, agentName?: string): MemoryNote[] {
    const agent = this.agentFor(actor, agentName);
    const rows = this.store.db.prepare(`${SELECT} WHERE m.agent_id = ? ORDER BY m.title`).all(agent.id) as unknown as MemoryRow[];
    return rows.map(toNote);
  }

  /** Adds a note or replaces the one with the same title. Agents write their own memory only. */
  save(actor: Participant, input: { title: string; body: string }): MemoryNote {
    if (actor.kind !== 'agent') throw new OrcoError('forbidden', 'Only agents keep memory; people can read and delete their agents\' notes');
    const title = input.title.trim().replace(/\s+/g, ' ');
    const body = input.body.trim();
    if (!title) throw new OrcoError('invalid', 'A memory note needs a title');
    if (title.length > MAX_TITLE) throw new OrcoError('invalid', `Titles are at most ${MAX_TITLE} characters`);
    if (!body) throw new OrcoError('invalid', 'The note is empty; to forget it, use forget');
    if (body.length > MAX_BODY) throw new OrcoError('invalid', `Notes are at most ${MAX_BODY} characters; keep them short and durable`);
    const existing = this.store.db.prepare('SELECT id FROM agent_memory WHERE agent_id = ? AND title = ?').get(actor.id, title) as { id: number } | undefined;
    if (existing) {
      this.store.db
        .prepare("UPDATE agent_memory SET body = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
        .run(body, actor.id, existing.id);
    } else {
      const count = (this.store.db.prepare('SELECT count(*) AS n FROM agent_memory WHERE agent_id = ?').get(actor.id) as { n: number }).n;
      if (count >= MAX_NOTES) throw new OrcoError('conflict', `You keep ${MAX_NOTES} notes already; merge or forget some first`);
      this.store.db.prepare('INSERT INTO agent_memory (agent_id, title, body, updated_by) VALUES (?, ?, ?, ?)').run(actor.id, title, body, actor.id);
    }
    this.store.audit.record(actor, 'memory.save', { subject: `agent:${actor.name}`, detail: { title } });
    return this.byTitle(actor.id, title)!;
  }

  /** Removes a note by id or title; the agent itself or its owner. */
  forget(actor: Participant, ref: { id?: number; title?: string }, agentName?: string): void {
    const agent = this.agentFor(actor, agentName);
    const row =
      ref.id !== undefined
        ? (this.store.db.prepare('SELECT id, title FROM agent_memory WHERE agent_id = ? AND id = ?').get(agent.id, ref.id) as { id: number; title: string } | undefined)
        : (this.store.db.prepare('SELECT id, title FROM agent_memory WHERE agent_id = ? AND title = ?').get(agent.id, (ref.title ?? '').trim()) as
            | { id: number; title: string }
            | undefined);
    if (!row) throw new OrcoError('not_found', 'No such memory note');
    this.store.db.prepare('DELETE FROM agent_memory WHERE id = ?').run(row.id);
    this.store.audit.record(actor, 'memory.forget', { subject: `agent:${agent.name}`, detail: { title: row.title } });
  }

  private byTitle(agentId: number, title: string): MemoryNote | null {
    const row = this.store.db.prepare(`${SELECT} WHERE m.agent_id = ? AND m.title = ?`).get(agentId, title) as MemoryRow | undefined;
    return row ? toNote(row) : null;
  }

  private agentFor(actor: Participant, agentName?: string): Participant {
    if (actor.kind === 'agent') {
      if (agentName !== undefined && agentName !== actor.name) throw new OrcoError('forbidden', 'Agents can only see their own memory');
      return actor;
    }
    const agent = agentName ? this.store.participantByName(agentName) : null;
    if (!agent || agent.kind !== 'agent' || agent.ownerId !== actor.id) throw new OrcoError('not_found', `You have no agent named ${agentName ?? ''}`);
    return agent;
  }
}

function toNote(row: MemoryRow): MemoryNote {
  return { id: row.id, title: row.title, body: row.body, updatedBy: row.updated_by, updatedAt: row.updated_at };
}
