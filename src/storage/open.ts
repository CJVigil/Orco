import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { OrcoError } from '../errors.js';
import { migrate, openDatabase, type OpenOptions } from '../db.js';
import { SyncRemote } from './remote.js';
import { type Change, columnsOf, dataTables, loadSnapshot, quoteIdent as q, readRows, readSequence, readSnapshot } from './snapshot.js';
import { describeTarget, parseTarget, type Target } from './target.js';

/*
 * Opening Orco's storage (#148).
 *
 * SQLite: the file, as always.
 *
 * PostgreSQL and MongoDB: the data lives there, table for table. At start Orco reads it all into an
 * in-memory SQLite database, which runs every query exactly as before (search included), and every
 * change is written through to the remote database before the statement that made it returns: rows a
 * statement or transaction touched are noted by triggers and sent in one remote transaction when it
 * commits. Two consequences, both documented in docs/deploy.md: one Orco server per database (a
 * second server would not see the first one's writes), and the data has to fit in memory.
 */
export interface Storage {
  db: DatabaseSync;
  target: Target;
  /** Writes anything not yet written through, then closes the connection. */
  close(): void;
}

const remotes = new WeakMap<DatabaseSync, Replicator>();

/** Opens Orco's database wherever it is. */
export function openStorage(target: Target, options: OpenOptions = {}): Storage {
  if (target.kind === 'sqlite') {
    const db = openDatabase(target.path, options);
    return { db, target, close: () => db.close() };
  }
  const remote = new SyncRemote(target);
  try {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    const unfinished = remote.call('getMeta', 'migration') as { source: string } | null;
    if (unfinished) throw new OrcoError('conflict', `A copy into ${describeTarget(target)} from ${unfinished.source} has not finished; run the same orco migrate again to finish it`);
    const snap = remote.call('read');
    if (snap) loadSnapshot(db, snap);
    const before = snap?.version ?? 0;
    const ran = migrate(db);
    if (!snap || ran) {
      if (snap && ran) options.log?.(`Upgrading the ${target.kind} database ${describeTarget(target)} from schema ${before} by ${ran} step${ran === 1 ? '' : 's'}.`);
      remote.call('writeAll', readSnapshot(db));
    }
    const replicator = new Replicator(db, remote);
    remotes.set(db, replicator);
    return { db, target, close: () => db.close() };
  } catch (err) {
    remote.close();
    throw err;
  }
}

let scratch = 0;
/**
 * For running the test suite on PostgreSQL or MongoDB (ORCO_TEST_DATABASE_URL): every in-memory
 * database the tests open gets its own empty schema or database, reused in rotation.
 */
export function openScratch(url: string): DatabaseSync {
  const base = parseTarget(url);
  const name = `orco_test_${process.pid}_${scratch++ % 40}`;
  if (base.kind === 'sqlite') return openDatabase(':memory:');
  const target: Target = base.kind === 'postgres' ? { ...base, schema: name } : { ...base, database: name };
  const remote = new SyncRemote(target);
  remote.call('reset');
  remote.close();
  return openStorage(target).db;
}

/** The remote connection behind an in-memory database, if it has one (used by orco backup). */
export function remoteOf(db: DatabaseSync): SyncRemote | null {
  return remotes.get(db)?.remote ?? null;
}

class Replicator {
  private pending = new Map<string, Set<number>>();
  private readonly autoincrement: Set<string>;
  private flushing = false;
  private readonly columns = new Map<string, ReturnType<typeof columnsOf>>();

  constructor(
    private readonly db: DatabaseSync,
    readonly remote: SyncRemote,
  ) {
    const tables = dataTables(db);
    this.autoincrement = new Set(tables.filter((t) => /AUTOINCREMENT/i.test((db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(t) as { sql: string }).sql)));
    db.function('orco_changed', { deterministic: false, directOnly: false }, (table, rowid) => {
      const t = String(table);
      let set = this.pending.get(t);
      if (!set) this.pending.set(t, (set = new Set()));
      set.add(Number(rowid));
      return null;
    });
    // Temporary triggers: they note changed rows for this connection and are never stored.
    for (const t of tables) {
      const name = (op: string) => q(`orco_changed_${t}_${op}`);
      const lit = `'${t.replace(/'/g, "''")}'`;
      db.exec(`
        CREATE TEMP TRIGGER ${name('i')} AFTER INSERT ON main.${q(t)} BEGIN SELECT orco_changed(${lit}, NEW.rowid); END;
        CREATE TEMP TRIGGER ${name('u')} AFTER UPDATE ON main.${q(t)} BEGIN SELECT orco_changed(${lit}, OLD.rowid); SELECT orco_changed(${lit}, NEW.rowid); END;
        CREATE TEMP TRIGGER ${name('d')} AFTER DELETE ON main.${q(t)} BEGIN SELECT orco_changed(${lit}, OLD.rowid); END;
      `);
    }
    this.wrap();
    // Closing the database writes what is left, then closes the remote connection.
    const close = db.close.bind(db);
    db.close = () => {
      try {
        this.flush();
      } finally {
        this.remote.close();
        close();
      }
    };
  }

  /** After every statement outside a transaction, and at COMMIT, the changed rows go to the remote database. */
  private wrap(): void {
    const db = this.db;
    const after = () => {
      if (this.pending.size && !db.isTransaction) this.flush();
    };
    const exec = db.exec.bind(db);
    db.exec = (sql: string) => {
      exec(sql);
      after();
    };
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const stmt = prepare(sql);
      for (const method of ['run', 'get', 'all'] as const) {
        const original = (stmt[method] as (...a: unknown[]) => unknown).bind(stmt);
        (stmt as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
          const result = original(...args);
          after();
          return result;
        };
      }
      return stmt as StatementSync;
    };
  }

  flush(): void {
    if (this.flushing || !this.pending.size) return;
    this.flushing = true;
    const pending = this.pending;
    this.pending = new Map();
    try {
      const changes: Change[] = [];
      let sequence = false;
      for (const [table, ids] of pending) {
        const rowids = [...ids];
        let columns = this.columns.get(table);
        if (!columns) this.columns.set(table, (columns = columnsOf(this.db, table)));
        const upserts = [];
        for (let i = 0; i < rowids.length; i += 500) upserts.push(...readRows(this.db, table, columns, rowids.slice(i, i + 500)));
        const present = new Set(upserts.map((r) => Number(r[0])));
        changes.push({ table, upserts, deletes: rowids.filter((id) => !present.has(id)) });
        if (this.autoincrement.has(table)) sequence = true;
      }
      this.remote.call('apply', changes, sequence ? readSequence(this.db) : null);
    } catch (err) {
      // Not written: keep the rows so the next write sends them again.
      for (const [table, ids] of pending) {
        const set = this.pending.get(table) ?? new Set<number>();
        for (const id of ids) set.add(id);
        this.pending.set(table, set);
      }
      throw err;
    } finally {
      this.flushing = false;
    }
  }
}
