import { PLAN_INDEX, planTemplate } from './checklists.js';
import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/**
 * A new numbered plan (#110): plans/NNN-<slug>.md from the team's template, and its row in
 * plans/README.md (made on first use). Returns the new file's path.
 */
export function newPlan(store: Store, actor: Participant, project: string, title: string): { path: string; number: string } {
  const clean = title.trim().replace(/\s+/g, ' ');
  if (!clean || clean.length > 120) throw new OrcoError('invalid', 'A plan needs a title of at most 120 characters');
  const existing = store.files.list(actor, project, 'plans/').map((f) => /^plans\/(\d{3})-/.exec(f.path)?.[1]).filter((n): n is string => n !== undefined);
  const number = String(Math.max(0, ...existing.map(Number)) + 1).padStart(3, '0');
  const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'plan';
  const path = `plans/${number}-${slug}.md`;
  store.files.write(actor, project, path, planTemplate(number, clean), { note: 'New plan' });
  const index = store.files.list(actor, project, 'plans/').find((f) => f.path === 'plans/README.md');
  const row = `| [${number}](${number}-${slug}.md) | ${clean.replace(/\|/g, '/')} | | | | PROPOSED |`;
  if (!index) store.files.write(actor, project, 'plans/README.md', `${PLAN_INDEX}\n${row}\n`, { note: `Plan ${number}` });
  else {
    const current = store.files.read(actor, project, 'plans/README.md');
    store.files.write(actor, project, 'plans/README.md', `${current.content.replace(/\n*$/, '')}\n${row}\n`, { baseVersion: current.version, note: `Plan ${number}` });
  }
  return { path, number };
}
