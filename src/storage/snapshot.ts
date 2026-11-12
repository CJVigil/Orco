import type { DatabaseSync } from 'node:sqlite';

/*
 * A whole Orco database as plain data (#148): its schema (the CREATE statements, in order), its schema
 * version, every row of every table keyed by rowid, and the AUTOINCREMENT counters. Every backend can
 * read and write one, which is how data moves between SQLite, PostgreSQL and MongoDB.
 *
 * Derived tables are left out: the search index (an FTS5 virtual table and its shadow tables) is
 * rebuilt by its triggers as the rows go back in, so search works after any move.
 */
export type Value = string | number | bigint | Uint8Array | null;

export interface Column {
  name: string;
  /** The declared SQLite type, which backends map to their own types. */
  type: string;
}

export interface TableData {
  name: string;
  columns: Column[];
  /** Each row is [rowid, ...values in column order]. */
  rows: Value[][];
}

export interface Schema {
  version: number;
  /** CREATE statements for tables, indexes, triggers and virtual tables, in creation order. */
  ddl: string[];
  tables: { name: string; columns: Column[] }[];
}

export interface Snapshot extends Schema {
  data: TableData[];
  sequence: [string, number][];
}

export interface Change {
  table: string;
  upserts: Value[][];
  deletes: number[];
}

/** The column's SQLite type affinity (https://sqlite.org/datatype3.html#determination_of_column_affinity). */
export function affinity(type: string): 'integer' | 'text' | 'blob' | 'real' | 'numeric' {
  const t = type.toUpperCase();
  if (t.includes('INT')) return 'integer';
  if (/CHAR|CLOB|TEXT/.test(t)) return 'text';
  if (t === '' || t.includes('BLOB')) return 'blob';
  if (/REAL|FLOA|DOUB/.test(t)) return 'real';
  return 'numeric';
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
export { quote as quoteIdent };

/** The tables that hold data: not SQLite's own, not virtual tables, not their shadow tables. */
export function dataTables(db: DatabaseSync): string[] {
  const all = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { name: string; sql: string }[];
  const virtual = all.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql)).map((t) => t.name);
  return all.filter((t) => !virtual.includes(t.name) && !virtual.some((v) => t.name.startsWith(`${v}_`))).map((t) => t.name);
}

export function columnsOf(db: DatabaseSync, table: string): Column[] {
  const cols = db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all() as { name: string; type: string; hidden: number }[];
  return cols.filter((c) => c.hidden === 0).map((c) => ({ name: c.name, type: c.type }));
}

export function readSchema(db: DatabaseSync): Schema {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const tables = dataTables(db);
  const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as {
    type: string;
    name: string;
    tbl_name: string;
    sql: string;
  }[];
  const all = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as { name: string; sql: string | null }[];
  const virtual = all.filter((t) => t.sql && /^CREATE VIRTUAL TABLE/i.test(t.sql)).map((t) => t.name);
  const shadow = (name: string) => virtual.some((v) => name.startsWith(`${v}_`));
  const ddl = objects.filter((o) => !(o.type === 'table' && shadow(o.name)) && !(o.type === 'index' && shadow(o.tbl_name))).map((o) => o.sql);
  return { version, ddl, tables: tables.map((name) => ({ name, columns: columnsOf(db, name) })) };
}

export function readRows(db: DatabaseSync, table: string, columns: Column[], rowids?: number[]): Value[][] {
  const list = columns.map((c) => quote(c.name)).join(', ');
  const sql = `SELECT rowid AS "__rowid", ${list} FROM ${quote(table)}${rowids ? ` WHERE rowid IN (${rowids.map(() => '?').join(', ')})` : ''} ORDER BY rowid`;
  const stmt = db.prepare(sql);
  stmt.setReturnArrays?.(true);
  const rows = (rowids ? stmt.all(...rowids) : stmt.all()) as unknown as Value[][] | Record<string, Value>[];
  return rows.map((r) => (Array.isArray(r) ? r : [r.__rowid!, ...columns.map((c) => (r as Record<string, Value>)[c.name] ?? null)]));
}

export function readSequence(db: DatabaseSync): [string, number][] {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get();
  if (!has) return [];
  return (db.prepare('SELECT name, seq FROM sqlite_sequence').all() as { name: string; seq: number }[]).map((r) => [r.name, Number(r.seq)]);
}

export function readSnapshot(db: DatabaseSync): Snapshot {
  const schema = readSchema(db);
  return { ...schema, data: schema.tables.map((t) => ({ name: t.name, columns: t.columns, rows: readRows(db, t.name, t.columns) })), sequence: readSequence(db) };
}

/** Creates the schema in an empty database. Search triggers come with it, so loading rows fills the index. */
export function createSchema(db: DatabaseSync, schema: Schema): void {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    for (const sql of schema.ddl) db.exec(sql);
    db.exec(`PRAGMA user_version = ${Math.trunc(schema.version)}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function insertRows(db: DatabaseSync, table: string, columns: Column[], rows: Value[][]): void {
  if (!rows.length) return;
  const stmt = db.prepare(`INSERT INTO ${quote(table)} (rowid, ${columns.map((c) => quote(c.name)).join(', ')}) VALUES (${['?', ...columns.map(() => '?')].join(', ')})`);
  for (const row of rows) stmt.run(...(row as (string | number | bigint | Uint8Array | null)[]));
}

export function writeSequence(db: DatabaseSync, sequence: [string, number][]): void {
  if (!sequence.length) return;
  for (const [name, seq] of sequence) {
    const updated = db.prepare('UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?').run(seq, name);
    if (!Number(updated.changes)) db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(name, seq);
  }
}

/** Puts a snapshot into an empty database: schema, rows (filling the search index), counters. */
export function loadSnapshot(db: DatabaseSync, snap: Snapshot): void {
  createSchema(db, snap);
  db.exec('BEGIN');
  try {
    for (const t of snap.data) insertRows(db, t.name, t.columns, t.rows);
    writeSequence(db, snap.sequence);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function counts(snap: Pick<Snapshot, 'data'>): Record<string, number> {
  return Object.fromEntries(snap.data.map((t) => [t.name, t.rows.length]));
}
