import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

/*
 * orco update (#124): a safe update of a git checkout of Orco.
 *   1. back up the database;
 *   2. stage the target version in a separate worktree, install and build it there, and migrate a copy
 *      of the database with it (preflight);
 *   3. start it as a trial on a spare port against that copy and check /healthz;
 *   4. switch the checkout to the target, build, restart the server (ORCO_RESTART_CMD or --restart,
 *      run without a shell) and check /healthz again;
 *   5. if anything after the switch fails: check out the previous version, rebuild, put the backup
 *      back, restart, and say why.
 * Commands run without a shell. Nothing here runs inside the server process.
 */

export interface UpdateOptions {
  repo: string;
  db: string;
  /** A git ref to update to (default: origin/main after a fetch). */
  ref?: string;
  /** The command that restarts the running server, as argv (no shell). */
  restart?: string[];
  /** Where the running server answers, for the health check after the switch. */
  url?: string;
  log: (line: string) => void;
  /** Seconds to wait for /healthz. */
  healthSeconds?: number;
}

export class UpdateError extends Error {}

function run(cmd: string, args: string[], cwd: string, log: (l: string) => void): string {
  log(`$ ${cmd} ${args.join(' ')}`);
  const out = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ORCO_SCOPE_GATE: process.env.ORCO_SCOPE_GATE } });
  if (out.status !== 0) throw new UpdateError(`${cmd} ${args.join(' ')} failed: ${(out.stderr || out.stdout || String(out.error ?? '')).trim().split('\n').slice(-5).join(' | ')}`);
  return out.stdout.trim();
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
    s.on('error', fail);
  });
}

export async function healthy(url: string, seconds: number): Promise<boolean> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function update(o: UpdateOptions): Promise<{ from: string; to: string; rolledBack: boolean; reason?: string }> {
  const repo = resolve(o.repo);
  const db = resolve(o.db);
  const health = o.healthSeconds ?? 30;
  if (!existsSync(join(repo, '.git'))) throw new UpdateError(`${repo} is not a git checkout; orco update works on one (container installs: pull the new image instead)`);
  if (run('git', ['status', '--porcelain', '--untracked-files=no'], repo, o.log)) throw new UpdateError('The checkout has local changes; commit or stash them first');
  const from = run('git', ['rev-parse', 'HEAD'], repo, o.log);
  if (!o.ref) run('git', ['fetch', '--quiet', 'origin'], repo, o.log);
  const to = run('git', ['rev-parse', `${o.ref ?? 'origin/main'}^{commit}`], repo, o.log);
  if (to === from) {
    o.log(`Already at ${to.slice(0, 7)}`);
    return { from, to, rolledBack: false };
  }

  // 1. Back up.
  const work = join(repo, '.orco-update');
  mkdirSync(work, { recursive: true });
  const backup = join(work, `before-${from.slice(0, 7)}-${Date.now()}.db`);
  run(process.execPath, [join(repo, 'dist', 'cli.js'), 'backup', backup, '--db', db], repo, o.log);
  o.log(`Backed up the database to ${backup}`);

  // 2. Stage and preflight.
  const stage = join(work, `stage-${to.slice(0, 7)}`);
  rmSync(stage, { recursive: true, force: true });
  run('git', ['worktree', 'prune'], repo, o.log);
  run('git', ['worktree', 'add', '--detach', stage, to], repo, o.log);
  try {
    run(npm, ['ci', '--no-audit', '--no-fund'], stage, o.log);
    run(npm, ['run', 'build'], stage, o.log);
    const copy = join(work, `preflight-${to.slice(0, 7)}.db`);
    copyFileSync(backup, copy);
    run(process.execPath, [join(stage, 'dist', 'cli.js'), 'list', '--db', copy], stage, o.log);
    o.log('Preflight: the new version built and migrated a copy of the database');

    // 3. Trial start against the copy.
    const port = await freePort();
    const trial = spawn(process.execPath, [join(stage, 'dist', 'cli.js'), 'serve', '--db', copy, '--port', String(port), '--host', '127.0.0.1'], { cwd: stage, stdio: 'ignore', shell: false });
    const ok = await healthy(`http://127.0.0.1:${port}`, health);
    trial.kill();
    if (!ok) throw new UpdateError('The new version did not answer /healthz in its trial start');
    o.log('Trial start: healthy');
  } catch (err) {
    run('git', ['worktree', 'remove', '--force', stage], repo, () => {});
    throw err;
  } finally {
    rmSync(join(work, `preflight-${to.slice(0, 7)}.db`), { force: true });
  }
  run('git', ['worktree', 'remove', '--force', stage], repo, o.log);

  // 4. Switch, restart, check. 5. Or roll back.
  const restart = () => {
    if (o.restart?.length) run(o.restart[0]!, o.restart.slice(1), repo, o.log);
    else o.log('No restart command (ORCO_RESTART_CMD or --restart): restart the server yourself now');
  };
  try {
    run('git', ['checkout', '--detach', to], repo, o.log);
    run(npm, ['ci', '--no-audit', '--no-fund'], repo, o.log);
    run(npm, ['run', 'build'], repo, o.log);
    restart();
    if (o.url && o.restart?.length && !(await healthy(o.url, health))) throw new UpdateError('After the switch the server did not answer /healthz');
    o.log(`Updated ${from.slice(0, 7)} → ${to.slice(0, 7)}`);
    return { from, to, rolledBack: false };
  } catch (err) {
    const reason = (err as Error).message;
    o.log(`Rolling back to ${from.slice(0, 7)}: ${reason}`);
    run('git', ['checkout', '--detach', from], repo, o.log);
    run(npm, ['ci', '--no-audit', '--no-fund'], repo, o.log);
    run(npm, ['run', 'build'], repo, o.log);
    copyFileSync(backup, db);
    for (const suffix of ['-wal', '-shm']) rmSync(`${db}${suffix}`, { force: true });
    restart();
    return { from, to, rolledBack: true, reason };
  }
}
