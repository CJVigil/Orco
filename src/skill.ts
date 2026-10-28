import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { OrcoError } from './errors.js';

/**
 * Where agent tools look for Agent Skills (a folder holding SKILL.md), per user and per project.
 * Only locations their own docs give: Claude Code reads .claude/skills, Codex reads .agents/skills
 * (which other tools are adopting too). For any other tool, pass --dir.
 */
export const SKILL_TARGETS: Record<string, { user: string; project: string }> = {
  claude: { user: '.claude/skills', project: '.claude/skills' },
  codex: { user: '.agents/skills', project: '.agents/skills' },
  agents: { user: '.agents/skills', project: '.agents/skills' },
};

/** The orco skill, shared by the Claude Code plugin and every other tool. */
export function skillText(): string {
  return readFileSync(new URL('../integrations/claude-code/skills/orco/SKILL.md', import.meta.url), 'utf8');
}

/** Writes <skills dir>/orco/SKILL.md and returns its path. */
export function installSkill(options: { target?: string; dir?: string; project?: boolean; home?: string; cwd?: string }): string {
  let dir = options.dir;
  if (!dir) {
    const target = options.target ? SKILL_TARGETS[options.target] : undefined;
    if (!target) {
      throw new OrcoError('invalid', `Say where: --for ${Object.keys(SKILL_TARGETS).join('|')} [--project], or --dir <skills directory> for another tool`);
    }
    dir = options.project ? resolve(options.cwd ?? process.cwd(), target.project) : join(options.home ?? homedir(), target.user);
  }
  const path = join(resolve(options.cwd ?? process.cwd(), dir), 'orco', 'SKILL.md');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, skillText());
  return path;
}
