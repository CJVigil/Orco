import { spawnSync } from 'node:child_process';
import type { BridgeConfig } from './config.js';
import { PRESETS } from './presets.js';

export interface Finding {
  agent: string;
  ok: boolean;
  text: string;
}

/** Runs a command and returns what it printed, or null if it could not be started. */
type Probe = (command: string, args: string[]) => string | null;

const defaultProbe: Probe = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20_000 });
  if (result.error) return null;
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
};

/** The --flags a command passes (without values), to look for in the tool's own help. */
export function flagsOf(command: string[]): string[] {
  return [...new Set(command.filter((part) => /^--?[a-zA-Z]/.test(part)).map((part) => part.split('=')[0]!))];
}

/**
 * Checks a bridge config on this machine before tasks arrive: each agent's token works, its tool is
 * installed, and the flags its command passes appear in that version's --help (presets other than
 * Claude Code and Codex use flags from each tool's docs, which change between versions). For model
 * agents, checks the API answers and offers the model.
 */
export async function doctor(config: BridgeConfig, env: NodeJS.ProcessEnv, probe: Probe = defaultProbe): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const agent of config.agents) {
    const note = (ok: boolean, text: string) => findings.push({ agent: agent.name, ok, text });
    const token = env[agent.token_env];
    if (!token) {
      note(false, `${agent.token_env} is not set`);
    } else {
      try {
        const res = await fetch(`${config.server}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
        const me = (await res.json().catch(() => ({}))) as { name?: string; kind?: string; error?: string };
        if (!res.ok) note(false, `Orco refused the token in ${agent.token_env}: ${me.error ?? res.status}`);
        else if (me.name !== agent.name || me.kind !== 'agent') note(false, `the token in ${agent.token_env} belongs to ${me.kind} ${me.name}, not agent ${agent.name}`);
        else note(true, `signs in to ${config.server} as ${agent.name}`);
      } catch (err) {
        note(false, `cannot reach ${config.server}: ${(err as Error).message}`);
      }
    }

    if (agent.model) {
      const key = agent.model.api_key_env ? env[agent.model.api_key_env] : undefined;
      if (agent.model.api_key_env && !key) note(false, `${agent.model.api_key_env} is not set`);
      try {
        const res = await fetch(`${agent.model.base_url.replace(/\/+$/, '')}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
        const data = (await res.json().catch(() => ({}))) as { data?: { id: string }[] };
        if (!res.ok) note(false, `${agent.model.base_url} answered ${res.status}`);
        else if (data.data && !data.data.some((m) => m.id === agent.model!.name)) {
          note(false, `${agent.model.base_url} does not list ${agent.model.name}; it has ${data.data.slice(0, 8).map((m) => m.id).join(', ')}`);
        } else note(true, `${agent.model.base_url} offers ${agent.model.name}`);
      } catch (err) {
        note(false, `cannot reach ${agent.model.base_url}: ${(err as Error).message}`);
      }
      continue;
    }

    const [bin, maybeSub] = agent.command;
    const sub = maybeSub && !maybeSub.startsWith('-') && !maybeSub.includes('{') ? [maybeSub] : [];
    const help = probe(bin!, [...sub, '--help']);
    if (help === null) {
      note(false, `${bin} is not installed or not on PATH`);
      continue;
    }
    const missing = flagsOf(agent.command).filter((flag) => !new RegExp(`(^|[\\s,\\[(])${flag.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(?![\\w-])`, 'm').test(help));
    if (missing.length) note(false, `${[bin, ...sub].join(' ')} --help does not mention ${missing.join(', ')}; this version may use other flags: set command yourself`);
    else note(true, `${bin} is installed and accepts ${flagsOf(agent.command).join(' ') || 'its arguments'}`);

    if (agent.worktree) {
      const base = agent.worktree.base ?? 'HEAD';
      const sha = probe('git', ['-C', agent.worktree.repo, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
      if (sha === null) note(false, 'git is not installed or not on PATH, and worktree needs it');
      else if (!/\b[0-9a-f]{40}\b/.test(sha)) note(false, `worktree: ${agent.worktree.repo} is not a git repository, or ${base} is not a commit there`);
      else note(true, `worktree: tasks branch from ${base} in ${agent.worktree.repo}`);
    }

    const preset = agent.preset ? PRESETS[agent.preset] : undefined;
    if (preset?.via === 'cli' || agent.prompt_template?.includes('orco task')) {
      if (probe('orco', ['--version']) === null) note(false, 'orco is not on PATH, but this agent works through the orco command; npm link (or install) it on this machine');
      else note(true, 'orco is on PATH for the agent');
    }
    if (preset && !preset.verified) note(true, `${agent.preset} preset: flags come from the tool's docs. Setup: ${preset.setup}`);
  }
  return findings;
}
