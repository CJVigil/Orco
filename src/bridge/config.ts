import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as z from 'zod/v4';
import { OrcoError } from '../errors.js';

const agentSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  token_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'token_env must name an environment variable, like ORCO_TOKEN_CLAUDE'),
  command: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout_seconds: z.number().int().min(10).max(24 * 3600).default(1800),
  max_concurrent: z.number().int().min(1).max(8).default(1),
  prompt_template: z.string().optional(),
});

const configSchema = z.object({
  server: z.url(),
  agents: z.array(agentSchema).min(1),
});

export type BridgeAgentConfig = z.infer<typeof agentSchema>;
export type BridgeConfig = z.infer<typeof configSchema>;

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
    agents: result.data.agents.map((agent) => ({ ...agent, cwd: agent.cwd ? resolveDir(baseDir, agent.cwd) : undefined })),
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
