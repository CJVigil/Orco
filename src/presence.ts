import { EventEmitter } from 'node:events';

export type Status = 'online' | 'listening' | 'standby' | 'offline';

const AGENT_ONLINE_MS = 120_000;
/** How often a participant's last-seen time is written to the database, at most. */
const PERSIST_MS = 30_000;

interface Entry {
  lastSeen: number;
  streams: number;
  waiting: number;
  bridges: number;
  persisted: number;
  /** Fires when the online window runs out, so going quiet is an event too. */
  expiry: ReturnType<typeof setTimeout> | null;
}

/** What a presence change says: who, what they are now, when they were last seen, and why it changed. */
export interface PresenceChange {
  id: number;
  status: Status;
  previous: Status;
  lastSeen: string | null;
  reason: 'activity' | 'connected' | 'disconnected' | 'timeout';
}

export class Presence {
  readonly events = new EventEmitter();
  private readonly entries = new Map<number, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    /** Keeps the last-seen time across restarts (written at most every 30 seconds per participant). */
    private readonly persist?: (id: number, at: string) => void,
  ) {
    this.events.setMaxListeners(0);
  }

  touch(id: number): void {
    const entry = this.entry(id);
    const before = this.status(id);
    this.seen(id, entry);
    this.changed(id, before, 'activity');
  }

  hold(id: number, kind: 'streams' | 'waiting' | 'bridges'): () => void {
    const before = this.status(id);
    this.entry(id)[kind]++;
    if (kind !== 'bridges') this.seen(id, this.entry(id));
    this.changed(id, before, 'connected');
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const prior = this.status(id);
      const entry = this.entry(id);
      entry[kind]--;
      if (kind !== 'bridges') this.seen(id, entry);
      this.changed(id, prior, 'disconnected');
    };
  }

  status(id: number): Status {
    const entry = this.entries.get(id);
    if (!entry) return 'offline';
    if (entry.waiting > 0) return 'listening';
    if (entry.streams > 0 || this.now() - entry.lastSeen < AGENT_ONLINE_MS) return 'online';
    if (entry.bridges > 0) return 'standby';
    return 'offline';
  }

  /** When this server last saw them (since it started), or null. */
  lastSeen(id: number): string | null {
    const entry = this.entries.get(id);
    return entry && entry.lastSeen > 0 ? new Date(entry.lastSeen).toISOString() : null;
  }

  /** Stops the timers, for a clean shutdown. */
  stop(): void {
    for (const entry of this.entries.values()) if (entry.expiry) clearTimeout(entry.expiry);
  }

  private seen(id: number, entry: Entry): void {
    entry.lastSeen = this.now();
    if (this.persist && entry.lastSeen - entry.persisted >= PERSIST_MS) {
      entry.persisted = entry.lastSeen;
      this.persist(id, new Date(entry.lastSeen).toISOString());
    }
    // Online lasts AGENT_ONLINE_MS after the last sign of life; say so when it runs out.
    if (entry.expiry) clearTimeout(entry.expiry);
    entry.expiry = setTimeout(() => {
      entry.expiry = null;
      this.changed(id, 'online', 'timeout');
    }, AGENT_ONLINE_MS + 50);
    entry.expiry.unref?.();
  }

  private entry(id: number): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { lastSeen: 0, streams: 0, waiting: 0, bridges: 0, persisted: 0, expiry: null };
      this.entries.set(id, entry);
    }
    return entry;
  }

  private changed(id: number, before: Status, reason: PresenceChange['reason']): void {
    const status = this.status(id);
    if (status === before) return;
    const change: PresenceChange = { id, status, previous: before, lastSeen: this.lastSeen(id), reason };
    this.events.emit('change', id, change);
  }
}
