import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OrcoError } from './errors.js';

const NAME = /^orco-(\d{8}-\d{6})\.db$/;

/** Filesystems where SQLite's locking (and WAL's shared memory) cannot be trusted. */
const NETWORK_FILESYSTEMS = new Set(['fuse.glusterfs', 'glusterfs', 'nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', 'fuse.sshfs', 'fuse.s3fs', 'fuse.rclone', 'ceph', 'fuse.ceph', '9p', 'fuse.juicefs']);

/** Writes a consistent copy of the live database to `file`. Safe while the server is running. */
export function backupTo(db: DatabaseSync, file: string): void {
  if (existsSync(file)) throw new OrcoError('conflict', `${file} already exists; pick a new file name`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/**
 * Backups on a schedule: every `everyHours`, a consistent copy of the database is written to `dir`
 * (named orco-YYYYMMDD-HHMMSS.db, written under a temporary name and renamed when complete), and all
 * but the newest `keep` are removed. Point `dir` at network storage (Gluster, NFS) to survive losing
 * the node; the live database itself belongs on local disk.
 */
export class Backups {
  constructor(
    private readonly db: DatabaseSync,
    private readonly options: { dir: string; everyHours: number; keep: number; now?: () => number; log?: (message: string) => void },
  ) {
    if (!Number.isFinite(options.everyHours) || options.everyHours <= 0) throw new OrcoError('invalid', 'ORCO_BACKUP_HOURS must be more than 0');
    if (!Number.isInteger(options.keep) || options.keep < 1) throw new OrcoError('invalid', 'ORCO_BACKUP_KEEP must be at least 1');
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  list(): { file: string; at: number; size: number }[] {
    if (!existsSync(this.options.dir)) return [];
    return readdirSync(this.options.dir)
      .filter((name) => NAME.test(name))
      .map((name) => {
        const file = join(this.options.dir, name);
        return { file, at: statSync(file).mtimeMs, size: statSync(file).size };
      })
      .sort((a, b) => b.file.localeCompare(a.file));
  }

  /** Writes a backup if the newest is older than the interval (or there is none). Returns its path. */
  runIfDue(): string | null {
    const newest = this.list()[0];
    if (newest && this.now() - newest.at < this.options.everyHours * 3600_000) return null;
    return this.run();
  }

  run(): string {
    mkdirSync(this.options.dir, { recursive: true });
    const file = join(this.options.dir, `orco-${stamp(this.now())}.db`);
    const partial = `${file}.partial`;
    rmSync(partial, { force: true });
    backupTo(this.db, partial);
    renameSync(partial, file);
    for (const old of this.list().slice(this.options.keep)) rmSync(old.file, { force: true });
    this.options.log?.(`Backed up the database to ${file}`);
    return file;
  }
}

/**
 * Replaces the database at `target` with a backup, after checking the backup is a sound Orco
 * database. The server must be stopped. The database it replaces is kept beside it.
 */
export function restore(backup: string, target: string, options: { force?: boolean; now?: number } = {}): { replaced: string | null } {
  const now = options.now ?? Date.now();
  if (!existsSync(backup)) throw new OrcoError('not_found', `No file ${backup}`);
  const check = new DatabaseSync(backup, { readOnly: true });
  try {
    const result = check.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (result.integrity_check !== 'ok') throw new OrcoError('invalid', `${backup} is damaged: ${result.integrity_check}`);
    const tables = check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'participants'").get();
    if (!tables) throw new OrcoError('invalid', `${backup} is not an Orco database`);
  } finally {
    check.close();
  }
  // A database another process is writing has a WAL or journal beside it; refuse rather than corrupt it.
  for (const suffix of ['-wal', '-journal']) {
    const side = `${target}${suffix}`;
    if (!options.force && existsSync(side) && statSync(side).size > 0) {
      throw new OrcoError('conflict', `${side} is in use; stop the Orco server before restoring (after a crash, --force restores anyway)`);
    }
  }
  let replaced: string | null = null;
  if (existsSync(target)) {
    replaced = `${target}.before-restore-${stamp(now)}`;
    renameSync(target, replaced);
  }
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${target}${suffix}`, { force: true });
  mkdirSync(dirname(resolve(target)), { recursive: true });
  // VACUUM INTO writes a clean, compact copy of the backup at the target.
  const source = new DatabaseSync(backup, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  return { replaced };
}

/** The filesystem type holding `path`, from /proc/mounts (Linux only; null elsewhere). */
export function filesystemOf(path: string, mounts = readMounts()): string | null {
  // Mount tables are a Linux thing, and their paths are POSIX paths.
  const full = posix.resolve(path);
  let best: { point: string; type: string } | null = null;
  for (const line of mounts.split('\n')) {
    const [, point, type] = line.split(' ');
    if (!point || !type) continue;
    const mount = point.replace(/\\040/g, ' ');
    const inside = full === mount || full.startsWith(mount.endsWith('/') ? mount : `${mount}/`);
    if (inside && (!best || mount.length > best.point.length)) best = { point: mount, type };
  }
  return best?.type ?? null;
}

function readMounts(): string {
  try {
    return readFileSync('/proc/mounts', 'utf8');
  } catch {
    return '';
  }
}

/** A warning when the live database sits on a network filesystem, where SQLite can corrupt silently. */
export function networkFilesystemWarning(dbPath: string, mounts?: string): string | null {
  if (dbPath === ':memory:') return null;
  const type = filesystemOf(posix.dirname(posix.resolve(dbPath)), mounts);
  if (!type || !NETWORK_FILESYSTEMS.has(type)) return null;
  return (
    `WARNING: the database ${dbPath} is on a ${type} filesystem. SQLite's locking is not reliable there and the ` +
    'database can be corrupted without any error. Keep the live database on local disk, and point ORCO_BACKUP_DIR ' +
    '(or Litestream) at the network storage instead. See docs/deploy.md#storage.'
  );
}
