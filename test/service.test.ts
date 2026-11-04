import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { backoff, formatStatus, install, readConfig, readRun, status, supervise, uninstall, unitText } from '../src/service.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'orco-svc-'));

describe('orco service (#125)', () => {
  it('backs off 1 s doubling to a minute', () => {
    assert.deepEqual([0, 1, 2, 5, 6, 20].map(backoff), [1000, 2000, 4000, 32000, 60000, 60000]);
  });

  it('writes a systemd unit, a launchd plist and a logon task that run the supervisor', () => {
    for (const manager of ['systemd', 'launchd', 'schtasks'] as const) {
      const home = tmp();
      const { config } = install({ db: join(home, 'orco.db'), port: '7421', dir: join(home, 'svc'), manager, home, dryRun: true });
      assert.equal(readConfig(join(home, 'svc'))!.port, '7421');
      const text = unitText(config);
      assert.match(text, /service/);
      assert.match(text, /run/);
      if (manager === 'systemd') {
        assert.match(text, /Restart=always/);
        assert.match(readFileSync(join(home, '.config/systemd/user/orco.service'), 'utf8'), /WantedBy=default.target/);
      }
      if (manager === 'launchd') assert.match(text, /<key>KeepAlive<\/key><true\/>/);
    }
  });

  it('uninstall calls the manager and keeps the database', () => {
    const home = tmp();
    const dir = join(home, 'svc');
    install({ db: join(home, 'orco.db'), port: '7421', dir, manager: 'schtasks', home, dryRun: true });
    const calls: string[] = [];
    const lines = uninstall(dir, (cmd, args) => (calls.push(`${cmd} ${args.join(' ')}`), { status: 0, out: '' }));
    assert.ok(calls.some((c) => c.startsWith('schtasks /Delete')));
    assert.match(lines.join('\n'), /orco\.db/);
    assert.equal(readConfig(dir), null);
  });

  it('status says where the log is when nothing answers', async () => {
    const s = await status({ dir: tmp(), port: '1', container: true });
    assert.equal(s.running, false);
    assert.match(formatStatus(s).join('\n'), /docker compose logs/);
  });

  it('the supervisor restarts a crashed server and logs it', async () => {
    const home = tmp();
    const dir = join(home, 'svc');
    install({ db: join(home, 'orco.db'), port: '7421', dir, manager: 'systemd', home, dryRun: true });
    let starts = 0;
    const run = supervise({
      dir,
      spawnServe: () => {
        starts += 1;
        // Crashes at once the first time; stays up the second.
        return spawn(process.execPath, ['-e', starts === 1 ? 'console.log("boom"); process.exit(2)' : 'console.log("up"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
      },
    });
    for (let i = 0; i < 60 && starts < 2; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(starts, 2);
    assert.equal(readRun(dir)!.restarts, 1);
    process.emit('SIGTERM');
    await run;
    const log = readFileSync(readConfig(dir)!.log, 'utf8');
    assert.match(log, /boom/);
    assert.match(log, /restarting in 1s/);
    assert.match(log, /up/);
  });
});
