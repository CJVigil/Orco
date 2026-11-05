import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/*
 * Plain ticket titles (#139). Boards are read by people outside the work, so titles use plain words,
 * like "Checkout: refunds post twice". Each project has rules (these defaults until an admin changes
 * them): "Area: outcome", at most 70 characters, and no file paths, code identifiers or listed code
 * names. Titles are never refused; a title that breaks a rule gets a note naming it, and the board
 * can list such tickets for a person to fix.
 */
export interface TitleRules {
  /** "area_outcome": the title starts with a capitalised area, a colon and the outcome. */
  pattern: 'area_outcome' | 'none';
  maxLength: number;
  avoidPaths: boolean;
  avoidIdentifiers: boolean;
  /** Internal names people outside the work would not know. */
  codeNames: string[];
}

export const DEFAULT_TITLE_RULES: TitleRules = { pattern: 'area_outcome', maxLength: 70, avoidPaths: true, avoidIdentifiers: true, codeNames: [] };

const PATH = /(?:^|[\s(])(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|c|h|json|ya?ml|toml|md|sql|css|scss|html|sh|ps1)\b/i;
const CAMEL = /\b[a-z]+[A-Z][A-Za-z0-9]*\b/;
const SNAKE = /\b[a-z0-9]+_[a-z0-9_]+\b/;
const CALL = /\b\w+\(\)/;
const COMMIT_PREFIX = /^(?:feat|fix|chore|refactor|docs|test|perf|build|ci|style)(?:\([^)]*\))?!?:/i;

/** The first rule a title breaks, in words, or null. */
export function titleIssue(title: string, rules: TitleRules = DEFAULT_TITLE_RULES): string | null {
  const t = title.trim();
  if (t.length > rules.maxLength) return `Titles are at most ${rules.maxLength} characters (this one is ${t.length})`;
  if (rules.avoidPaths && PATH.test(t)) return 'Leave file paths and file names out of the title; put them in the description';
  if (rules.avoidIdentifiers && (COMMIT_PREFIX.test(t) || CAMEL.test(t) || SNAKE.test(t) || CALL.test(t))) {
    return 'Use plain words, not code: no commit prefixes like fix(...), function names or camelCase/snake_case identifiers';
  }
  const lower = t.toLowerCase();
  const named = rules.codeNames.find((n) => n && new RegExp(`\\b${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower));
  if (named) return `"${named}" is an internal name; say what it is in plain words`;
  if (rules.pattern === 'area_outcome' && !/^[A-Z0-9][^:]{0,40}: \S/.test(t)) return 'Start with the area, then the outcome, like "Checkout: refunds post twice"';
  return null;
}

/** One line for tool descriptions and the New ticket hint. */
export function describeRules(rules: TitleRules = DEFAULT_TITLE_RULES): string {
  const parts = [
    rules.pattern === 'area_outcome' ? '"Area: outcome" in plain words' : 'plain words',
    `at most ${rules.maxLength} characters`,
    rules.avoidPaths ? 'no file paths' : null,
    rules.avoidIdentifiers ? 'no code identifiers or commit prefixes' : null,
    rules.codeNames.length ? `not ${rules.codeNames.join(', ')}` : null,
  ].filter(Boolean);
  return parts.join(', ');
}

export class TitleRulesStore {
  constructor(private readonly store: Store) {}

  forProject(projectId: number): TitleRules {
    const row = this.store.db.prepare('SELECT title_rules FROM projects WHERE id = ?').get(projectId) as { title_rules: string | null } | undefined;
    return row?.title_rules ? { ...DEFAULT_TITLE_RULES, ...(JSON.parse(row.title_rules) as Partial<TitleRules>) } : DEFAULT_TITLE_RULES;
  }

  /** Project admins set the rules; people only. */
  set(actor: Participant, project: string, input: Partial<TitleRules>): TitleRules {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people set title rules');
    const p = this.store.visibleProject(actor, project);
    if (this.store.roleIn(actor, p.id) !== 'admin' && !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only project admins set title rules');
    const current = this.forProject(p.id);
    const maxLength = input.maxLength === undefined ? current.maxLength : Number(input.maxLength);
    if (!Number.isInteger(maxLength) || maxLength < 20 || maxLength > 200) throw new OrcoError('invalid', 'The length cap is 20-200 characters');
    const pattern = input.pattern ?? current.pattern;
    if (pattern !== 'area_outcome' && pattern !== 'none') throw new OrcoError('invalid', 'The pattern is area_outcome or none');
    const codeNames = (input.codeNames ?? current.codeNames).map((n) => String(n).trim()).filter(Boolean).slice(0, 30);
    if (codeNames.some((n) => n.length > 40)) throw new OrcoError('invalid', 'Code names are at most 40 characters');
    const rules: TitleRules = {
      pattern,
      maxLength,
      avoidPaths: input.avoidPaths ?? current.avoidPaths,
      avoidIdentifiers: input.avoidIdentifiers ?? current.avoidIdentifiers,
      codeNames,
    };
    this.store.db.prepare('UPDATE projects SET title_rules = ? WHERE id = ?').run(JSON.stringify(rules), p.id);
    this.store.audit.record(actor, 'project.title_rules', { projectId: p.id, subject: `project:${p.name}`, detail: rules });
    return rules;
  }
}
