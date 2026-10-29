import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as z from 'zod/v4';
import { OrcoError } from '../errors.js';
import { BRIDGE_PROMPT, CLI_PROMPT, PRESET_NAMES, PRESETS } from './presets.js';
import type { WorktreeSettings } from './worktree.js';

const modelSchema = z.object({
  /** An OpenAI-compatible API: Ollama (http://localhost:11434/v1), LM Studio, vLLM, OpenRouter, ... */
  base_url: z.url(),
  name: z.string().min(1),
  api_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  max_turns: z.number().int().min(1).max(200).default(40),
  temperature: z.number().min(0).max(2).optional(),
  /** Orco tools the model may call; defaults to the tools a task needs. */
  tools: z.array(z.string()).optional(),
  /** US dollars per million tokens, to put a cost on runs (local models: leave it out). */
  price: z.object({ input_per_million: z.number().min(0), output_per_million: z.number().min(0) }).optional(),
});

const agentSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  /** The variable holding the agent's token (and that the agent's tool reads it from). Default ORCO_TOKEN_<NAME>. */
  token_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'token_env must name an environment variable, like ORCO_TOKEN_CLAUDE').optional(),
  /** Or a file holding the token, readable only by you (orco connect writes these). */
  token_file: z.string().optional(),
  /** A ready-made setup for a known agent tool (see presets.ts), instead of command. */
  preset: z.enum(PRESET_NAMES).optional(),
  command: z.array(z.string()).min(1).optional(),
  /** Run a model behind an OpenAI-compatible API, instead of a command: the bridge runs the tool loop. */
  model: modelSchema.optional(),
  /** Who accepts and closes the task: the agent (default) or the bridge, for tools that cannot reach Orco. */
  lifecycle: z.enum(['agent', 'bridge']).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout_seconds: z.number().int().min(10).max(24 * 3600).default(1800),
  max_concurrent: z.number().int().min(1).max(8).default(1),
  prompt_template: z.string().optional(),
  /** Hand the agent a token limited to the task's project instead of its own (default on). */
  task_tokens: z.boolean().default(true),
  /** Run each task in its own git worktree and branch: true (the repo is cwd), or settings. */
  worktree: z
    .union([
      z.boolean(),
      z.object({
        repo: z.string().optional(),
        base: z.string().min(1).optional(),
        dir: z.string().optional(),
        branch_prefix: z.string().regex(/^[\w./-]*$/).default('orco/'),
        fetch: z.boolean().default(true),
      }),
    ])
    .optional(),
  /** When the agent's tool runs out of usage (a plan limit, a rate limit, no credit): hand the task to this agent. */
  fallback: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).optional(),
  /** Without a fallback, or if the handoff fails, try again this many minutes later (or when the tool says it resets). */
  retry_minutes: z.number().int().min(5).max(1440).default(30),
  /** Send each run's log to Orco with its usage (default on; usage is always sent). */
  run_logs: z.boolean().default(true),
});

const configSchema = z.object({
  server: z.url(),
  agents: z.array(agentSchema).min(1),
});

export type ModelConfig = z.infer<typeof modelSchema>;
/** An agent as the bridge runs it: a preset resolved into its command, lifecycle and prompt. */
export type BridgeAgentConfig = Omit<z.infer<typeof agentSchema>, 'command' | 'lifecycle' | 'worktree' | 'token_env'> & {
  token_env: string;
  /** Set in code, never from a config file: asked before each model turn (see runModel). */
  beforeTurn?: (runCostMicros: number) => string | null;
  command: string[];
  lifecycle: 'agent' | 'bridge';
  worktree?: WorktreeSettings;
};
export type BridgeConfig = Omit<z.infer<typeof configSchema>, 'agents'> & { agents: BridgeAgentConfig[] };

function resolveDir(baseDir: string, dir: string): string {
  if (dir === '~') return homedir();
  if (dir.startsWith('~/')) return join(homedir(), dir.slice(2));
  return resolve(baseDir, dir);
}

export function parseBridgeConfig(raw: unknown, baseDir = process.cwd()): BridgeConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new OrcoError('invalid', `Bridge config is not valid:\n${problems.join('\n')}`);
  }
  const names = result.data.agents.map((a) => a.name);
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate) throw new OrcoError('invalid', `Bridge config lists agent ${duplicate} twice`);
  return {
    ...result.data,
    server: result.data.server.replace(/\/+$/, ''),
    agents: result.data.agents.map((agent) => {
      const ways = [agent.command, agent.preset, agent.model].filter((x) => x !== undefined).length;
      if (ways !== 1) throw new OrcoError('invalid', `Bridge config: agent ${agent.name} needs exactly one of command, preset or model`);
      const preset = agent.preset ? PRESETS[agent.preset]! : null;
      const lifecycle = agent.lifecycle ?? (preset?.via === 'bridge' ? 'bridge' : 'agent');
      const prompt_template =
        agent.prompt_template ?? (preset?.via === 'cli' ? CLI_PROMPT : lifecycle === 'bridge' ? BRIDGE_PROMPT : undefined);
      const cwd = agent.cwd ? resolveDir(baseDir, agent.cwd) : undefined;
      let worktree: WorktreeSettings | undefined;
      if (agent.worktree) {
        if (agent.model) throw new OrcoError('invalid', `Bridge config: agent ${agent.name} runs a model, which has no files to work in; drop worktree`);
        const settings = agent.worktree === true ? { branch_prefix: 'orco/', fetch: true } : agent.worktree;
        const repo = 'repo' in settings && settings.repo ? resolveDir(baseDir, settings.repo) : cwd;
        if (!repo) throw new OrcoError('invalid', `Bridge config: agent ${agent.name} needs cwd (or worktree.repo) to know which repository to branch`);
        worktree = {
          repo,
          base: 'base' in settings ? settings.base : undefined,
          dir: 'dir' in settings && settings.dir ? resolveDir(baseDir, settings.dir) : undefined,
          branch_prefix: settings.branch_prefix,
          fetch: settings.fetch,
        };
      }
      return {
        ...agent,
        token_env: agent.token_env ?? `ORCO_TOKEN_${agent.name.toUpperCase().replace(/-/g, '_')}`,
        token_file: agent.token_file ? resolveDir(baseDir, agent.token_file) : undefined,
        command: agent.command ?? preset?.command ?? [],
        lifecycle,
        prompt_template,
        cwd,
        worktree,
      };
    }),
  };
}

export function loadBridgeConfig(path: string): BridgeConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new OrcoError('not_found', `Cannot read bridge config ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new OrcoError('invalid', `Bridge config ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseBridgeConfig(raw, dirname(resolve(path)));
}

/** An agent's token: from its token_file if it has one, else from its environment variable. */
export function agentToken(agent: BridgeAgentConfig, env: NodeJS.ProcessEnv): string | undefined {
  if (agent.token_file) {
    try {
      return readFileSync(agent.token_file, 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return env[agent.token_env];
}
