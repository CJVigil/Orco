import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/*
 * orco service (#125): keep the server running without hand-made wrappers.
 * Every platform runs the same supervisor (`orco service run`): it starts `orco serve`, restarts it
 * after a crash with backoff (1 s doubling to 60 s, reset after a minute up), and writes one log
 * file. The platform's own manager keeps the supervisor up and starts it at boot or sign-in:
 * a systemd user service on Linux, a launchd agent on macOS, a logon task on Windows.
 * Commands run without a shell.
 */

export type Manager = 'systemd' | 'launchd' | 'schtasks';

export interface ServiceConfig {
  db: string;
  port: string;
  host?: string;
  log: string;
  manager: Manager;
  node: string;
  /** Node flags the CLI needs, like --import tsx in a source checkout. */
  nodeArgs?: string[];
  cli: string;
  installedAt: string;
}

export interface RunState {
  supervisorPid: number;
  childPid?: number;
  childStartedAt?: string;
  restarts: number;
  lastExit?: string;
}

export const SERVICE_NAME = 'orco';
export const LAUNCHD_LABEL = 'dev.orco.server';
export const TASK_NAME = 'Orco';

export function serviceDir(home = homedir()): string {
  return process.env.ORCO_SERVICE_DIR ?? join(home, '.orco', 'service');
}

const configFile = (dir: string) => join(dir, 'service.json');
const runFile = (dir: string) => join(dir, 'run.json');

export function managerFor(target = platform()): Manager {
  if (target === 'darwin') return 'launchd';
  if (target === 'win32') return 'schtasks';
  return 'systemd';
}

/** Restart delay after `attempt` crashes in a row. */
export function backoff(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt));
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const quoteSystemd = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function supervisorArgs(c: ServiceConfig): string[] {
  return [c.node, ...(c.nodeArgs ?? []), c.cli, 'service', 'run'];
}

/** The unit, plist or task command line for a manager. */
export function unitText(c: ServiceConfig): string {
  const argv = supervisorArgs(c);
  if (c.manager === 'systemd') {
    return [
      '[Unit]',
      'Description=Orco server',
      'After=network-online.target',
      '',
      '[Service]',
      `ExecStart=${argv.map(quoteSystemd).join(' ')}`,
      'Restart=always',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
  }
  if (c.manager === 'launchd') {
    const args = argv.map((a) => `    <string>${xml(a)}</string>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
`;
  }
  return argv.map((a) => `"${a}"`).join(' ');
}

export function unitPath(manager: Manager, home = homedir()): string | null {
  if (manager === 'systemd') return join(home, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
  if (manager === 'launchd') return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  return null;
}

type Runner = (cmd: string, args: string[]) => { status: number | null; out: string };
const realRun: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false });
  return {
    status: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`.trim(),
  };
};

function must(run: Runner, cmd: string, args: string[]): string {
  const r = run(cmd, args);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.out}`);
  return r.out;
}

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 0);

export function readConfig(dir = serviceDir()): ServiceConfig | null {
  try {
    return JSON.parse(readFileSync(configFile(dir), 'utf8')) as ServiceConfig;
  } catch {
    return null;
  }
}

export function readRun(dir = serviceDir()): RunState | null {
  try {
    return JSON.parse(readFileSync(runFile(dir), 'utf8')) as RunState;
  } catch {
    return null;
  }
}

export interface InstallOptions {
  db: string;
  port: string;
  host?: string;
  dir?: string;
  manager?: Manager;
  home?: string;
  run?: Runner;
  /** Write files only; do not call the manager (tests). */
  dryRun?: boolean;
}

export function install(o: InstallOptions): {
  config: ServiceConfig;
  lines: string[];
} {
  const dir = o.dir ?? serviceDir(o.home);
  const manager = o.manager ?? managerFor();
  const run = o.run ?? realRun;
  if (manager === 'systemd' && !o.dryRun && !existsSync('/run/systemd/system')) {
    throw new Error('systemd is not running here. In a container, run the Orco image instead (docker compose up -d): it restarts on crashes and has a healthcheck. See docs/deploy.md.');
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config: ServiceConfig = {
    db: resolve(o.db),
    port: o.port,
    host: o.host,
    log: join(dir, 'orco.log'),
    manager,
    node: process.execPath,
    nodeArgs: process.execArgv.filter((a) => !a.startsWith('--eval') && a !== '-e'),
    cli: resolve(process.argv[1] ?? 'orco'),
    installedAt: new Date().toISOString(),
  };
  writeFileSync(configFile(dir), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  const path = unitPath(manager, o.home);
  const lines = [`Saved ${configFile(dir)}`];
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, unitText(config));
    lines.push(`Wrote ${path}`);
  }
  if (o.dryRun) return { config, lines };
  if (manager === 'systemd') {
    must(run, 'systemctl', ['--user', 'daemon-reload']);
    must(run, 'systemctl', ['--user', 'enable', '--now', SERVICE_NAME]);
    lines.push('Started. It starts at boot only with lingering on: loginctl enable-linger $USER');
  } else if (manager === 'launchd') {
    run('launchctl', ['bootout', `gui/${uid()}/${LAUNCHD_LABEL}`]);
    must(run, 'launchctl', ['bootstrap', `gui/${uid()}`, path!]);
    lines.push('Started; it starts at every sign-in.');
  } else {
    must(run, 'schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', TASK_NAME, '/TR', unitText(config)]);
    must(run, 'schtasks', ['/Run', '/TN', TASK_NAME]);
    lines.push('Started; it starts at every sign-in.');
  }
  lines.push(`Logs: ${config.log}`);
  return { config, lines };
}

function requireConfig(dir: string): ServiceConfig {
  const c = readConfig(dir);
  if (!c) throw new Error('Orco is not installed as a service here; run orco service install');
  return c;
}

export function control(action: 'stop' | 'restart' | 'start', dir = serviceDir(), run: Runner = realRun): string {
  const c = requireConfig(dir);
  if (c.manager === 'systemd') must(run, 'systemctl', ['--user', action, SERVICE_NAME]);
  else if (c.manager === 'launchd') {
    const target = `gui/${uid()}/${LAUNCHD_LABEL}`;
    if (action === 'stop') must(run, 'launchctl', ['bootout', target]);
    else if (action === 'start') must(run, 'launchctl', ['bootstrap', `gui/${uid()}`, unitPath('launchd')!]);
    else if (run('launchctl', ['kickstart', '-k', target]).status !== 0) must(run, 'launchctl', ['bootstrap', `gui/${uid()}`, unitPath('launchd')!]);
  } else {
    if (action !== 'start') run('schtasks', ['/End', '/TN', TASK_NAME]);
    if (action === 'stop') stopSupervisor(dir);
    if (action !== 'stop') must(run, 'schtasks', ['/Run', '/TN', TASK_NAME]);
  }
  return `${action === 'stop' ? 'Stopped' : action === 'start' ? 'Started' : 'Restarted'} Orco`;
}

/** schtasks /End does not reach the server the supervisor started; end both. */
function stopSupervisor(dir: string) {
  const r = readRun(dir);
  for (const pid of [r?.childPid, r?.supervisorPid]) {
    if (!pid) continue;
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
}

export function uninstall(dir = serviceDir(), run: Runner = realRun): string[] {
  const c = requireConfig(dir);
  if (c.manager === 'systemd') {
    run('systemctl', ['--user', 'disable', '--now', SERVICE_NAME]);
    rmSync(unitPath('systemd')!, { force: true });
    run('systemctl', ['--user', 'daemon-reload']);
  } else if (c.manager === 'launchd') {
    run('launchctl', ['bootout', `gui/${uid()}/${LAUNCHD_LABEL}`]);
    rmSync(unitPath('launchd')!, { force: true });
  } else {
    run('schtasks', ['/End', '/TN', TASK_NAME]);
    stopSupervisor(dir);
    run('schtasks', ['/Delete', '/F', '/TN', TASK_NAME]);
  }
  rmSync(configFile(dir), { force: true });
  rmSync(runFile(dir), { force: true });
  return ['Removed the Orco service. The database and the log are kept:', `  ${c.db}`, `  ${c.log}`];
}

export interface Status {
  installed: boolean;
  manager?: Manager;
  running: boolean;
  version?: string;
  uptimeSeconds?: number;
  port: string;
  log: string;
  db?: string;
  restarts?: number;
  lastExit?: string;
}

export async function status(o: { dir?: string; port?: string; container?: boolean } = {}): Promise<Status> {
  const dir = o.dir ?? serviceDir();
  const c = readConfig(dir);
  const r = c ? readRun(dir) : null;
  const port = c?.port ?? o.port ?? '7420';
  const container = o.container ?? existsSync('/.dockerenv');
  const s: Status = {
    installed: !!c,
    manager: c?.manager,
    running: false,
    port,
    log: c?.log ?? (container ? 'the container output (docker compose logs orco)' : 'none: Orco is not installed as a service'),
    db: c?.db,
    restarts: r?.restarts,
    lastExit: r?.lastExit,
  };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        version?: string;
        uptimeSeconds?: number;
      };
      s.running = true;
      s.version = body.version;
      s.uptimeSeconds = body.uptimeSeconds;
    }
  } catch {
    // Not answering.
  }
  return s;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(seconds % 60)}s`;
}

export function formatStatus(s: Status): string[] {
  return [
    `Orco: ${s.running ? 'running' : 'not answering'}${s.installed ? ` (service, ${s.manager})` : ''}`,
    `  version  ${s.version ?? '-'}`,
    `  uptime   ${s.uptimeSeconds === undefined ? '-' : formatUptime(s.uptimeSeconds)}`,
    `  port     ${s.port}`,
    `  log      ${s.log}`,
    ...(s.db ? [`  database ${s.db}`] : []),
    ...(s.restarts ? [`  restarts ${s.restarts}${s.lastExit ? ` (last: ${s.lastExit})` : ''}`] : []),
  ];
}

export function tail(file: string, lines: number): string {
  if (!existsSync(file)) return '';
  const text = readFileSync(file, 'utf8');
  return text
    .split('\n')
    .slice(-(lines + 1))
    .join('\n');
}

const MAX_LOG = 10 * 1024 * 1024;

/** The supervisor: runs `orco serve`, restarts it with backoff, and logs. Returns when told to stop. */
export function supervise(
  o: {
    dir?: string;
    spawnServe?: (c: ServiceConfig) => ReturnType<typeof spawn>;
  } = {},
): Promise<void> {
  const dir = o.dir ?? serviceDir();
  const c = requireConfig(dir);
  const state: RunState = { supervisorPid: process.pid, restarts: 0 };
  const save = () => writeFileSync(runFile(dir), `${JSON.stringify(state)}\n`);
  const log = (line: string) => {
    try {
      if (existsSync(c.log) && statSync(c.log).size > MAX_LOG) renameSync(c.log, `${c.log}.1`);
    } catch {
      // Keep logging.
    }
    appendFileSync(c.log, line.endsWith('\n') ? line : `${line}\n`);
  };
  const start =
    o.spawnServe ??
    ((cfg: ServiceConfig) => spawn(cfg.node, [...(cfg.nodeArgs ?? []), cfg.cli, 'serve', '--db', cfg.db, '--port', cfg.port, ...(cfg.host ? ['--host', cfg.host] : [])], { stdio: ['ignore', 'pipe', 'pipe'], shell: false }));
  let stopping = false;
  let child: ReturnType<typeof spawn> | null = null;
  let crashes = 0;
  return new Promise((done) => {
    const stop = () => {
      stopping = true;
      log(`${new Date().toISOString()} supervisor: stopping`);
      if (child && child.exitCode === null) child.kill();
      else done();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    const launch = () => {
      const began = Date.now();
      log(`${new Date().toISOString()} supervisor: starting orco serve on port ${c.port}`);
      child = start(c);
      state.childPid = child.pid;
      state.childStartedAt = new Date(began).toISOString();
      save();
      child.stdout?.on('data', (d: Buffer) => log(d.toString()));
      child.stderr?.on('data', (d: Buffer) => log(d.toString()));
      child.on('exit', (code, signal) => {
        state.lastExit = `${new Date().toISOString()} ${signal ?? `code ${code}`}`;
        state.childPid = undefined;
        if (stopping) {
          save();
          done();
          return;
        }
        crashes = Date.now() - began >= 60_000 ? 0 : crashes + 1;
        state.restarts += 1;
        save();
        const wait = backoff(crashes - 1);
        log(`${new Date().toISOString()} supervisor: orco serve exited (${signal ?? `code ${code}`}); restarting in ${wait / 1000}s`);
        setTimeout(() => (stopping ? done() : launch()), wait);
      });
    };
    launch();
  });
}
