import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OrcoError } from '../errors.js';
import { SyncRemote } from './remote.js';
import { counts, loadSnapshot, readSnapshot, type Snapshot } from './snapshot.js';
import { describeTarget, type Target } from './target.js';

/*
 * orco migrate --from <db> --to <db> (#148): copies everything (ids, ticket refs, versions, history,
 * files) between any two of SQLite, PostgreSQL and MongoDB. It refuses a target that already holds
 * Orco data, resumes a copy that stopped (one table at a time, progress kept in the target), and
 * checks the rows of every table at the end. Stop the server first: the copy is of the moment it reads.
 */
export interface MigrateOptions {
  dryRun?: boolean;
  /** Empty a target that already holds Orco data first. */
  force?: boolean;
  log?: (line: string) => void;
}

export interface MigrateResult {
  tables: Record<string, number>;
  rows: number;
  resumed: boolean;
  dryRun: boolean;
}

function readSqlite(path: string): Snapshot {
  if (!existsSync(path)) throw new OrcoError('not_found', `No SQLite database at ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return readSnapshot(db);
  } finally {
    db.close();
  }
}

/** Every row of an Orco database, wherever it is. */
export function readAll(target: Target): Snapshot {
  if (target.kind === 'sqlite') return readSqlite(target.path);
  const remote = new SyncRemote(target);
  try {
    const snap = remote.call('read');
    if (!snap) throw new OrcoError('not_found', `${describeTarget(target)} holds no Orco data`);
    return snap;
  } finally {
    remote.close();
  }
}

function sqliteHasData(path: string): boolean {
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get());
  } finally {
    db.close();
  }
}

function check(expected: Record<string, number>, actual: Record<string, number> | null): void {
  const wrong = Object.entries(expected).filter(([t, n]) => (actual?.[t] ?? 0) !== n);
  if (wrong.length) throw new OrcoError('conflict', `Row counts differ after the copy: ${wrong.map(([t, n]) => `${t} ${actual?.[t] ?? 0} of ${n}`).join(', ')}`);
}

export function migrate(from: Target, to: Target, options: MigrateOptions = {}): MigrateResult {
  const log = options.log ?? (() => undefined);
  if (from.kind === to.kind && JSON.stringify(from) === JSON.stringify(to)) throw new OrcoError('invalid', 'The source and the target are the same database');
  log(`Reading ${describeTarget(from)}…`);
  const snap = readAll(from);
  const tables = counts(snap);
  const rows = Object.values(tables).reduce((a, b) => a + b, 0);
  const source = describeTarget(from);
  log(`Schema ${snap.version}, ${snap.data.length} tables, ${rows} rows.`);

  if (to.kind === 'sqlite') {
    const exists = sqliteHasData(to.path);
    if (options.dryRun) {
      log(`Dry run: would write ${to.path}${exists ? ' (it already holds data: add --force to replace it)' : ''}.`);
      return { tables, rows, resumed: false, dryRun: true };
    }
    if (exists && !options.force) throw new OrcoError('conflict', `${to.path} already holds an Orco database; pick a new file or add --force`);
    // Written to a new file and renamed into place: a stopped copy leaves nothing half-written.
    const partial = `${to.path}.partial`;
    rmSync(partial, { force: true });
    const db = new DatabaseSync(partial);
    try {
      loadSnapshot(db, snap);
      check(tables, counts(readSnapshot(db)));
    } finally {
      db.close();
    }
    for (const suffix of ['-wal', '-shm']) rmSync(`${to.path}${suffix}`, { force: true });
    renameSync(partial, to.path);
    log(`Wrote ${to.path}.`);
    return { tables, rows, resumed: false, dryRun: false };
  }

  const remote = new SyncRemote(to);
  try {
    const progress = remote.call('getMeta', 'migration') as { source: string; done: string[] } | null;
    const existing = remote.call('counts');
    const resumable = Boolean(progress && progress.source === source && existing);
    if (options.dryRun) {
      log(
        `Dry run: would copy into ${describeTarget(to)}${
          resumable ? `, resuming (${progress!.done.length} of ${snap.data.length} tables done)` : existing ? ' (it already holds Orco data: add --force to replace it)' : ''
        }.`,
      );
      return { tables, rows, resumed: resumable, dryRun: true };
    }
    if (existing && !resumable && !options.force) {
      throw new OrcoError('conflict', `${describeTarget(to)} already holds Orco data${progress ? ` (a copy from ${progress.source} that did not finish)` : ''}; empty it, or add --force to replace it`);
    }
    const done = new Set(resumable ? progress!.done : []);
    if (!resumable) {
      if (existing) remote.call('reset');
      remote.call('setMeta', 'migration', { source, done: [] });
      remote.call('writeSchema', { version: snap.version, ddl: snap.ddl, tables: snap.tables }, snap.sequence);
    } else log(`Resuming: ${done.size} of ${snap.data.length} tables were copied before.`);
    for (const t of snap.data) {
      if (done.has(t.name)) continue;
      remote.call('writeTable', t);
      done.add(t.name);
      remote.call('setMeta', 'migration', { source, done: [...done] });
      if (t.rows.length) log(`  ${t.name}: ${t.rows.length}`);
    }
    check(tables, remote.call('counts'));
    remote.call('setMeta', 'migration', null);
    log(`Copied into ${describeTarget(to)}; every table's rows match.`);
    return { tables, rows, resumed: resumable, dryRun: false };
  } finally {
    remote.close();
  }
}

/** A copy of the database with the backend's own tool: pg_dump (custom format) or mongodump (gzipped archive). */
export function nativeBackup(target: Exclude<Target, { kind: 'sqlite' }>, file: string): string {
  if (existsSync(file)) throw new OrcoError('conflict', `${file} already exists; pick a new file name`);
  const url = new URL(target.url);
  if (target.kind === 'postgres') {
    // The password goes in the environment, never on the command line where ps shows it.
    const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
    url.password = '';
    const args = ['--format=custom', `--file=${file}`, ...(target.schema ? [`--schema=${target.schema}`] : []), `--dbname=${url.toString()}`];
    const r = spawnSync('pg_dump', args, { env, encoding: 'utf8', shell: false });
    if (r.error) throw new OrcoError('invalid', `pg_dump is not installed here (${r.error.message}); install the PostgreSQL client, or back up to a SQLite file with orco backup <file>.db`);
    if (r.status !== 0) throw new OrcoError('invalid', `pg_dump failed: ${r.stderr.trim()}`);
    return 'pg_restore';
  }
  // mongodump reads the address (with its password) from a private config file, not the command line.
  const dir = mkdtempSync(join(tmpdir(), 'orco-mongodump-'));
  try {
    const config = join(dir, 'config.yaml');
    writeFileSync(config, `uri: ${JSON.stringify(target.url)}\n`, { mode: 0o600 });
    const r = spawnSync('mongodump', [`--config=${config}`, `--archive=${file}`, '--gzip', ...(target.database ? [`--db=${target.database}`] : [])], { encoding: 'utf8', shell: false });
    if (r.error) throw new OrcoError('invalid', `mongodump is not installed here (${r.error.message}); install the MongoDB database tools, or back up to a SQLite file with orco backup <file>.db`);
    if (r.status !== 0) throw new OrcoError('invalid', `mongodump failed: ${r.stderr.trim().split('\n').pop()}`);
    return 'mongorestore';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
