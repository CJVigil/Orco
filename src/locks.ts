import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

export interface Lock {
  project: string;
  projectId: number;
  name: string;
  holder: string;
  holderKind: 'user' | 'agent';
  holderOwner: string | null;
  fence: number;
  note: string | null;
  acquiredAt: string;
  expiresAt: string;
}

interface LockRow {
  project_id: number;
  project: string;
  name: string;
  holder_id: number | null;
  holder: string | null;
  holder_kind: 'user' | 'agent' | null;
  holder_owner_id: number | null;
  holder_owner: string | null;
  fence: number;
  note: string | null;
  acquired_at: number | null;
  expires_at: number | null;
}

const LOCK_SELECT = `
  SELECT l.project_id, p.name AS project, l.name, l.holder_id, h.name AS holder, h.kind AS holder_kind,
         h.owner_id AS holder_owner_id, ho.name AS holder_owner, l.fence, l.note, l.acquired_at, l.expires_at
  FROM locks l
  JOIN projects p ON p.id = l.project_id
  LEFT JOIN participants h ON h.id = l.holder_id
  LEFT JOIN participants ho ON ho.id = h.owner_id
`;

const LOCK_NAME = /^[a-z0-9][a-z0-9:._/-]{0,63}$/;
export const MIN_TTL_SECONDS = 10;
export const MAX_TTL_SECONDS = 24 * 3600;
const MAX_NOTE = 500;

function toLock(row: LockRow): Lock {
  return {
    project: row.project,
    projectId: row.project_id,
    name: row.name,
    holder: row.holder!,
    holderKind: row.holder_kind!,
    holderOwner: row.holder_owner,
    fence: row.fence,
    note: row.note,
    acquiredAt: new Date(row.acquired_at!).toISOString(),
    expiresAt: new Date(row.expires_at!).toISOString(),
  };
}

function checkTtl(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
    throw new OrcoError('invalid', `Lock TTL must be ${MIN_TTL_SECONDS}-${MAX_TTL_SECONDS} seconds`);
  }
}

export class Locks {
  constructor(private readonly store: Store) {}

  acquire(actor: Participant, project: string, name: string, ttlSeconds = 300, note?: string): Lock {
    this.store.writableProject(actor, project);
    if (!LOCK_NAME.test(name)) {
      throw new OrcoError('invalid', 'Lock name must be 1-64 lowercase letters, digits or ":._/-", like "deploy:prod"');
    }
    checkTtl(ttlSeconds);
    const trimmedNote = note?.trim().slice(0, MAX_NOTE) || null;
    const { id: projectId } = this.store.visibleProject(actor, project);
    const now = this.store.now();
    const current = this.row(projectId, name);

    if (current && this.isHeld(current, now) && current.holder_id !== actor.id) {
      const lock = toLock(current);
      throw new OrcoError(
        'conflict',
        `${name} is held by ${lock.holder}${lock.holderOwner ? ` (${lock.holderOwner}'s agent)` : ''} until ${lock.expiresAt}` +
          (lock.note ? `: ${lock.note}` : ''),
      );
    }

    if (current && this.isHeld(current, now)) {
      this.store.db
        .prepare('UPDATE locks SET expires_at = ?, note = coalesce(?, note) WHERE project_id = ? AND name = ?')
        .run(now + ttlSeconds * 1000, trimmedNote, projectId, name);
    } else {
      this.store.db
        .prepare(
          `INSERT INTO locks (project_id, name, holder_id, fence, note, acquired_at, expires_at)
           VALUES (?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT (project_id, name) DO UPDATE SET
             holder_id = excluded.holder_id, fence = locks.fence + 1, note = excluded.note,
             acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
        )
        .run(projectId, name, actor.id, trimmedNote, now, now + ttlSeconds * 1000);
    }
    const lock = this.changed(projectId, name);
    this.store.audit.record(actor, 'lock.acquire', {
      projectId,
      subject: `lock:${name}`,
      detail: { fence: lock.fence, expiresAt: lock.expiresAt, note: lock.note },
    });
    return lock;
  }

  async acquireWaiting(
    actor: Participant,
    project: string,
    name: string,
    ttlSeconds: number,
    note: string | undefined,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<Lock> {
    const deadline = this.store.now() + waitMs;
    for (;;) {
      try {
        return this.acquire(actor, project, name, ttlSeconds, note);
      } catch (err) {
        const remaining = deadline - this.store.now();
        if (!(err instanceof OrcoError) || err.code !== 'conflict' || remaining <= 0 || signal?.aborted) throw err;
        const expiresIn = this.expiresIn(project, name, actor);
        await this.nextChange(Math.min(remaining, Math.max(expiresIn, 0) + 50), signal);
      }
    }
  }

  renew(actor: Participant, project: string, name: string, ttlSeconds = 300): Lock {
    checkTtl(ttlSeconds);
    const { id: projectId } = this.store.visibleProject(actor, project);
    const current = this.row(projectId, name);
    if (!current || !this.isHeld(current, this.store.now()) || current.holder_id !== actor.id) {
      throw new OrcoError('conflict', `You do not hold ${name}; acquire it again`);
    }
    this.store.db
      .prepare('UPDATE locks SET expires_at = ? WHERE project_id = ? AND name = ?')
      .run(this.store.now() + ttlSeconds * 1000, projectId, name);
    const lock = this.changed(projectId, name);
    this.store.audit.record(actor, 'lock.renew', { projectId, subject: `lock:${name}`, detail: { expiresAt: lock.expiresAt } });
    return lock;
  }

  release(actor: Participant, project: string, name: string, force = false): void {
    const { id: projectId } = this.store.visibleProject(actor, project);
    const current = this.row(projectId, name);
    if (!current || !this.isHeld(current, this.store.now())) return;
    const ownHold = current.holder_id === actor.id || current.holder_owner_id === actor.id;
    if (!ownHold && !(force && actor.kind === 'user' && !actor.scope)) {
      throw new OrcoError(
        'forbidden',
        `${name} is held by ${current.holder}. Only its holder, the holder's owner, or a human using force can release it.`,
      );
    }
    // Taking someone else's lock is a change to the project: people with read-only access cannot.
    if (!ownHold) this.store.assertWrite(actor, projectId);
    this.store.db
      .prepare('UPDATE locks SET holder_id = NULL, note = NULL, expires_at = NULL WHERE project_id = ? AND name = ?')
      .run(projectId, name);
    this.store.audit.record(actor, ownHold ? 'lock.release' : 'lock.force_release', {
      projectId,
      subject: `lock:${name}`,
      detail: { holder: current.holder, fence: current.fence },
    });
    if (!ownHold) {
      this.store.post(actor, `${project}/general`, `Force-released lock ${name}, which was held by @${current.holder}.`, undefined, {
        skipRateLimit: true,
      });
    }
    this.store.events.emit('lock', { projectId, name });
  }

  list(actor: Participant, project?: string): Lock[] {
    const now = this.store.now();
    const projectId = project === undefined ? undefined : this.store.visibleProject(actor, project).id;
    const rows = this.store.db
      .prepare(`${LOCK_SELECT} WHERE l.holder_id IS NOT NULL AND l.expires_at > ? ${projectId ? 'AND l.project_id = ?' : ''} ORDER BY p.name, l.name`)
      .all(...(projectId ? [now, projectId] : [now])) as unknown as LockRow[];
    return rows.filter((row) => this.store.canSee(actor, row.project_id)).map(toLock);
  }

  private expiresIn(project: string, name: string, actor: Participant): number {
    const { id } = this.store.visibleProject(actor, project);
    const row = this.row(id, name);
    return row?.expires_at ? row.expires_at - this.store.now() : 0;
  }

  private nextChange(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.store.events.off('lock', done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.store.events.on('lock', done);
      signal?.addEventListener('abort', done);
    });
  }

  private isHeld(row: LockRow, now: number): boolean {
    return row.holder_id !== null && row.expires_at !== null && row.expires_at > now;
  }

  private row(projectId: number, name: string): LockRow | undefined {
    return this.store.db.prepare(`${LOCK_SELECT} WHERE l.project_id = ? AND l.name = ?`).get(projectId, name) as
      | LockRow
      | undefined;
  }

  private changed(projectId: number, name: string): Lock {
    const lock = toLock(this.row(projectId, name)!);
    this.store.events.emit('lock', { projectId, name });
    return lock;
  }
}
