import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { restore } from './backups.js';
import { MIGRATIONS } from './db.js';
import { OrcoError } from './errors.js';
import { migrate } from './storage/migrate.js';
import { parseTarget, type Target } from './storage/target.js';

/*
 * Seeding an empty server from a backup over HTTPS (#149), for hosts where nobody has a shell, only a
 * deploy tool's Environment field and Deploy button. Off unless ORCO_RESTORE_TOKEN is set.
 *
 * POST /api/admin/restore with the .db bytes and the token is accepted only while the server has no
 * participants, so it can never overwrite a board in use. The upload is checked like orco restore
 * (integrity, an Orco database, not newer than this build), saved as a pending file, and the server
 * exits; at the next start, before the database opens, the pending file is restored and removed. That
 * relies on the container's restart policy.
 */
export const PENDING_NAME = 'pending-restore.db';

export function pendingFile(dir: string): string {
  return join(dir, PENDING_NAME);
}

/** Compares a presented token with the configured one without leaking either through timing. */
export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** Checks a backup file is a sound Orco database this build can open; throws why not. */
export function checkBackup(file: string): { version: number; participants: number } {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    throw new OrcoError('invalid', 'That is not a SQLite database');
  }
  try {
    let integrity: string;
    try {
      integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    } catch {
      throw new OrcoError('invalid', 'That is not a SQLite database');
    }
    if (integrity !== 'ok') throw new OrcoError('invalid', `The backup is damaged: ${integrity}`);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'participants'").get()) throw new OrcoError('invalid', 'That is not an Orco database');
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version > MIGRATIONS.length) throw new OrcoError('invalid', `The backup is from a newer Orco (schema ${version}; this one has ${MIGRATIONS.length}). Upgrade this server first.`);
    const { n } = db.prepare('SELECT count(*) AS n FROM participants').get() as { n: number };
    return { version, participants: Number(n) };
  } finally {
    db.close();
  }
}

/** Saves a checked upload as the pending restore. The caller has already made sure the server is empty. */
export function acceptUpload(dir: string, bytes: Buffer): { version: number; participants: number } {
  if (!bytes.length) throw new OrcoError('invalid', 'Send the .db file as the request body');
  mkdirSync(dir, { recursive: true });
  const pending = pendingFile(dir);
  const partial = `${pending}.partial`;
  rmSync(partial, { force: true });
  writeFileSync(partial, bytes, { mode: 0o600 });
  try {
    const info = checkBackup(partial);
    renameSync(partial, pending);
    return info;
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
}

/**
 * At start, before the database opens: restores a pending upload, if there is one, keeping the old
 * database beside it (SQLite) or replacing the PostgreSQL or MongoDB data. A failed restore is kept as
 * <name>.failed and the server starts on the database it had.
 */
export function applyPending(dir: string, target: Target, log: (line: string) => void): boolean {
  const pending = pendingFile(dir);
  if (!existsSync(pending)) return false;
  try {
    checkBackup(pending);
    if (target.kind === 'sqlite') {
      // Nothing has the database open yet: this runs before the server opens it.
      const { replaced } = restore(pending, target.path, { force: true });
      log(`Restored the uploaded backup into ${target.path}${replaced ? `; the database it replaced is at ${replaced}` : ''}.`);
    } else {
      migrate(parseTarget(pending), target, { force: true });
      log(`Restored the uploaded backup into the ${target.kind} database.`);
    }
    rmSync(pending);
    return true;
  } catch (err) {
    const failed = `${pending}.failed`;
    rmSync(failed, { force: true });
    renameSync(pending, failed);
    log(`Could not restore the uploaded backup (${(err as Error).message}); it is at ${failed}. Starting on the database as it was.`);
    return false;
  }
}

/** orco push-restore: uploads a backup and waits for the server to come back with it. */
export async function pushRestore(file: Buffer, url: string, token: string, log: (line: string) => void, fetchImpl: typeof fetch = fetch, waitSeconds = 180): Promise<void> {
  const base = url.replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/api/admin/restore`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: new Uint8Array(file) });
  const body = (await res.json().catch(() => ({}))) as { error?: string; participants?: number };
  if (res.status === 404) throw new OrcoError('not_found', 'The server does not take restores: set ORCO_RESTORE_TOKEN on it and redeploy (or check the address)');
  if (!res.ok) throw new OrcoError(res.status === 409 ? 'conflict' : res.status === 403 ? 'forbidden' : 'invalid', body.error ?? `The server answered ${res.status}`);
  log(`Uploaded (${body.participants ?? '?'} people and agents in the backup). The server is restarting to restore it…`);
  const started = Date.now();
  let wentDown = false;
  while (Date.now() - started < waitSeconds * 1000) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const h = await fetchImpl(`${base}/healthz`);
      const { uptimeSeconds } = (await h.json()) as { uptimeSeconds?: number };
      // Back up, and started after the upload: the restore ran.
      if (h.ok && (wentDown || (uptimeSeconds !== undefined && uptimeSeconds * 1000 < Date.now() - started))) {
        log('The server is back with the restored board. Now unset ORCO_RESTORE_TOKEN and redeploy.');
        return;
      }
    } catch {
      wentDown = true;
    }
  }
  throw new OrcoError('invalid', `The server did not come back within ${waitSeconds}s. Check that it restarts on exit (restart: unless-stopped) and read its log.`);
}
