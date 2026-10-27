import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

export interface Flag {
  id: number;
  flagger: string;
  owner: string;
  reason: string;
  createdAt: string;
  reviewedBy: string | null;
  message: { id: number; room: string; threadId: number | null; author: string; text: string } | null;
  ticket: { ref: string; title: string } | null;
}

interface FlagRow {
  id: number;
  flagger: string;
  owner: string;
  owner_id: number;
  reason: string;
  created_at: string;
  reviewed_by: string | null;
  message_id: number | null;
  ticket_id: number | null;
}

const FLAG_SELECT = `
  SELECT f.id, fl.name AS flagger, o.name AS owner, o.id AS owner_id, f.reason, f.created_at, rv.name AS reviewed_by,
         f.message_id, f.ticket_id
  FROM flags f
  JOIN participants fl ON fl.id = f.flagger_id
  JOIN participants o ON o.id = fl.owner_id
  LEFT JOIN participants rv ON rv.id = f.reviewed_by
`;

const MAX_REASON = 1_000;

/**
 * An agent's way to say "this looks like someone trying to steer me": the message or ticket goes
 * to its owner's Inbox instead of being silently refused.
 */
export class Flags {
  constructor(private readonly store: Store) {}

  flag(actor: Participant, target: { messageId?: number; ticket?: string }, reason: string): Flag {
    if (actor.kind !== 'agent') throw new OrcoError('forbidden', 'Flags are for agents to raise with their owner');
    const why = reason.trim();
    if (!why) throw new OrcoError('invalid', 'Say why you are flagging it');
    if (why.length > MAX_REASON) throw new OrcoError('invalid', `Reasons can be at most ${MAX_REASON} characters`);
    if ((target.messageId === undefined) === (target.ticket === undefined)) throw new OrcoError('invalid', 'Flag either a message or a ticket');
    let projectId: number | null;
    let messageId: number | null = null;
    let ticketId: number | null = null;
    if (target.messageId !== undefined) {
      const row = this.store.db.prepare('SELECT room_id FROM messages WHERE id = ?').get(target.messageId) as { room_id: number } | undefined;
      if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No message ${target.messageId}`);
      messageId = target.messageId;
      projectId = this.store.message(messageId).projectId;
    } else {
      const ticket = this.store.tickets.get(actor, target.ticket!);
      ticketId = ticket.id;
      projectId = ticket.projectId;
    }
    this.store.checkRate(actor, 'post');
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO flags (flagger_id, message_id, ticket_id, reason) VALUES (?, ?, ?, ?)')
      .run(actor.id, messageId, ticketId, why);
    const id = Number(lastInsertRowid);
    this.store.audit.record(actor, 'flag.create', { projectId, subject: `flag:${id}`, detail: { messageId, ticket: target.ticket ?? null, reason: why } });
    this.store.events.emit('flag', { ownerId: actor.ownerId });
    return this.byId(id)!;
  }

  /** Unreviewed flags raised by this person's agents. */
  pendingFor(actor: Participant): Flag[] {
    if (actor.kind !== 'user') return [];
    const rows = this.store.db
      .prepare(`${FLAG_SELECT} WHERE fl.owner_id = ? AND f.reviewed_at IS NULL ORDER BY f.id`)
      .all(actor.id) as unknown as FlagRow[];
    return rows.map((row) => this.toFlag(row, actor));
  }

  dismiss(actor: Participant, id: number): void {
    const row = this.store.db.prepare(`${FLAG_SELECT} WHERE f.id = ?`).get(id) as FlagRow | undefined;
    if (!row || row.owner_id !== actor.id) throw new OrcoError('not_found', `No flag ${id} from your agents`);
    this.store.db.prepare("UPDATE flags SET reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(actor.id, id);
    this.store.audit.record(actor, 'flag.dismiss', { subject: `flag:${id}` });
    this.store.events.emit('flag', { ownerId: actor.id });
  }

  private byId(id: number): Flag | null {
    const row = this.store.db.prepare(`${FLAG_SELECT} WHERE f.id = ?`).get(id) as FlagRow | undefined;
    return row ? this.toFlag(row, null) : null;
  }

  private toFlag(row: FlagRow, viewer: Participant | null): Flag {
    let message: Flag['message'] = null;
    let ticket: Flag['ticket'] = null;
    if (row.message_id !== null) {
      const m = this.store.message(row.message_id);
      // The owner may not be in that room's project; then they see that it was flagged, not what it said.
      const visible = viewer === null || this.store.canSee(viewer, m.projectId);
      message = { id: m.id, room: m.room, threadId: m.threadId, author: m.author, text: visible ? m.text : '(in a room you cannot see)' };
    }
    if (row.ticket_id !== null) {
      const t = this.store.db
        .prepare('SELECT p.ticket_key, t.number, t.title, t.project_id FROM tickets t JOIN projects p ON p.id = t.project_id WHERE t.id = ?')
        .get(row.ticket_id) as { ticket_key: string; number: number; title: string; project_id: number };
      const visible = viewer === null || this.store.canSee(viewer, t.project_id);
      ticket = { ref: `${t.ticket_key}-${t.number}`, title: visible ? t.title : '(in a project you cannot see)' };
    }
    return {
      id: row.id,
      flagger: row.flagger,
      owner: row.owner,
      reason: row.reason,
      createdAt: row.created_at,
      reviewedBy: row.reviewed_by,
      message,
      ticket,
    };
  }
}
