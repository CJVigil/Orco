import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/*
 * Definition of Done templates (#110). A checklist template belongs to a label: when a ticket gets the
 * label, the template's items become acceptance criteria on it, and the required ones must be checked
 * before the ticket can go Done. A project or org admin can override that with a one-line reason,
 * which is audited and shown on the ticket. Org templates apply to every project; a project adds its
 * own. Two ship by default: "service" (the platform checklist) and "ui" (phone width).
 */

export interface ChecklistItem {
  text: string;
  required: boolean;
}

export interface ChecklistTemplate {
  id: number;
  project: string | null;
  label: string;
  items: ChecklistItem[];
}

const MAX_ITEMS = 20;
const MAX_ITEM = 200;

interface Row {
  id: number;
  project: string | null;
  label: string;
  items: string;
}

const toTemplate = (r: Row): ChecklistTemplate => ({ id: r.id, project: r.project, label: r.label, items: JSON.parse(r.items) as ChecklistItem[] });

export class Checklists {
  constructor(private readonly store: Store) {}

  /** The templates that apply in a project: the org's, then its own. */
  forProject(projectId: number): ChecklistTemplate[] {
    return (
      this.store.db
        .prepare('SELECT c.id, p.name AS project, c.label, c.items FROM checklist_templates c LEFT JOIN projects p ON p.id = c.project_id WHERE c.project_id IS NULL OR c.project_id = ? ORDER BY c.project_id IS NOT NULL, c.id')
        .all(projectId) as unknown as Row[]
    ).map(toTemplate);
  }

  list(actor: Participant, project?: string): ChecklistTemplate[] {
    if (project) return this.forProject(this.store.visibleProject(actor, project).id);
    return (this.store.db.prepare('SELECT c.id, NULL AS project, c.label, c.items FROM checklist_templates c WHERE c.project_id IS NULL ORDER BY c.id').all() as unknown as Row[]).map(toTemplate);
  }

  /** Sets the template for a label (replacing one there), for a project (its admins) or every project (org admins). */
  set(actor: Participant, input: { project?: string | null; label: string; items: ChecklistItem[] }): ChecklistTemplate {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people set checklist templates');
    const label = (input.label ?? '').trim().toLowerCase();
    if (!label || label.length > 40) throw new OrcoError('invalid', 'Name the label (1-40 characters)');
    const items = (input.items ?? []).map((i) => ({ text: String(i.text ?? '').trim().replace(/\s+/g, ' '), required: i.required !== false })).filter((i) => i.text);
    if (!items.length || items.length > MAX_ITEMS || items.some((i) => i.text.length > MAX_ITEM)) throw new OrcoError('invalid', `A checklist has 1 to ${MAX_ITEMS} items of at most ${MAX_ITEM} characters`);
    const projectId = this.owner(actor, input.project);
    this.store.db.prepare('DELETE FROM checklist_templates WHERE project_id IS ? AND label = ?').run(projectId, label);
    const { lastInsertRowid } = this.store.db.prepare('INSERT INTO checklist_templates (project_id, label, items, created_by) VALUES (?, ?, ?, ?)').run(projectId, label, JSON.stringify(items), actor.id);
    this.store.audit.record(actor, 'checklist.set', { projectId, subject: `checklist:${label}`, detail: { items } });
    return this.list(actor, input.project ?? undefined).find((t) => t.id === Number(lastInsertRowid))!;
  }

  remove(actor: Participant, id: number): void {
    const row = this.store.db.prepare('SELECT project_id, label FROM checklist_templates WHERE id = ?').get(id) as { project_id: number | null; label: string } | undefined;
    if (!row) throw new OrcoError('not_found', `No checklist ${id}`);
    const projectName = row.project_id === null ? null : (this.store.db.prepare('SELECT name FROM projects WHERE id = ?').get(row.project_id) as { name: string }).name;
    this.owner(actor, projectName);
    this.store.db.prepare('DELETE FROM checklist_templates WHERE id = ?').run(id);
    this.store.audit.record(actor, 'checklist.remove', { projectId: row.project_id, subject: `checklist:${row.label}` });
  }

  /** The items to add for labels a ticket just got, skipping criteria it already has. */
  itemsFor(projectId: number, labels: string[], existing: string[]): (ChecklistItem & { label: string })[] {
    const have = new Set(existing.map((t) => t.toLowerCase()));
    const want = new Set(labels.map((l) => l.toLowerCase()));
    const out: (ChecklistItem & { label: string })[] = [];
    for (const template of this.forProject(projectId)) {
      if (!want.has(template.label)) continue;
      for (const item of template.items) {
        if (have.has(item.text.toLowerCase())) continue;
        have.add(item.text.toLowerCase());
        out.push({ ...item, label: template.label });
      }
    }
    return out;
  }

  private owner(actor: Participant, project: string | null | undefined): number | null {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people change checklist templates');
    if (!project) {
      if (!this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins set checklists for every project; name a project');
      return null;
    }
    const p = this.store.visibleProject(actor, project);
    if (this.store.roleIn(actor, p.id) !== 'admin' && !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', `Only admins of ${project} set its checklists`);
    return p.id;
  }
}

/** The plan format this team works in after a first release (#110): plans/NNN-<slug>.md and an index. */
export const PLAN_SECTIONS = [
  'Status',
  'Why this matters',
  'Current state',
  'Commands you will need',
  'Scope',
  'Git workflow',
  'Steps',
  'Test plan',
  'Done criteria',
  'STOP conditions',
  'Maintenance notes',
];

export const PLAN_STATUSES = ['TODO', 'IN PROGRESS', 'DONE', 'BLOCKED', 'REJECTED', 'PROPOSED'];

export function planTemplate(number: string, title: string): string {
  return [
    `# Plan ${number}: ${title}`,
    '',
    ...PLAN_SECTIONS.flatMap((section) => [
      `## ${section}`,
      '',
      section === 'Status'
        ? 'PROPOSED'
        : section === 'STOP conditions'
          ? '> Stop and ask a person before going on when any of these happens. Agents: say so with waiting_on on the ticket.'
          : section === 'Done criteria'
            ? '> Each line here is an acceptance criterion on the plan\'s ticket.'
            : '',
      '',
    ]),
  ].join('\n');
}

export const PLAN_INDEX = [
  '# Plans',
  '',
  'Executors read the whole plan first, honour its STOP conditions, and update their row here.',
  `Status is one of: ${PLAN_STATUSES.join(', ')} (BLOCKED and REJECTED with a one-line reason).`,
  '',
  '| Plan | Title | Priority | Effort | Depends on | Status |',
  '| --- | --- | --- | --- | --- | --- |',
].join('\n');
