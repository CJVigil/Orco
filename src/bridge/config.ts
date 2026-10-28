import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as z from 'zod/v4';
import { OrcoError } from '../errors.js';
import { BRIDGE_PROMPT, CLI_PROMPT, PRESET_NAMES, PRESETS } from './presets.js';

const modelSchema = z.object({
  /** An OpenAI-compatible API: Ollama (http://localhost:11434/v1), LM Studio, vLLM, OpenRouter, ... */
  base_url: z.url(),
  name: z.string().min(1),
  api_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  max_turns: z.number().int().min(1).max(200).default(40),
  temperature: z.number().min(0).max(2).optional(),
  /** Orco tools the model may call; defaults to the tools a task needs. */
  tools: z.array(z.string()).optional(),
});

const agentSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  token_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'token_env must name an environment variable, like ORCO_TOKEN_CLAUDE'),
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
});

const configSchema = z.object({
  server: z.url(),
  agents: z.array(agentSchema).min(1),
});

export type ModelConfig = z.infer<typeof modelSchema>;
/** An agent as the bridge runs it: a preset resolved into its command, lifecycle and prompt. */
export type BridgeAgentConfig = Omit<z.infer<typeof agentSchema>, 'command' | 'lifecycle'> & {
  command: string[];
  lifecycle: 'agent' | 'bridge';
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
      return {
        ...agent,
        command: agent.command ?? preset?.command ?? [],
        lifecycle,
        prompt_template,
        cwd: agent.cwd ? resolveDir(baseDir, agent.cwd) : undefined,
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
