import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { searchAll } from '../src/search.js';
import { migrate, readAll } from '../src/storage/migrate.js';
import { openStorage } from '../src/storage/open.js';
import { SyncRemote } from '../src/storage/remote.js';
import { counts } from '../src/storage/snapshot.js';
import { describeTarget, parseTarget, type Target, targetFromEnv } from '../src/storage/target.js';
import { type OrcoError, Store } from '../src/store.js';

/*
 * Storage on SQLite, PostgreSQL and MongoDB (#148). The PostgreSQL and MongoDB cases run when
 * ORCO_TEST_POSTGRES_URL and ORCO_TEST_MONGO_URL point at servers (CI starts both); each case uses a
 * schema or database of its own and empties it first.
 */
const dir = () => mkdtempSync(join(tmpdir(), 'orco-storage-'));
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as OrcoError).code;
  }
  return null;
};

/** A database with some of everything: people, an agent, a project, tickets, comments, a file, messages. */
function seed(store: Store) {
  const ana = store.createUser('ana').participant;
  store.createAgent('ana', 'ana-claude');
  store.createProject(ana, 'api');
  store.tickets.create(ana, 'api', { title: 'Checkout: refunds post twice', description: 'Seen on staging' });
  store.tickets.create(ana, 'api', { title: 'Search: slow on big rooms' });
  store.tickets.comment(ana, 'API-1', 'Reproduced with two clicks');
  store.post(ana, 'api/general', 'The refunds fix needs a migration');
  store.files.write(ana, 'api', 'docs/plan.md', 'Ship the refund fix first', {});
  // Binary data: a 1x1 PNG.
  store.attachments.upload(ana, 'api/general', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), 'dot.png');
  store.db.prepare('DELETE FROM messages WHERE id = (SELECT max(id) FROM messages)').run();
  store.post(ana, 'api/general', 'Après the fix: emoji 🎉');
  return ana;
}

function checkSearch(store: Store) {
  const ana = store.participantByName('ana')!;
  // By part of its ref, and by part of its title (the trigram index came back with the rows).
  assert.ok(searchAll(store, ana, 'API-1').some((h) => h.kind === 'ticket'), 'finds a ticket by its ref');
  assert.ok(searchAll(store, ana, 'refunds post').some((h) => h.kind === 'ticket' && /refunds post twice/.test(h.title ?? '')), 'finds a ticket by part of its title');
}

const remoteUrls: [string, string | undefined][] = [
  ['postgres', process.env.ORCO_TEST_POSTGRES_URL],
  ['mongo', process.env.ORCO_TEST_MONGO_URL],
];

let n = 0;
/** An empty schema (PostgreSQL) or database (MongoDB) of its own. */
function fresh(url: string): Target {
  const base = parseTarget(url);
  const name = `orco_storage_${process.pid}_${n++}`;
  const t: Target = base.kind === 'postgres' ? { ...base, schema: name } : base.kind === 'mongo' ? { ...base, database: name } : base;
  if (t.kind !== 'sqlite') {
    const r = new SyncRemote(t);
    r.call('reset');
    r.close();
  }
  return t;
}

describe('where the data lives (#148)', () => {
  it('reads --db, ORCO_DB and ORCO_DATABASE_URL, and hides passwords', () => {
    assert.deepEqual(parseTarget('./orco.db'), { kind: 'sqlite', path: './orco.db' });
    assert.deepEqual(parseTarget('sqlite:data/o.db'), { kind: 'sqlite', path: 'data/o.db' });
    assert.equal(parseTarget('postgresql://u:p@h/db').kind, 'postgres');
    assert.equal(parseTarget('mongodb+srv://h/db').kind, 'mongo');
    assert.equal(code(() => parseTarget('mysql://h/db')), 'invalid');
    assert.deepEqual(targetFromEnv(undefined, {}), { kind: 'sqlite', path: './orco.db' });
    assert.deepEqual(targetFromEnv(undefined, { ORCO_DB: '/data/orco.db' }), { kind: 'sqlite', path: '/data/orco.db' });
    assert.equal(targetFromEnv(undefined, { ORCO_DB: 'postgres', ORCO_DATABASE_URL: 'postgres://u:p@db/orco' }).kind, 'postgres');
    assert.equal(targetFromEnv(undefined, { ORCO_DATABASE_URL: 'mongodb://db/orco' }).kind, 'mongo');
    assert.equal(code(() => targetFromEnv(undefined, { ORCO_DB: 'mongo' })), 'invalid');
    assert.equal(code(() => targetFromEnv(undefined, { ORCO_DB: 'mongo', ORCO_DATABASE_URL: 'postgres://db/orco' })), 'invalid');
    assert.equal(targetFromEnv('other.db', { ORCO_DATABASE_URL: 'mongodb://db/orco' }).kind, 'sqlite', '--db wins');
    assert.equal(describeTarget(parseTarget('postgres://orco:hunter2@db:5432/orco')), 'postgres://orco:***@db:5432/orco');
  });

  it('copies a SQLite database to a new file with every row, refuses one that holds data, and search still works', () => {
    const d = dir();
    const src = openDatabase(join(d, 'a.db'));
    seed(new Store(src));
    src.close();
    const result = migrate(parseTarget(join(d, 'a.db')), parseTarget(join(d, 'b.db')));
    assert.ok(result.rows > 20);
    assert.deepEqual(counts(readAll(parseTarget(join(d, 'b.db')))), result.tables);
    assert.equal(code(() => migrate(parseTarget(join(d, 'a.db')), parseTarget(join(d, 'b.db')))), 'conflict');
    assert.equal(migrate(parseTarget(join(d, 'a.db')), parseTarget(join(d, 'b.db')), { dryRun: true }).dryRun, true);
    migrate(parseTarget(join(d, 'a.db')), parseTarget(join(d, 'b.db')), { force: true });
    const copy = new Store(openDatabase(join(d, 'b.db')));
    checkSearch(copy);
    assert.equal(copy.tickets.get(copy.participantByName('ana')!, 'API-2').title, 'Search: slow on big rooms');
    // Ticket numbering carries on from where it was.
    assert.equal(copy.tickets.create(copy.participantByName('ana')!, 'api', { title: 'Docs: one more' }).ticket.ref, 'API-3');
  });

  for (const [kind, url] of remoteUrls) {
    describe(kind, { skip: url ? false : `set ORCO_TEST_${kind.toUpperCase()}_URL to run` }, () => {
      it('starts empty, keeps every write, and comes back the same after a restart', () => {
        const target = fresh(url!);
        let s = openStorage(target);
        let store = new Store(s.db);
        seed(store);
        const before = counts(readAll(target));
        s.close();
        s = openStorage(target);
        store = new Store(s.db);
        checkSearch(store);
        const msgs = store.db.prepare('SELECT text FROM messages ORDER BY id').all() as { text: string }[];
        assert.equal(msgs.at(-1)!.text, 'Après the fix: emoji 🎉');
        const png = store.db.prepare('SELECT data FROM attachments LIMIT 1').get() as { data: Uint8Array };
        assert.equal(Buffer.from(png.data).toString('base64'), 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
        assert.ok(searchAll(store, store.participantByName('ana')!, 'refund fix first').some((h) => h.kind === 'file'), 'project files come back searchable');
        assert.deepEqual(counts(readAll(target)), before);
        // A rolled-back transaction leaves nothing behind.
        store.db.exec('BEGIN');
        store.db.prepare("UPDATE participants SET name = 'nobody' WHERE name = 'ana'").run();
        store.db.exec('ROLLBACK');
        store.db.prepare("UPDATE tickets SET title = 'Checkout: refunds post twice (again)' WHERE title = 'Checkout: refunds post twice'").run();
        s.close();
        const again = readAll(target);
        assert.deepEqual(counts(again), before);
        const tickets = again.data.find((t) => t.name === 'tickets')!;
        const title = tickets.columns.findIndex((c) => c.name === 'title') + 1;
        assert.ok(tickets.rows.some((r) => r[title] === 'Checkout: refunds post twice (again)'));
      });

      it('refuses to start on a copy that has not finished', () => {
        const target = fresh(url!);
        const r = new SyncRemote(target as Exclude<Target, { kind: 'sqlite' }>);
        r.call('setMeta', 'migration', { source: 'x.db', done: [] });
        r.close();
        assert.equal(code(() => openStorage(target)), 'conflict');
      });
    });
  }

  it('moves SQLite to PostgreSQL to MongoDB and back with every count matching', { skip: remoteUrls.every(([, u]) => u) ? false : 'needs both ORCO_TEST_POSTGRES_URL and ORCO_TEST_MONGO_URL' }, () => {
    const d = dir();
    const start = openDatabase(join(d, 'start.db'));
    seed(new Store(start));
    start.close();
    const pg = fresh(process.env.ORCO_TEST_POSTGRES_URL!);
    const mg = fresh(process.env.ORCO_TEST_MONGO_URL!);
    const want = migrate(parseTarget(join(d, 'start.db')), pg).tables;
    for (const [from, to] of [
      [pg, mg],
      [mg, parseTarget(join(d, 'end.db'))],
    ] as [Target, Target][]) {
      assert.deepEqual(migrate(from, to).tables, want);
    }
    assert.equal(code(() => migrate(pg, mg)), 'conflict', 'a target that holds data is refused');
    // Back to PostgreSQL from MongoDB over what is there, and the server starts on each.
    migrate(mg, pg, { force: true });
    for (const t of [pg, mg, parseTarget(join(d, 'end.db'))]) {
      const s = openStorage(t);
      const store = new Store(s.db);
      checkSearch(store);
      assert.deepEqual(counts(readAll(t)), want);
      s.close();
    }
  });

  it('resumes a copy that stopped part way', { skip: process.env.ORCO_TEST_POSTGRES_URL ? false : 'needs ORCO_TEST_POSTGRES_URL' }, () => {
    const d = dir();
    const start = openDatabase(join(d, 'start.db'));
    seed(new Store(start));
    start.close();
    const pg = fresh(process.env.ORCO_TEST_POSTGRES_URL!) as Extract<Target, { kind: 'postgres' }>;
    const source = parseTarget(join(d, 'start.db'));
    migrate(source, pg);
    // Pretend it stopped after the first two tables.
    const r = new SyncRemote(pg);
    const snap = readAll(source);
    r.call('setMeta', 'migration', { source: describeTarget(source), done: snap.data.slice(0, 2).map((t) => t.name) });
    r.close();
    const lines: string[] = [];
    const result = migrate(source, pg, { log: (l) => lines.push(l) });
    assert.equal(result.resumed, true);
    assert.ok(lines.some((l) => /Resuming: 2 of/.test(l)));
    assert.deepEqual(counts(readAll(pg)), result.tables);
  });
});
