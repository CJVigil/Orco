import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PRESET_NAMES, PRESETS } from './bridge/presets.js';

export interface ConnectOptions {
  server: string;
  /** The folder agents work in (default: the current one). */
  dir: string;
  /** The bridge config to write or add to. */
  config: string;
  /** Where token files go. */
  tokenDir: string;
  /** Write a service that starts the bridge at login. */
  service: boolean;
  /** Checks whether a tool is installed (by running it); injectable for tests. */
  probe?: (command: string) => boolean;
  /** How often to ask whether the code was approved. */
  pollMs?: number;
}

export interface ConnectIO {
  out: (text: string) => void;
}

export const DEFAULT_CONFIG = join(homedir(), '.config', 'orco', 'bridge.json');
export const DEFAULT_TOKEN_DIR = join(homedir(), '.config', 'orco', 'tokens');

const defaultProbe = (command: string) => {
  const result = spawnSync(command, ['--version'], { timeout: 10_000, stdio: 'ignore' });
  return !result.error;
};

/** The agent tools installed here that Orco has presets for. */
export function detectTools(probe: (command: string) => boolean = defaultProbe): string[] {
  const seen = new Map<string, boolean>();
  return PRESET_NAMES.filter((name) => {
    const bin = PRESETS[name]!.command[0]!;
    if (!seen.has(bin)) seen.set(bin, probe(bin));
    return seen.get(bin)!;
  });
}

interface BridgeFile {
  server: string;
  agents: Record<string, unknown>[];
}

/**
 * `orco connect <server>`: joins this computer to Orco without copying tokens around. It finds the
 * agent tools installed here, asks the server for a short code, and waits while a person approves the
 * code in the browser and picks which of their agents run here. Then it writes each agent's token to
 * a private file and adds the agents to the bridge config, ready for `orco bridge`.
 */
export async function connect(options: ConnectOptions, io: ConnectIO): Promise<{ config: string; agents: string[] }> {
  const server = options.server.replace(/\/+$/, '');
  const tools = detectTools(options.probe);
  io.out(tools.length ? `Found: ${tools.map((t) => PRESETS[t]!.command[0]).join(', ')}` : 'No agent tools found here (Claude Code, Codex, Gemini CLI, …). You can still approve, and install one later.');

  const started = await call(server, 'POST', '/api/pair', { host: hostname(), tools, cwd: options.dir });
  const { id, code, secret } = started as { id: string; code: string; secret: string };
  io.out('');
  io.out(`  To connect this computer, open ${server}/#pair=${code}`);
  io.out(`  or in Orco go to My agents → Connect a computer and enter ${code}`);
  io.out('  The code works for 10 minutes. Waiting…');

  let result: { state: string; approvedBy?: string; agents?: { name: string; token: string; preset: string }[] };
  for (;;) {
    await new Promise((done) => setTimeout(done, options.pollMs ?? 2000));
    try {
      result = (await call(server, 'GET', `/api/pair/${encodeURIComponent(id)}?secret=${encodeURIComponent(secret)}`)) as typeof result;
    } catch (err) {
      if ((err as Error).message.includes('expired')) throw err;
      continue; // a restart or a blip: keep waiting until the code expires
    }
    if (result.state !== 'pending') break;
  }
  if (result.state === 'denied') throw new Error('The code was declined in Orco. Run orco connect again if that was a mistake.');

  // Tokens go in files only you can read; the config names the files, so it holds no secrets.
  mkdirSync(options.tokenDir, { recursive: true, mode: 0o700 });
  const file: BridgeFile = existsSync(options.config) ? (JSON.parse(readFileSync(options.config, 'utf8')) as BridgeFile) : { server, agents: [] };
  if (file.server.replace(/\/+$/, '') !== server) {
    throw new Error(`${options.config} is set up for ${file.server}; pass --config with another file for ${server}`);
  }
  const names: string[] = [];
  for (const agent of result.agents ?? []) {
    const tokenFile = join(options.tokenDir, agent.name);
    writeFileSync(tokenFile, `${agent.token}\n`, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    const entry = { name: agent.name, preset: agent.preset, token_file: tokenFile, cwd: options.dir };
    const at = file.agents.findIndex((a) => a.name === agent.name);
    if (at >= 0) file.agents[at] = { ...file.agents[at], ...entry, token_env: undefined };
    else file.agents.push(entry);
    names.push(agent.name);
  }
  mkdirSync(dirname(options.config), { recursive: true, mode: 0o700 });
  writeFileSync(options.config, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  io.out('');
  io.out(`Approved by ${result.approvedBy}. This computer now runs: ${names.join(', ')}`);
  io.out(`Saved ${options.config} (tokens in ${options.tokenDir}, readable only by you).`);
  if (options.service) for (const line of writeService(options.config)) io.out(line);
  return { config: options.config, agents: names };
}

/** A service that starts the bridge when you sign in. Returns what to tell the person. */
export function writeService(config: string, target = platform()): string[] {
  const node = process.execPath;
  const cli = resolve(process.argv[1] ?? 'orco');
  if (target === 'linux') {
    const path = join(homedir(), '.config', 'systemd', 'user', 'orco-bridge.service');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `[Unit]\nDescription=Orco bridge: wakes your agents for their tasks\nAfter=network-online.target\n\n[Service]\nExecStart=${node} ${cli} bridge --config ${config}\nRestart=on-failure\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`,
    );
    return [`Wrote ${path}. Start it now and at every login with:`, '  systemctl --user daemon-reload && systemctl --user enable --now orco-bridge'];
  }
  if (target === 'darwin') {
    const path = join(homedir(), 'Library', 'LaunchAgents', 'dev.orco.bridge.plist');
    mkdirSync(dirname(path), { recursive: true });
    const args = [node, cli, 'bridge', '--config', config].map((a) => `    <string>${a.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`).join('\n');
    writeFileSync(
      path,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>dev.orco.bridge</string>\n  <key>ProgramArguments</key>\n  <array>\n${args}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n</dict>\n</plist>\n`,
    );
    return [`Wrote ${path}. Start it now and at every login with:`, `  launchctl load -w ${path}`];
  }
  return ['To start the bridge at every sign-in, run this once in PowerShell:', `  schtasks /Create /SC ONLOGON /TN "Orco bridge" /TR "\\"${node}\\" \\"${cli}\\" bridge --config \\"${config}\\""`];
}

async function call(server: string, method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${server}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`Cannot reach ${server}: ${(err as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
