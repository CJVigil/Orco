import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Backups, filesystemOf, networkFilesystemWarning, restore } from '../src/backups.js';
import { openDatabase } from '../src/db.js';
import { type OrcoError, Store } from '../src/store.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as OrcoError).code;
  }
  return 'ok';
};

function seeded(file: string) {
  const store = new Store(openDatabase(file));
  const ana = store.createUser('ana').participant;
  store.createProject(ana, 'api');
  store.post(ana, 'api/general', 'before the backup');
  return { store, ana };
}

describe('scheduled backups', () => {
  it('write consistent copies on the interval and keep only the newest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orco-backups-'));
    const { store } = seeded(join(dir, 'orco.db'));
    let offset = 0;
    const backups = new Backups(store.db, { dir: join(dir, 'backups'), everyHours: 24, keep: 2, now: () => Date.now() + offset });
    const first = backups.runIfDue();
    assert.ok(first && existsSync(first));
    assert.equal(backups.runIfDue(), null, 'not due again yet');
    for (let i = 1; i <= 3; i++) {
      offset = i * 25 * 3600_000;
      assert.ok(backups.runIfDue());
    }
    assert.equal(backups.list().length, 2);
    assert.ok(!readdirSync(join(dir, 'backups')).some((f) => f.endsWith('.partial')));
    const copy = new Store(openDatabase(backups.list()[0]!.file));
    assert.equal(copy.participantByName('ana')?.name, 'ana');
    copy.db.close();
    store.db.close();
    assert.equal(code(() => new Backups(store.db, { dir, everyHours: 0, keep: 1 })), 'invalid');
  });
});

describe('restore', () => {
  it('swaps in a checked backup and keeps the database it replaced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orco-restore-'));
    const live = join(dir, 'orco.db');
    const { store, ana } = seeded(live);
    const backup = new Backups(store.db, { dir: join(dir, 'b'), everyHours: 1, keep: 5 }).run();
    store.post(ana, 'api/general', 'after the backup');
    // An open writer leaves a WAL beside the database: restoring over it is refused.
    assert.equal(code(() => restore(backup, live)), 'conflict');
    store.db.close();
    const { replaced } = restore(backup, live);
    assert.ok(replaced && existsSync(replaced));
    const restored = new Store(openDatabase(live));
    const texts = restored.read(restored.participantByName('ana')!, 'api/general').map((m) => m.text);
    assert.deepEqual(texts, ['before the backup']);
    restored.db.close();
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'not a database');
    assert.notEqual(code(() => restore(junk, live)), 'ok');
    assert.equal(code(() => restore(join(dir, 'missing.db'), live)), 'not_found');
  });

  it('runs from the CLI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orco-cli-restore-'));
    const live = join(dir, 'orco.db');
    seeded(live).store.db.close();
    const cli = (...args: string[]) =>
      execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', ...args, '--db', live], { encoding: 'utf8' });
    const file = join(dir, 'manual.db');
    assert.match(cli('backup', file), /Backed up/);
    assert.match(cli('restore', file), /Restored .* The database it replaced is at/);
    assert.match(cli('list'), /user\tana/);
  });
});

describe('network filesystem warning', () => {
  const mounts = [
    'overlay / overlay rw 0 0',
    '/dev/sda1 /srv ext4 rw 0 0',
    'gluster1:/vol /mnt/gluster fuse.glusterfs rw 0 0',
    'nas:/export /srv/nfs nfs4 rw 0 0',
  ].join('\n');

  it('finds the filesystem of the closest mount', () => {
    assert.equal(filesystemOf('/mnt/gluster/orco', mounts), 'fuse.glusterfs');
    assert.equal(filesystemOf('/srv/nfs/x', mounts), 'nfs4');
    assert.equal(filesystemOf('/srv/local', mounts), 'ext4');
    assert.equal(filesystemOf('/mnt/glusterfoo', mounts), 'overlay');
  });

  it('warns for Gluster and NFS, not for local disks', () => {
    assert.match(networkFilesystemWarning('/mnt/gluster/orco/orco.db', mounts) ?? '', /fuse\.glusterfs/);
    assert.match(networkFilesystemWarning('/srv/nfs/orco.db', mounts) ?? '', /nfs4/);
    assert.equal(networkFilesystemWarning('/srv/data/orco.db', mounts), null);
    assert.equal(networkFilesystemWarning(':memory:', mounts), null);
  });
});
