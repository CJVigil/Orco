import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { update } from '../src/updater.js';

// A stand-in Orco: dist/cli.js answers backup, list and serve (with /healthz), or crashes when broken.
const cli = (version: string, broken: boolean) => `
const fs = require('fs'); const http = require('http');
const [cmd, a] = process.argv.slice(2);
const db = process.argv[process.argv.indexOf('--db') + 1];
if (cmd === 'backup') { fs.copyFileSync(db, a); process.exit(0); }
if (cmd === 'list') { fs.appendFileSync(db, 'migrated-by-${version}\\n'); process.exit(0); }
if (cmd === 'serve') {
  ${broken ? "process.exit(1);" : ''}
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  http.createServer((q, s) => { s.end(JSON.stringify({ ok: true, version: '${version}' })); }).listen(port, '127.0.0.1');
}`;

function release(repo: string, version: string, broken = false) {
  writeFileSync(join(repo, 'build.js'), `require('fs').mkdirSync('dist', { recursive: true }); require('fs').writeFileSync('dist/cli.js', ${JSON.stringify(cli(version, broken))});`);
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', version], { cwd: repo });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

describe('safe updates (#124)', () => {
  it('switches to a good release, and rolls a broken one back by itself', { skip: process.platform === 'win32' ? 'npm.cmd needs a shell on Windows' : false }, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orco-update-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(join(repo, '.gitignore'), 'dist\nnode_modules\n.orco-update\n*.db*\n');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fake-orco', version: '1.0.0', private: true, scripts: { build: 'node build.js' } }));
    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ name: 'fake-orco', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fake-orco', version: '1.0.0' } } }));
    const v1 = release(repo, 'v1');
    execFileSync('node', ['build.js'], { cwd: repo });
    const db = join(repo, 'orco.db');
    writeFileSync(db, 'data\n');
    const v2 = release(repo, 'v2');
    execFileSync('git', ['checkout', '-q', '--detach', v1], { cwd: repo });
    execFileSync('node', ['build.js'], { cwd: repo });
    const lines: string[] = [];
    const good = await update({ repo, db, ref: v2, log: (l) => lines.push(l), healthSeconds: 10 });
    assert.deepEqual([good.from, good.to, good.rolledBack], [v1, v2, false]);
    assert.match(readFileSync(join(repo, 'dist/cli.js'), 'utf8'), /v2/);
    assert.ok(lines.some((l) => l.startsWith('Backed up the database')));
    assert.ok(lines.includes('Trial start: healthy'));
    // A broken release never gets past its trial: nothing switches.
    const v3 = release(repo, 'v3', true);
    execFileSync('git', ['checkout', '-q', '--detach', v2], { cwd: repo });
    await assert.rejects(update({ repo, db, ref: v3, log: () => {}, healthSeconds: 3 }), /did not answer \/healthz in its trial start/);
    assert.match(readFileSync(join(repo, 'dist/cli.js'), 'utf8'), /v2/, 'still on the old version');
    // A release that passes its trial but fails after the switch rolls back, database included.
    const v4 = release(repo, 'v4');
    execFileSync('git', ['checkout', '-q', '--detach', v2], { cwd: repo });
    const back = await update({ repo, db, ref: v4, restart: ['node', '-e', 'process.exit(0)'], url: 'http://127.0.0.1:9', log: () => {}, healthSeconds: 2 });
    assert.equal(back.rolledBack, true);
    assert.match(back.reason ?? '', /did not answer \/healthz/);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), v2);
    assert.equal(readFileSync(db, 'utf8'), 'data\n', 'the database is the backup again');
    assert.ok(existsSync(join(repo, '.orco-update')));
    mkdirSync(join(repo, 'x'), { recursive: true });
  });

  it('refuses a folder that is not a git checkout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orco-update-'));
    await assert.rejects(update({ repo: dir, db: join(dir, 'o.db'), log: () => {} }), /not a git checkout/);
  });
});
