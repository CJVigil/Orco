import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';
import { myWork } from './work.js';

export type NotifyLevel = 'needs_me' | 'all' | 'off';
const LEVELS: readonly NotifyLevel[] = ['needs_me', 'all', 'off'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DIGEST_BULLETS = 3;
const MAX_SNOOZE_MS = 14 * 24 * 3600_000;

/** How a person wants to be interrupted, kept on the server so it follows them between devices. */
export interface AttentionSettings {
  /** needs_me: approvals, questions, reviews and asks right away, agent updates batched; all: also people's mentions; off. */
  notifyLevel: NotifyLevel;
  /** Quiet hours, local "HH:MM" in tz; held notifications arrive as one summary when they end. */
  quietStart: string | null;
  quietEnd: string | null;
  tz: string;
  /** Weekdays at this local time, a three-bullet digest of what waits on them; null is off. */
  digestTime: string | null;
}

export interface Digest {
  /** At most three things waiting on the person, most urgent first. */
  bullets: string[];
  /** How many more wait beyond those. */
  more: number;
  /** One line on what agents finished for them since the last digest, or null. */
  finished: string | null;
  /** Where to act: the Needs you page. */
  link: string;
  at: string;
}

interface SettingsRow {
  notify_level: NotifyLevel;
  quiet_start: string | null;
  quiet_end: string | null;
  tz: string;
  digest_time: string | null;
  digest_last: string | null;
}

function checkTz(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    throw new OrcoError('invalid', `${tz} is not a time zone, like Europe/Berlin or America/Chicago`);
  }
}

/** The local weekday (0 Sunday), date and "HH:MM" in a time zone. */
function localNow(ms: number, tz: string): { weekday: number; date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  return { weekday, date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * What a person is interrupted by, and when (#88, #89): their notification level and quiet hours,
 * items they snoozed, mentions they opened, and a short daily digest of what waits on them, delivered
 * inside Orco (and at GET /api/digest/me, for a team that forwards it from its own scheduled job; the
 * server calls nothing out).
 */
export class Attention {
  constructor(private readonly store: Store) {}

  settings(actor: Participant): AttentionSettings {
    const row = this.row(actor);
    return { notifyLevel: row.notify_level, quietStart: row.quiet_start, quietEnd: row.quiet_end, tz: row.tz, digestTime: row.digest_time };
  }

  update(actor: Participant, input: Partial<AttentionSettings>): AttentionSettings {
    if (actor.kind !== 'user' || actor.scope) throw new OrcoError('forbidden', 'Only people have notification settings');
    const current = this.settings(actor);
    const next = { ...current, ...input };
    if (!LEVELS.includes(next.notifyLevel)) throw new OrcoError('invalid', 'Notifications are needs_me, all or off');
    for (const [name, value] of [['quiet_start', next.quietStart], ['quiet_end', next.quietEnd], ['digest_time', next.digestTime]] as const) {
      if (value !== null && !TIME.test(value)) throw new OrcoError('invalid', `${name} is a time like 08:30, or null`);
    }
    if ((next.quietStart === null) !== (next.quietEnd === null)) throw new OrcoError('invalid', 'Quiet hours need a start and an end');
    checkTz(next.tz);
    this.store.db
      .prepare('UPDATE participants SET notify_level = ?, quiet_start = ?, quiet_end = ?, tz = ?, digest_time = ? WHERE id = ?')
      .run(next.notifyLevel, next.quietStart, next.quietEnd, next.tz, next.digestTime, actor.id);
    this.store.audit.record(actor, 'settings.attention', { subject: `user:${actor.name}`, detail: next });
    return this.settings(actor);
  }

  /** Hides a Needs you item (by its key) until a time; a past or empty time clears the snooze. */
  snooze(actor: Participant, key: string, until: string | null): void {
    if (!/^[a-z]+-[\w.-]{1,60}$/i.test(key)) throw new OrcoError('invalid', 'Not an item key');
    if (!until) {
      this.store.db.prepare('DELETE FROM snoozes WHERE participant_id = ? AND key = ?').run(actor.id, key);
      return;
    }
    const at = Date.parse(until);
    if (Number.isNaN(at) || at > this.store.now() + MAX_SNOOZE_MS) throw new OrcoError('invalid', 'Snooze until a time in the next two weeks');
    this.store.db
      .prepare('INSERT INTO snoozes (participant_id, key, until) VALUES (?, ?, ?) ON CONFLICT (participant_id, key) DO UPDATE SET until = excluded.until')
      .run(actor.id, key, new Date(at).toISOString());
  }

  /** The person's snoozes still running, by item key. */
  snoozes(actor: Participant): Record<string, string> {
    const now = new Date(this.store.now()).toISOString();
    this.store.db.prepare('DELETE FROM snoozes WHERE until <= ?').run(now);
    const rows = this.store.db.prepare('SELECT key, until FROM snoozes WHERE participant_id = ?').all(actor.id) as { key: string; until: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.until]));
  }

  /** A mention opened (or acted on): handled, while the others stay unread. */
  markSeen(actor: Participant, messageId: number): void {
    this.store.db.prepare('INSERT OR IGNORE INTO mention_seen (participant_id, message_id) VALUES (?, ?)').run(actor.id, messageId);
  }

  isSeen(actor: Participant, messageId: number): boolean {
    return this.store.db.prepare('SELECT 1 FROM mention_seen WHERE participant_id = ? AND message_id = ?').get(actor.id, messageId) !== undefined;
  }

  /** The digest as it would read now: what waits on the person, and what agents finished for them. */
  digest(actor: Participant, sinceIso?: string): Digest {
    const work = myWork(this.store, actor);
    const waiting = work.next.filter((line) => !line.startsWith('Nothing is waiting'));
    const since = sinceIso ?? new Date(this.store.now() - 24 * 3600_000).toISOString();
    const done = (
      this.store.db
        .prepare(
          `SELECT count(*) AS n FROM tasks t JOIN participants rq ON rq.id = t.requester_id
           WHERE t.state = 'done' AND t.updated_at >= ? AND (t.requester_id = ? OR rq.owner_id = ?)`,
        )
        .get(since, actor.id, actor.id) as { n: number }
    ).n;
    return {
      bullets: waiting.slice(0, DIGEST_BULLETS),
      more: Math.max(0, waiting.length - DIGEST_BULLETS),
      finished: done ? `Agents finished ${done} task${done === 1 ? '' : 's'} for you.` : null,
      link: '/#!needs',
      at: new Date(this.store.now()).toISOString(),
    };
  }

  /** The digest sent today (or the last one), for the top of Needs you. */
  latest(actor: Participant): Digest | null {
    const row = this.store.db.prepare('SELECT body FROM person_digests WHERE participant_id = ? ORDER BY id DESC LIMIT 1').get(actor.id) as { body: string } | undefined;
    if (!row) return null;
    const digest = JSON.parse(row.body) as Digest;
    return Date.parse(digest.at) > this.store.now() - 20 * 3600_000 ? digest : null;
  }

  /** Sends due digests (the once-a-minute sweep): weekdays at each person's time; nothing when nothing waits. */
  sendDue(): number {
    const people = this.store.db
      .prepare("SELECT id FROM participants WHERE kind = 'user' AND system = 0 AND digest_time IS NOT NULL")
      .all() as { id: number }[];
    let sent = 0;
    for (const { id } of people) {
      const person = this.store.participantById(id)!;
      const row = this.row(person);
      const local = localNow(this.store.now(), row.tz);
      if (local.weekday === 0 || local.weekday === 6 || local.time < row.digest_time! || row.digest_last === local.date) continue;
      const last = this.store.db.prepare('SELECT created_at FROM person_digests WHERE participant_id = ? ORDER BY id DESC LIMIT 1').get(id) as { created_at: string } | undefined;
      this.store.db.prepare('UPDATE participants SET digest_last = ? WHERE id = ?').run(local.date, id);
      const digest = this.digest(person, last?.created_at);
      if (digest.bullets.length === 0) continue;
      this.store.db.prepare('INSERT INTO person_digests (participant_id, body, created_at) VALUES (?, ?, ?)').run(id, JSON.stringify(digest), digest.at);
      this.store.events.emit('digest', { participantId: id, digest });
      sent++;
    }
    return sent;
  }

  private row(actor: Participant): SettingsRow {
    return this.store.db.prepare('SELECT notify_level, quiet_start, quiet_end, tz, digest_time, digest_last FROM participants WHERE id = ?').get(actor.id) as unknown as SettingsRow;
  }
}
