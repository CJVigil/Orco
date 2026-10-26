import { EventEmitter } from 'node:events';

export type Status = 'online' | 'listening' | 'offline';

const AGENT_ONLINE_MS = 120_000;

interface Entry {
  lastSeen: number;
  streams: number;
  waiting: number;
}

export class Presence {
  readonly events = new EventEmitter();
  private readonly entries = new Map<number, Entry>();

  constructor(private readonly now: () => number = Date.now) {
    this.events.setMaxListeners(0);
  }

  touch(id: number): void {
    const entry = this.entry(id);
    const before = this.status(id);
    entry.lastSeen = this.now();
    this.changed(id, before);
  }

  hold(id: number, kind: 'streams' | 'waiting'): () => void {
    const before = this.status(id);
    this.entry(id)[kind]++;
    this.entry(id).lastSeen = this.now();
    this.changed(id, before);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const prior = this.status(id);
      const entry = this.entry(id);
      entry[kind]--;
      entry.lastSeen = this.now();
      this.changed(id, prior);
    };
  }

  status(id: number): Status {
    const entry = this.entries.get(id);
    if (!entry) return 'offline';
    if (entry.waiting > 0) return 'listening';
    if (entry.streams > 0 || this.now() - entry.lastSeen < AGENT_ONLINE_MS) return 'online';
    return 'offline';
  }

  private entry(id: number): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { lastSeen: 0, streams: 0, waiting: 0 };
      this.entries.set(id, entry);
    }
    return entry;
  }

  private changed(id: number, before: Status): void {
    if (this.status(id) !== before) this.events.emit('change', id);
  }
}
