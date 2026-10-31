import { OrcoError } from './errors.js';
import { roomMatcher } from './rooms.js';
import type { Participant, Store } from './store.js';
import { OPEN_STATES } from './tasks.js';

export interface WaitConditions {
  /** Wake when a ticket is done (completed or canceled) or no longer blocked. */
  tickets?: { ref: string; until: 'done' | 'unblocked' }[];
  /** Wake when a task closes (done, failed, declined or cancelled). */
  tasks?: number[];
  /** Wake when a lock is free. */
  locks?: { project: string; name: string }[];
  /** Also wake on an unseen mention (it stays unseen). */
  mentions?: boolean;
  /** Wake on a new message in rooms matching these patterns (ops/*, or a * project with an alerts room), after a message id (default: now). */
  rooms?: { patterns: string[]; afterId?: number };
}

export interface WaitResult {
  fired: string[];
  timedOut: boolean;
  /** With rooms: the new messages' ids, oldest first. */
  messages?: number[];
}

const RECHECK_MS = 5_000;
const MAX_CONDITIONS = 20;

/**
 * Waits until any condition holds, re-checking on ticket, task, lock and mention events (and every
 * few seconds, since locks also free up by expiring). Returns at once if one already holds.
 */
export async function waitFor(store: Store, actor: Participant, conditions: WaitConditions, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
  const tickets = conditions.tickets ?? [];
  const tasks = conditions.tasks ?? [];
  const locks = conditions.locks ?? [];
  const rooms = conditions.rooms ? roomMatcher(conditions.rooms.patterns) : null;
  const roomsAfter = conditions.rooms?.afterId ?? store.latestMessageId();
  if (tickets.length + tasks.length + locks.length === 0 && !conditions.mentions && !rooms) {
    throw new OrcoError('invalid', 'Give at least one ticket, task, lock, room or mentions to wait for');
  }
  let newMessages: number[] = [];
  if (tickets.length + tasks.length + locks.length > MAX_CONDITIONS) throw new OrcoError('invalid', `Wait for at most ${MAX_CONDITIONS} things at once`);
  // Check everything once up front, so a bad ref fails now instead of after the wait.
  for (const t of tickets) {
    store.tickets.get(actor, t.ref);
    if (t.until !== 'done' && t.until !== 'unblocked') throw new OrcoError('invalid', 'Wait until a ticket is "done" or "unblocked"');
  }
  for (const id of tasks) store.tasks.get(actor, id);
  for (const l of locks) store.visibleProject(actor, l.project);

  const check = (): string[] => {
    const fired: string[] = [];
    for (const t of tickets) {
      const ticket = store.tickets.get(actor, t.ref);
      const done = ticket.status.category === 'completed' || ticket.status.category === 'canceled';
      if (t.until === 'done' && done) fired.push(`${ticket.ref} is ${ticket.status.name}`);
      if (t.until === 'unblocked' && !ticket.blocked) fired.push(`${ticket.ref} is no longer blocked`);
    }
    for (const id of tasks) {
      const task = store.tasks.get(actor, id);
      if (!OPEN_STATES.includes(task.state)) fired.push(`Task #${id} is ${task.state}`);
    }
    for (const l of locks) {
      if (!store.locks.list(actor, l.project).some((held) => held.name === l.name)) fired.push(`Lock ${l.name} in ${l.project} is free`);
    }
    if (conditions.mentions && store.unseenMentions(actor).length > 0) fired.push('You have unseen mentions; read them with wait_for_mentions');
    if (rooms) {
      const fresh = store.messagesAfter(actor, roomsAfter, 200).filter((m) => rooms.room(m.room));
      if (fresh.length) {
        newMessages = fresh.map((m) => m.id);
        const where = [...new Set(fresh.map((m) => m.room))].join(', ');
        fired.push(`${fresh.length} new message${fresh.length === 1 ? '' : 's'} in ${where}`);
      }
    }
    return fired;
  };

  const result = (fired: string[], timedOut: boolean): WaitResult => (rooms && !timedOut ? { fired, timedOut, messages: newMessages } : { fired, timedOut });
  const now = check();
  if (now.length > 0 || timeoutMs <= 0) return result(now, now.length === 0);
  return new Promise<WaitResult>((resolve) => {
    const events = ['ticket', 'task', 'lock', `mention:${actor.id}`, ...(rooms ? ['message'] : [])];
    let pending: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: WaitResult) => {
      clearTimeout(timer);
      clearInterval(poll);
      if (pending) clearTimeout(pending);
      for (const event of events) store.events.off(event, onEvent);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const recheck = () => {
      pending = null;
      try {
        const fired = check();
        if (fired.length > 0) finish(result(fired, false));
      } catch {
        // Lost access mid-wait (removed from a project); report it as a wake-up with nothing fired.
        finish({ fired: ['Something you were waiting on is no longer visible to you'], timedOut: false });
      }
    };
    // Events come in bursts; check once per burst, after the change has settled.
    const onEvent = () => {
      if (!pending) pending = setTimeout(recheck, 50);
    };
    const onAbort = () => finish({ fired: [], timedOut: true });
    const timer = setTimeout(() => finish({ fired: [], timedOut: true }), timeoutMs);
    const poll = setInterval(recheck, RECHECK_MS);
    for (const event of events) store.events.on(event, onEvent);
    signal?.addEventListener('abort', onAbort);
  });
}
