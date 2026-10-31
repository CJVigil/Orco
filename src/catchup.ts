import type { Decision } from './decisions.js';
import type { RoomStatus } from './room-status.js';
import type { Message, Participant, Store } from './store.js';
import type { TicketSummary } from './tickets.js';

const PER_ROOM = 30;
const MAX_TICKETS = 30;
const FIRST_TICKET_WINDOW_MS = 24 * 3600_000;

export interface ThreadDigest {
  threadId: number;
  newReplies: number;
  /** The thread's summary, if someone keeps one; read it instead of the replies. */
  summary: string | null;
  last: { author: string; text: string; at: string };
}

export interface RoomCatchUp {
  room: string;
  /** New top-level messages, oldest first (your own left out). */
  messages: Message[];
  /** Threads with new replies, as digests rather than every reply. */
  threads: ThreadDigest[];
  /** New top-level messages left out because there were more than fit. */
  skipped: number;
}

export interface CatchUp {
  rooms: RoomCatchUp[];
  /** Tickets changed since you last caught up, in projects you can see. */
  tickets: TicketSummary[];
  /** Decisions recorded since you last caught up. */
  decisions: Decision[];
  /** The current status line of each room looked at, even when nothing in it is new. */
  statuses: RoomStatus[];
  since: string | null;
}

/**
 * What changed since an agent last looked, room by room: new messages, thread replies folded into
 * digests, and changed tickets. Each call moves the agent's read positions forward, so the next
 * call returns only what is newer. Cheaper than re-reading rooms on every wake.
 */
export function catchUp(store: Store, actor: Participant, options: { room?: string; perRoom?: number } = {}): CatchUp {
  const perRoom = Math.min(Math.max(options.perRoom ?? PER_ROOM, 1), 100);
  const rooms = options.room ? [store.room(actor, options.room)] : store.listRooms(actor);
  const cursorOf = store.db.prepare('SELECT last_id FROM read_cursors WHERE participant_id = ? AND room_id = ?');
  const result: CatchUp = { rooms: [], tickets: [], decisions: [], statuses: [], since: null };

  for (const room of rooms) {
    const status = store.roomStatus.of(room);
    if (status) result.statuses.push(status);
    const cursor = (cursorOf.get(actor.id, room.id) as { last_id: number } | undefined)?.last_id ?? 0;
    const newest = store.db.prepare('SELECT max(id) AS id FROM messages WHERE room_id = ?').get(room.id) as { id: number | null };
    if (newest.id === null || newest.id <= cursor) continue;
    const fresh = store.read(actor, room.ref, { sinceId: cursor, limit: 200, topLevel: true }).filter((m) => m.author !== actor.name);
    const total = (store.db.prepare('SELECT count(*) AS n FROM messages WHERE room_id = ? AND id > ? AND thread_id IS NULL AND author_id != ?').get(room.id, cursor, actor.id) as { n: number }).n;
    const replies = store.db
      .prepare(
        `SELECT m.thread_id, count(*) AS n, max(m.id) AS last_id FROM messages m
         WHERE m.room_id = ? AND m.id > ? AND m.thread_id IS NOT NULL AND m.author_id != ?
         GROUP BY m.thread_id ORDER BY last_id DESC LIMIT ?`,
      )
      .all(room.id, cursor, actor.id, perRoom) as unknown as { thread_id: number; n: number; last_id: number }[];
    const threads = replies.map((r) => {
      const last = store.message(r.last_id);
      const text = last.text.length > 300 ? `${last.text.slice(0, 297)}…` : last.text;
      return { threadId: r.thread_id, newReplies: r.n, summary: store.threadSummary(r.thread_id)?.text ?? null, last: { author: last.author, text, at: last.createdAt } };
    });
    store.db
      .prepare('INSERT INTO read_cursors (participant_id, room_id, last_id) VALUES (?, ?, ?) ON CONFLICT (participant_id, room_id) DO UPDATE SET last_id = excluded.last_id')
      .run(actor.id, room.id, newest.id);
    const messages = fresh.slice(-perRoom);
    if (messages.length || threads.length) result.rooms.push({ room: room.ref, messages, threads, skipped: Math.max(0, total - messages.length) });
  }

  if (!options.room) {
    const row = store.db.prepare('SELECT caught_up_at FROM participants WHERE id = ?').get(actor.id) as { caught_up_at: string | null };
    result.since = row.caught_up_at;
    const since = row.caught_up_at ?? new Date(store.now() - FIRST_TICKET_WINDOW_MS).toISOString();
    result.tickets = store.tickets
      .list(actor, { limit: 500 })
      .filter((t) => t.updatedAt > since)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_TICKETS);
    result.decisions = store.decisions.since(actor, since);
    store.db.prepare('UPDATE participants SET caught_up_at = ? WHERE id = ?').run(new Date(store.now()).toISOString(), actor.id);
  }
  return result;
}

/** Moves an agent's read position in a room forward, when it reads the room directly. */
export function advanceCursor(store: Store, actor: Participant, roomId: number, lastId: number): void {
  store.db
    .prepare(
      `INSERT INTO read_cursors (participant_id, room_id, last_id) VALUES (?, ?, ?)
       ON CONFLICT (participant_id, room_id) DO UPDATE SET last_id = max(last_id, excluded.last_id)`,
    )
    .run(actor.id, roomId, lastId);
}
