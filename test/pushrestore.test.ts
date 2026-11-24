import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { backupAsIs } from '../src/backups.js';
import { MIGRATIONS, openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { applyPending, pendingFile, pushRestore } from '../src/pushrestore.js';
import { parseTarget } from '../src/storage/target.js';
import { Store } from '../src/store.js';

/* Seeding an empty server from a backup over HTTPS (#149). */
const TOKEN = 'restore-token-for-tests-0123456789';

/** A board with tickets, comments and history, saved as a .db file. */
function board(dir: string): string {
  const store = new Store(openDatabase(join(dir, 'source.db')));
  const ana = store.createUser('ana').participant;
  store.createProject(ana, 'api');
  for (let i = 1; i <= 12; i++) store.tickets.create(ana, 'api', { title: `Area: ticket ${i}` });
  store.tickets.comment(ana, 'API-12', 'The one people cite in commits');
  store.tickets.update(ana, 'API-12', { status: 'In Progress' });
  const file = join(dir, 'board.db');
  store.db.exec(`VACUUM INTO '${file}'`);
  store.db.close();
  return file;
}

async function serve(store: Store, restore?: { dir: string; onAccepted: () => void }) {
  const { app, close } = createApp(store, restore ? { restore: { token: TOKEN, ...restore } } : {});
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    post: (body: Buffer | string, token = TOKEN) => fetch(`${base}/api/admin/restore`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: typeof body === 'string' ? body : new Uint8Array(body) }),
    stop: async () => {
      server.closeAllConnections();
      server.close();
      await close();
    },
  };
}

describe('restore over HTTPS (#149)', () => {
  it('is not there unless ORCO_RESTORE_TOKEN is set', async (t) => {
    t.mock.method(console, 'log', () => {});
    const dir = mkdtempSync(join(tmpdir(), 'orco-push-'));
    const s = await serve(new Store(openDatabase(':memory:')));
    try {
      const res = await s.post(readFileSync(board(dir)));
      assert.equal(res.status, 404);
      assert.equal(existsSync(pendingFile(dir)), false);
    } finally {
      await s.stop();
    }
  });

  it('refuses a wrong token, a server with people on it, and a file that is not an Orco database, and logs each without the token', async (t) => {
    const logged: string[] = [];
    t.mock.method(console, 'log', (m: string) => logged.push(m));
    const dir = mkdtempSync(join(tmpdir(), 'orco-push-'));
    const file = readFileSync(board(dir));
    let restarts = 0;
    const empty = new Store(openDatabase(':memory:'));
    const s = await serve(empty, { dir, onAccepted: () => restarts++ });
    try {
      assert.equal((await s.post(file, 'wrong')).status, 403);
      assert.equal((await s.post('not a database')).status, 400);
      const plain = new DatabaseSync(join(dir, 'plain.db'));
      plain.exec('CREATE TABLE x (y)');
      plain.close();
      const notOrco = await s.post(readFileSync(join(dir, 'plain.db')));
      assert.equal(notOrco.status, 400);
      assert.match(((await notOrco.json()) as { error: string }).error, /not an Orco database/);
      const other = openDatabase(':memory:');
      other.exec(`VACUUM INTO '${join(dir, 'orco-but-newer.db')}'`);
      const newer = openDatabase(join(dir, 'orco-but-newer.db'));
      newer.exec('PRAGMA user_version = 9999');
      newer.close();
      const res = await s.post(readFileSync(join(dir, 'orco-but-newer.db')));
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, /newer Orco/);
      empty.createUser('someone');
      const busy = await s.post(file);
      assert.equal(busy.status, 409);
      assert.equal(existsSync(pendingFile(dir)), false, 'nothing saved');
      assert.equal(restarts, 0);
      assert.ok(logged.filter((l) => /refused/.test(l)).length >= 4);
      assert.ok(logged.every((l) => !l.includes(TOKEN)), 'the token is never logged');
    } finally {
      await s.stop();
    }
  });

  it('saves the upload, restarts, and the next start brings the board back with the same numbers and history', async (t) => {
    t.mock.method(console, 'log', () => {});
    const dir = mkdtempSync(join(tmpdir(), 'orco-push-'));
    const file = board(dir);
    const live = join(dir, 'live.db');
    let accepted = false;
    const running = new Store(openDatabase(live));
    const s = await serve(running, { dir, onAccepted: () => (accepted = true) });
    try {
      const res = await s.post(readFileSync(file));
      assert.equal(res.status, 202);
      assert.deepEqual(await res.json(), { accepted: true, participants: 1, restarting: true });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(accepted, true);
      assert.equal(existsSync(pendingFile(dir)), true);
    } finally {
      await s.stop();
      // The server exits after accepting; on Windows an open database file cannot be replaced.
      running.db.close();
    }
    // The next start, before the database opens.
    const lines: string[] = [];
    assert.equal(applyPending(dir, parseTarget(live), (l) => lines.push(l)), true);
    assert.equal(existsSync(pendingFile(dir)), false);
    assert.match(lines[0]!, /Restored the uploaded backup/);
    const store = new Store(openDatabase(live));
    const ana = store.participantByName('ana')!;
    const t12 = store.tickets.get(ana, 'API-12');
    assert.equal(t12.title, 'Area: ticket 12');
    assert.ok(t12.activity.some((a) => a.kind === 'comment'));
    assert.equal(store.tickets.create(ana, 'api', { title: 'Area: next' }).ticket.ref, 'API-13');
    assert.equal(applyPending(dir, parseTarget(live), () => {}), false, 'nothing pending any more');
  });

  it('keeps a pending file that will not restore, and starts on the database as it was', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orco-push-'));
    writeFileSync(pendingFile(dir), 'garbage');
    const lines: string[] = [];
    assert.equal(applyPending(dir, parseTarget(join(dir, 'live.db')), (l) => lines.push(l)), false);
    assert.equal(existsSync(`${pendingFile(dir)}.failed`), true);
    assert.match(lines[0]!, /Could not restore/);
  });

  it('orco push-restore uploads, then waits until the server is back', async () => {
    const calls: string[] = [];
    let health = 0;
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/api/admin/restore')) {
        assert.equal((init!.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
        return new Response(JSON.stringify({ accepted: true, participants: 3, restarting: true }), { status: 202 });
      }
      // Down once (restarting), then up.
      if (health++ === 0) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ ok: true, uptimeSeconds: 1 }), { status: 200 });
    }) as typeof fetch;
    const lines: string[] = [];
    await pushRestore(Buffer.from('x'), 'https://orco.example.com/', TOKEN, (l) => lines.push(l), fake, 30);
    assert.equal(calls[0], 'POST https://orco.example.com/api/admin/restore');
    assert.match(lines.at(-1)!, /unset ORCO_RESTORE_TOKEN and redeploy/);
    const notOn = (async () => new Response('{}', { status: 404 })) as typeof fetch;
    await assert.rejects(pushRestore(Buffer.from('x'), 'https://o', TOKEN, () => {}, notOn), /set ORCO_RESTORE_TOKEN/);
  });
});

describe('restore over HTTPS with --force (#150)', () => {
  const upload = (base: string, body: Buffer, force: boolean) =>
    fetch(`${base}/api/admin/restore${force ? '?force=1' : ''}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: new Uint8Array(body) });

  it('replaces a board with sign-ups but no tickets or messages, keeping the old database beside it', async (t) => {
    const logged: string[] = [];
    t.mock.method(console, 'log', (m: string) => logged.push(m));
    const dir = mkdtempSync(join(tmpdir(), 'orco-force-'));
    const file = readFileSync(board(dir));
    const live = join(dir, 'live.db');
    const running = new Store(openDatabase(live));
    running.createUser('first-signup');
    running.createUser('second-signup');
    const s = await serve(running, { dir, onAccepted: () => {} });
    try {
      assert.equal((await upload(s.base, file, false)).status, 409, 'without --force, people on it means no');
      assert.equal(existsSync(pendingFile(dir)), false);
      const res = await upload(s.base, file, true);
      assert.equal(res.status, 202);
      assert.ok(logged.some((l) => /forced, replacing 2 participants/.test(l)));
    } finally {
      await s.stop();
      running.db.close();
    }
    const lines: string[] = [];
    assert.equal(applyPending(dir, parseTarget(live), (l) => lines.push(l)), true);
    assert.match(lines[0]!, /the database it replaced is at .*before-restore/);
    const store = new Store(openDatabase(live));
    const ana = store.participantByName('ana')!;
    assert.equal(store.participantByName('first-signup'), null);
    assert.ok(store.tickets.get(ana, 'API-12').activity.some((a) => a.kind === 'comment'));
    store.db.close();
  });

  for (const work of ['a ticket', 'a message'] as const) {
    it(`never replaces a board with ${work}, even with --force`, async (t) => {
      t.mock.method(console, 'log', () => {});
      const dir = mkdtempSync(join(tmpdir(), 'orco-force-'));
      const file = readFileSync(board(dir));
      const running = new Store(openDatabase(':memory:'));
      const ana = running.createUser('ana').participant;
      running.createProject(ana, 'web');
      if (work === 'a ticket') running.tickets.create(ana, 'web', { title: 'Home: one thing' });
      else running.post(ana, 'web/general', 'hello');
      const s = await serve(running, { dir, onAccepted: () => assert.fail('must not restart') });
      try {
        const res = await upload(s.base, file, true);
        assert.equal(res.status, 409);
        assert.match(((await res.json()) as { error: string }).error, /never replaces a board in use/);
        assert.equal(existsSync(pendingFile(dir)), false, 'nothing saved');
      } finally {
        await s.stop();
      }
    });
  }

  it('orco push-restore --force asks for it', async () => {
    let asked = '';
    const fake = (async (url: string | URL | Request) => {
      if (String(url).includes('/api/admin/restore')) {
        asked = String(url);
        return new Response(JSON.stringify({ accepted: true, participants: 1 }), { status: 202 });
      }
      return new Response(JSON.stringify({ ok: true, uptimeSeconds: 0 }), { status: 200 });
    }) as typeof fetch;
    await pushRestore(Buffer.from('x'), 'https://o', TOKEN, () => {}, fake, 10, true);
    assert.equal(asked, 'https://o/api/admin/restore?force=1');
  });
});

describe('orco backup reads the database as it is (#150)', () => {
  it('copies an older schema without upgrading it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orco-asis-'));
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    for (const m of MIGRATIONS.slice(0, 10)) old.exec(m);
    old.exec('PRAGMA user_version = 10');
    old.close();
    backupAsIs(path, join(dir, 'copy.db'));
    for (const f of [path, join(dir, 'copy.db')]) {
      const db = new DatabaseSync(f, { readOnly: true });
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 10, f);
      db.close();
    }
  });
});
