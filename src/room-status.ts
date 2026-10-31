import { OrcoError } from './errors.js';
import type { Participant, Room, Store } from './store.js';

const MAX_TEXT = 280;
const MAX_MINUTES = 7 * 24 * 60;

/** A room's current state in one line ("aisle 12 blocked, wave 2 released"), replaced in place. */
export interface RoomStatus {
  room: string;
  text: string;
  setBy: string;
  setAt: string;
  /** When it clears itself, or null. */
  expiresAt: string | null;
}

interface StatusRow {
  room_id: number;
  text: string;
  set_by: string;
  set_at: string;
  expires_at: string | null;
}

/**
 * One status line per room, like a retained message: whoever joins (or connects a dashboard) sees the
 * current state at once instead of scrolling for it. Anyone who can write in the room replaces it;
 * an expiry clears stale state on its own.
 */
export class RoomStatuses {
  constructor(private readonly store: Store) {}

  set(actor: Participant, ref: string, text: string, expiresInMinutes?: number | null): RoomStatus | null {
    const room = this.store.room(actor, ref);
    this.store.assertWrite(actor, room.projectId);
    const line = String(text ?? '').trim().replace(/\s+/g, ' ');
    if (line.length > MAX_TEXT) throw new OrcoError('invalid', `A room status is at most ${MAX_TEXT} characters`);
    if (expiresInMinutes != null && !(Number.isInteger(expiresInMinutes) && expiresInMinutes >= 1 && expiresInMinutes <= MAX_MINUTES)) {
      throw new OrcoError('invalid', `expires_in_minutes is 1 to ${MAX_MINUTES}`);
    }
    if (!line) {
      this.store.db.prepare('DELETE FROM room_status WHERE room_id = ?').run(room.id);
    } else {
      const now = this.store.now();
      this.store.db
        .prepare(
          `INSERT INTO room_status (room_id, text, set_by, set_at, expires_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (room_id) DO UPDATE SET text = excluded.text, set_by = excluded.set_by, set_at = excluded.set_at, expires_at = excluded.expires_at`,
        )
        .run(room.id, this.store.maskInput(actor, line), actor.id, new Date(now).toISOString(), expiresInMinutes ? new Date(now + expiresInMinutes * 60_000).toISOString() : null);
    }
    this.store.audit.record(actor, line ? 'room.status' : 'room.status_clear', { projectId: room.projectId, subject: `room:${room.ref}`, detail: line ? { text: line, expiresInMinutes: expiresInMinutes ?? null } : {} });
    const status = this.of(room);
    this.store.events.emit('room_status', { projectId: room.projectId, room: room.ref, status });
    return status;
  }

  /** A room's status, or null (none, or expired). */
  of(room: Room): RoomStatus | null {
    const row = this.store.db
      .prepare('SELECT s.room_id, s.text, p.name AS set_by, s.set_at, s.expires_at FROM room_status s JOIN participants p ON p.id = s.set_by WHERE s.room_id = ?')
      .get(room.id) as StatusRow | undefined;
    return row && this.live(row) ? this.toStatus(room.ref, row) : null;
  }

  /** The live statuses of every room the actor can see. */
  visible(actor: Participant): RoomStatus[] {
    return this.store.listRooms(actor).flatMap((room) => {
      const status = this.of(room);
      return status ? [status] : [];
    });
  }

  /** Clears expired statuses and tells streams; run from the once-a-minute sweep. */
  sweep(): void {
    const now = new Date(this.store.now()).toISOString();
    const expired = this.store.db
      .prepare('SELECT s.room_id, r.project_id, coalesce(p.name || \'/\', \'\') || r.name AS ref FROM room_status s JOIN rooms r ON r.id = s.room_id LEFT JOIN projects p ON p.id = r.project_id WHERE s.expires_at IS NOT NULL AND s.expires_at <= ?')
      .all(now) as { room_id: number; project_id: number | null; ref: string }[];
    for (const row of expired) {
      this.store.db.prepare('DELETE FROM room_status WHERE room_id = ?').run(row.room_id);
      this.store.events.emit('room_status', { projectId: row.project_id, room: row.ref, status: null });
    }
  }

  private live(row: StatusRow): boolean {
    return row.expires_at === null || row.expires_at > new Date(this.store.now()).toISOString();
  }

  private toStatus(room: string, row: StatusRow): RoomStatus {
    return { room, text: row.text, setBy: row.set_by, setAt: row.set_at, expiresAt: row.expires_at };
  }
}
