import type { Change, Schema, Snapshot, TableData, Value } from './snapshot.js';
import { affinity, quoteIdent as q } from './snapshot.js';
import type { Target } from './target.js';

/*
 * PostgreSQL and MongoDB as places to keep Orco's tables (#148). These run in a worker thread (see
 * remote.ts) and are async; the server talks to them through a synchronous bridge.
 *
 * Each Orco table is a PostgreSQL table with the same columns (plus __rowid as the key), or a MongoDB
 * collection with one document per row (_id is the rowid). Schema version, CREATE statements and
 * counters live in orco_meta. Writes arrive as changes (rows to upsert, rowids to delete) and are
 * applied in one transaction.
 */
export interface Backend {
  /** The stored schema and every row, or null for an empty database. */
  read(): Promise<Snapshot | null>;
  /** Replaces everything with the snapshot (schema upgrades, first start, migration). */
  writeAll(snap: Snapshot): Promise<void>;
  /** For orco migrate: the schema first, then one table at a time, so a stopped copy can resume. */
  writeSchema(schema: Schema, sequence: [string, number][]): Promise<void>;
  writeTable(table: TableData): Promise<void>;
  apply(changes: Change[], sequence: [string, number][] | null): Promise<void>;
  /** Rows per table, and whether there is any Orco data at all. */
  counts(): Promise<Record<string, number> | null>;
  /** Drops every Orco table: for tests and orco migrate --force only. */
  reset(): Promise<void>;
  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
  close(): Promise<void>;
}

/* PostgreSQL */

// PostgreSQL text cannot hold NUL characters; a string with one is stored JSON-encoded behind this marker.
const NUL_MARK = '\u0001orco-json:';

function pgType(sqliteType: string): string {
  if (/BLOB/i.test(sqliteType)) return 'bytea';
  switch (affinity(sqliteType)) {
    case 'integer':
      return 'bigint';
    case 'real':
      return 'double precision';
    case 'text':
      return 'text';
    default:
      // No fixed type in SQLite (BLOB/NUMERIC affinity): keep the value and its type as JSON.
      return 'jsonb';
  }
}

function toPg(value: Value, type: string): unknown {
  if (value === null || value === undefined) return null;
  const t = pgType(type);
  if (t === 'jsonb') {
    if (value instanceof Uint8Array) return JSON.stringify({ $b64: Buffer.from(value).toString('base64') });
    return JSON.stringify(typeof value === 'bigint' ? Number(value) : value);
  }
  if (t === 'bytea') return value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value));
  if (value instanceof Uint8Array) return NUL_MARK + JSON.stringify({ $b64: Buffer.from(value).toString('base64') });
  if (t === 'text' && typeof value === 'string' && (value.includes('\u0000') || value.startsWith(NUL_MARK))) return NUL_MARK + JSON.stringify(value);
  if ((t === 'bigint' || t === 'double precision') && typeof value === 'string') throw new Error(`A ${t} column was given the text ${JSON.stringify(value.slice(0, 40))}`);
  return typeof value === 'bigint' ? value.toString() : value;
}

function fromPg(value: unknown, type: string): Value {
  if (value === null || value === undefined) return null;
  const t = pgType(type);
  if (t === 'jsonb') {
    const v = value as unknown;
    if (v && typeof v === 'object' && '$b64' in (v as object)) return new Uint8Array(Buffer.from((v as { $b64: string }).$b64, 'base64'));
    return v as Value;
  }
  if (t === 'bigint') return Number(value);
  if (typeof value === 'string' && value.startsWith(NUL_MARK)) {
    const v = JSON.parse(value.slice(NUL_MARK.length)) as unknown;
    return v && typeof v === 'object' ? new Uint8Array(Buffer.from((v as { $b64: string }).$b64, 'base64')) : (v as string);
  }
  if (value instanceof Buffer) return new Uint8Array(value);
  return value as Value;
}

export async function postgres(target: Extract<Target, { kind: 'postgres' }>): Promise<Backend> {
  const { default: pg } = await import('pg');
  // bigint (int8) comes back as a string by default; Orco's numbers fit in a double.
  pg.types.setTypeParser(20, (v: string) => Number(v));
  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  if (target.schema) {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${q(target.schema)}`);
    await client.query(`SET search_path TO ${q(target.schema)}`);
  }
  await client.query('CREATE TABLE IF NOT EXISTS orco_meta (key text PRIMARY KEY, value jsonb NOT NULL)');

  const getMeta = async (key: string) => ((await client.query('SELECT value FROM orco_meta WHERE key = $1', [key])).rows[0]?.value ?? null) as unknown;
  const setMeta = async (key: string, value: unknown) => {
    if (value === null) await client.query('DELETE FROM orco_meta WHERE key = $1', [key]);
    else await client.query('INSERT INTO orco_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
  };
  const tx = async <T>(fn: () => Promise<T>): Promise<T> => {
    await client.query('BEGIN');
    try {
      const r = await fn();
      await client.query('COMMIT');
      return r;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  };
  const tableName = (t: string) => q(`orco_${t}`);
  const columnsByTable = new Map<string, Schema['tables'][number]['columns']>();
  const remember = (schema: Schema | null) => {
    columnsByTable.clear();
    for (const t of schema?.tables ?? []) columnsByTable.set(t.name, t.columns);
  };

  const insert = async (table: string, rows: Value[][], upsert: boolean) => {
    const cols = columnsByTable.get(table);
    if (!cols) throw new Error(`No table ${table} in the stored schema`);
    const names = ['__rowid', ...cols.map((c) => c.name)];
    const per = names.length;
    const batch = Math.max(1, Math.floor(30000 / per));
    for (let i = 0; i < rows.length; i += batch) {
      const chunk = rows.slice(i, i + batch);
      const params: unknown[] = [];
      const tuples = chunk.map((row, r) => {
        params.push(Number(row[0]), ...cols.map((c, j) => toPg(row[j + 1] ?? null, c.type)));
        return `(${names.map((_, j) => `$${r * per + j + 1}`).join(', ')})`;
      });
      const conflict = upsert ? ` ON CONFLICT (__rowid) DO UPDATE SET ${cols.map((c) => `${q(c.name)} = excluded.${q(c.name)}`).join(', ') || '__rowid = excluded.__rowid'}` : '';
      await client.query(`INSERT INTO ${tableName(table)} (${names.map(q).join(', ')}) VALUES ${tuples.join(', ')}${conflict}`, params);
    }
  };

  const createTables = async (schema: Schema) => {
    const old = ((await getMeta('schema')) as Schema | null)?.tables ?? [];
    for (const t of old) await client.query(`DROP TABLE IF EXISTS ${tableName(t.name)}`);
    for (const t of schema.tables) {
      await client.query(`DROP TABLE IF EXISTS ${tableName(t.name)}`);
      await client.query(`CREATE TABLE ${tableName(t.name)} (__rowid bigint PRIMARY KEY${t.columns.map((c) => `, ${q(c.name)} ${pgType(c.type)}`).join('')})`);
    }
    await setMeta('schema', schema);
    remember(schema);
  };

  remember((await getMeta('schema')) as Schema | null);

  const backend: Backend = {
    async read() {
      const schema = (await getMeta('schema')) as Schema | null;
      if (!schema) return null;
      remember(schema);
      const data: TableData[] = [];
      for (const t of schema.tables) {
        const res = await client.query({ text: `SELECT ${['__rowid', ...t.columns.map((c) => c.name)].map(q).join(', ')} FROM ${tableName(t.name)} ORDER BY __rowid`, rowMode: 'array' });
        data.push({ name: t.name, columns: t.columns, rows: (res.rows as unknown[][]).map((r) => [Number(r[0]), ...t.columns.map((c, j) => fromPg(r[j + 1], c.type))]) });
      }
      return { ...schema, data, sequence: ((await getMeta('sequence')) as [string, number][] | null) ?? [] };
    },
    async writeAll(snap) {
      await tx(async () => {
        await createTables(snap);
        for (const t of snap.data) await insert(t.name, t.rows, false);
        await setMeta('sequence', snap.sequence);
      });
    },
    async writeSchema(schema, sequence) {
      await tx(async () => {
        await createTables(schema);
        await setMeta('sequence', sequence);
      });
    },
    async writeTable(table) {
      await tx(async () => {
        await client.query(`DELETE FROM ${tableName(table.name)}`);
        await insert(table.name, table.rows, false);
      });
    },
    async apply(changes, sequence) {
      await tx(async () => {
        for (const c of changes) {
          if (c.deletes.length) await client.query(`DELETE FROM ${tableName(c.table)} WHERE __rowid = ANY($1::bigint[])`, [c.deletes]);
          if (c.upserts.length) await insert(c.table, c.upserts, true);
        }
        if (sequence) await setMeta('sequence', sequence);
      });
    },
    async counts() {
      const schema = (await getMeta('schema')) as Schema | null;
      if (!schema) return null;
      const out: Record<string, number> = {};
      for (const t of schema.tables) out[t.name] = Number((await client.query(`SELECT count(*) AS n FROM ${tableName(t.name)}`)).rows[0].n);
      return out;
    },
    async reset() {
      if (target.schema) {
        await client.query(`DROP SCHEMA IF EXISTS ${q(target.schema)} CASCADE`);
        await client.query(`CREATE SCHEMA ${q(target.schema)}`);
      } else {
        for (const t of ((await getMeta('schema')) as Schema | null)?.tables ?? []) await client.query(`DROP TABLE IF EXISTS ${tableName(t.name)}`);
        await client.query('DROP TABLE IF EXISTS orco_meta');
      }
      await client.query('CREATE TABLE IF NOT EXISTS orco_meta (key text PRIMARY KEY, value jsonb NOT NULL)');
      remember(null);
    },
    getMeta,
    setMeta,
    async close() {
      await client.end();
    },
  };
  return backend;
}

/* MongoDB */

export async function mongo(target: Extract<Target, { kind: 'mongo' }>): Promise<Backend> {
  const { MongoClient, Binary } = await import('mongodb');
  const client = new MongoClient(target.url, { ignoreUndefined: true });
  await client.connect();
  const db = client.db(target.database);
  const meta = db.collection<{ _id: string; value: unknown }>('orco_meta');
  const hello = (await db.admin().command({ hello: 1 })) as { setName?: string; msg?: string };
  // Multi-document transactions need a replica set (a single-node one is fine).
  const transactions = Boolean(hello.setName || hello.msg === 'isdbgrid');
  // Tables live in generation-numbered collections (orco_<gen>_<table>). A full rewrite fills a new
  // generation and then switches orco_meta to it in one write, so a rewrite that stops halfway never
  // loses the data that was there.
  let gen = 0;
  const coll = (t: string, g = gen) => db.collection<Record<string, unknown>>(`orco_${g}_${t}`);
  const columnsByTable = new Map<string, Schema['tables'][number]['columns']>();
  const remember = (schema: (Schema & { gen?: number }) | null) => {
    columnsByTable.clear();
    for (const t of schema?.tables ?? []) columnsByTable.set(t.name, t.columns);
    gen = schema?.gen ?? 0;
  };

  const getMeta = async (key: string) => (await meta.findOne({ _id: key }))?.value ?? null;
  const setMeta = async (key: string, value: unknown, session?: import('mongodb').ClientSession) => {
    if (value === null) await meta.deleteOne({ _id: key }, { session });
    else await meta.updateOne({ _id: key }, { $set: { value } }, { upsert: true, session });
  };
  const toDoc = (table: string, row: Value[]) => {
    const cols = columnsByTable.get(table);
    if (!cols) throw new Error(`No table ${table} in the stored schema`);
    const doc: Record<string, unknown> = { _id: Number(row[0]) };
    cols.forEach((c, j) => {
      const v = row[j + 1] ?? null;
      doc[c.name] = v instanceof Uint8Array ? new Binary(v) : typeof v === 'bigint' ? Number(v) : v;
    });
    return doc;
  };
  const fromDoc = (cols: Schema['tables'][number]['columns'], d: Record<string, unknown>): Value[] => [
    Number(d._id),
    ...cols.map((c) => {
      const v = d[c.name];
      if (v === undefined || v === null) return null;
      if (v instanceof Binary) return new Uint8Array(v.buffer);
      return v as Value;
    }),
  ];
  const withTx = async (fn: (session?: import('mongodb').ClientSession) => Promise<void>) => {
    if (!transactions) return fn();
    const session = client.startSession();
    try {
      await session.withTransaction(() => fn(session));
    } finally {
      await session.endSession();
    }
  };
  const insertAll = async (table: string, rows: Value[][], g = gen) => {
    for (let i = 0; i < rows.length; i += 1000) await coll(table, g).insertMany(rows.slice(i, i + 1000).map((r) => toDoc(table, r)), { ordered: true });
  };
  /** Collections of generations other than the current one: leftovers of an old or interrupted rewrite. */
  const dropOtherGenerations = async () => {
    for (const c of await db.listCollections({}, { nameOnly: true }).toArray()) {
      const m = /^orco_(\d+)_/.exec(c.name);
      if (m && Number(m[1]) !== gen) await db.collection(c.name).drop().catch(() => undefined);
    }
  };
  /** Starts a new generation with the schema's collections; switched to by switchTo. */
  const newGeneration = async (schema: Schema) => {
    const current = (await getMeta('schema')) as (Schema & { gen?: number }) | null;
    const next = Math.max(current?.gen ?? 0, gen, Number((await getMeta('pending_gen')) ?? 0)) + 1;
    await setMeta('pending_gen', next);
    // Collections appear with their first row (MongoDB 4.4 and later create them inside transactions).
    for (const t of schema.tables) await coll(t.name, next).drop().catch(() => undefined);
    for (const t of schema.tables) columnsByTable.set(t.name, t.columns);
    return next;
  };
  const switchTo = async (schema: Schema, next: number) => {
    await setMeta('schema', { ...schema, gen: next });
    await setMeta('pending_gen', null);
    remember({ ...schema, gen: next });
    await dropOtherGenerations();
  };

  remember((await getMeta('schema')) as (Schema & { gen?: number }) | null);

  return {
    async read() {
      const schema = (await getMeta('schema')) as Schema | null;
      if (!schema) return null;
      remember(schema);
      const data: TableData[] = [];
      for (const t of schema.tables) data.push({ name: t.name, columns: t.columns, rows: (await coll(t.name).find({}).sort({ _id: 1 }).toArray()).map((d) => fromDoc(t.columns, d)) });
      return { ...schema, data, sequence: ((await getMeta('sequence')) as [string, number][] | null) ?? [] };
    },
    async writeAll(snap) {
      const schema: Schema = { version: snap.version, ddl: snap.ddl, tables: snap.tables };
      const next = await newGeneration(schema);
      for (const t of snap.data) await insertAll(t.name, t.rows, next);
      await setMeta('sequence', snap.sequence);
      await switchTo(schema, next);
    },
    async writeSchema(schema, sequence) {
      await switchTo(schema, await newGeneration(schema));
      await setMeta('sequence', sequence);
    },
    async writeTable(table) {
      await coll(table.name).deleteMany({});
      await insertAll(table.name, table.rows);
    },
    async apply(changes, sequence) {
      await withTx(async (session) => {
        for (const c of changes) {
          const ops = [
            ...c.deletes.map((id) => ({ deleteOne: { filter: { _id: id } } })),
            ...c.upserts.map((r) => {
              const doc = toDoc(c.table, r);
              return { replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } };
            }),
          ];
          if (ops.length) await coll(c.table).bulkWrite(ops as never, { session, ordered: true });
        }
        if (sequence) await setMeta('sequence', sequence, session);
      });
    },
    async counts() {
      const schema = (await getMeta('schema')) as Schema | null;
      if (!schema) return null;
      const out: Record<string, number> = {};
      for (const t of schema.tables) out[t.name] = await coll(t.name).countDocuments();
      return out;
    },
    async reset() {
      for (const c of await db.listCollections({}, { nameOnly: true }).toArray()) if (c.name.startsWith('orco_')) await db.collection(c.name).drop().catch(() => undefined);
      remember(null);
    },
    getMeta,
    setMeta: (k, v) => setMeta(k, v),
    async close() {
      await client.close();
    },
  };
}

export async function openBackend(target: Exclude<Target, { kind: 'sqlite' }>): Promise<Backend> {
  return target.kind === 'postgres' ? postgres(target) : mongo(target);
}
