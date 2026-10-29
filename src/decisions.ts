import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

export interface Decision {
  id: number;
  /** Null for a decision that holds across every project. */
  project: string | null;
  title: string;
  context: string;
  options: string[];
  decision: string;
  tags: string[];
  decidedBy: string;
  at: string;
  /** The decision that replaced this one, if any. */
  supersededBy: number | null;
}

export interface DecisionInput {
  project: string | null;
  title: string;
  context?: string;
  options?: string[];
  decision: string;
  tags?: string[];
}

interface Row {
  id: number;
  project_id: number | null;
  project: string | null;
  title: string;
  context: string;
  options: string;
  decision: string;
  tags: string;
  decided_by: string;
  created_at: string;
  superseded_by: number | null;
}

const SELECT = `SELECT d.id, d.project_id, p.name AS project, d.title, d.context, d.options, d.decision, d.tags, u.name AS decided_by,
  d.created_at, d.superseded_by FROM decisions d LEFT JOIN projects p ON p.id = d.project_id JOIN participants u ON u.id = d.decided_by`;

const toDecision = (row: Row): Decision => ({
  id: row.id,
  project: row.project,
  title: row.title,
  context: row.context,
  options: JSON.parse(row.options) as string[],
  decision: row.decision,
  tags: JSON.parse(row.tags) as string[],
  decidedBy: row.decided_by,
  at: row.created_at,
  supersededBy: row.superseded_by,
});

function text(value: unknown, field: string, max: number, required = false): string {
  const out = String(value ?? '').trim();
  if (required && !out) throw new OrcoError('invalid', `${field} is required`);
  if (out.length > max) throw new OrcoError('invalid', `${field} is over ${max} characters`);
  return out;
}

function items(value: unknown, field: string, max: number, each: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new OrcoError('invalid', `${field} is a list`);
  const out = [...new Set(value.map((v) => String(v).trim()).filter(Boolean))];
  if (out.length > max || out.some((v) => v.length > each)) throw new OrcoError('invalid', `${field}: at most ${max} items of ${each} characters`);
  return out;
}

/**
 * The decision log: what was decided, why, and what else was on the table, per project or for every
 * project. People record decisions; agents read them (get_task and catch_up carry the relevant ones),
 * so settled questions stay settled. A new decision can supersede an old one.
 */
export class Decisions {
  constructor(private readonly store: Store) {}

  record(actor: Participant, input: DecisionInput, supersedes?: number): Decision {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people record decisions; propose one in the thread instead');
    let projectId: number | null = null;
    if (input.project) projectId = this.store.writableProject(actor, input.project).id;
    else if (!this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins record decisions for every project; name a project');
    const title = text(input.title, 'title', 200, true);
    const decision = text(input.decision, 'decision', 4000, true);
    const context = text(input.context, 'context', 8000);
    const options = items(input.options, 'options', 10, 500);
    const tags = items(input.tags, 'tags', 10, 32).map((t) => t.toLowerCase());
    const old = supersedes === undefined ? null : this.get(actor, supersedes);
    if (old?.supersededBy) throw new OrcoError('conflict', `Decision ${supersedes} was already superseded by ${old.supersededBy}`);
    // A decision is replaced only from where it was made: a project's in that project, an org-wide one
    // by an org admin with another org-wide decision.
    if (old && old.project !== (input.project || null)) {
      throw new OrcoError('forbidden', old.project ? `Decision ${supersedes} belongs to ${old.project}; supersede it with a decision there` : `Decision ${supersedes} is org-wide; only an org-wide decision by an org admin supersedes it`);
    }
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO decisions (project_id, title, context, options, decision, tags, decided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, title, context, JSON.stringify(options), decision, JSON.stringify(tags), actor.id, new Date(this.store.now()).toISOString());
    const id = Number(lastInsertRowid);
    if (old) this.store.db.prepare('UPDATE decisions SET superseded_by = ? WHERE id = ?').run(id, old.id);
    this.store.audit.record(actor, 'decision.record', { projectId, subject: `decision:${id}`, detail: { title, decision, supersedes: old?.id ?? null } });
    this.store.events.emit('decision', { projectId });
    return this.get(actor, id);
  }

  get(actor: Participant, id: number): Decision {
    const row = this.store.db.prepare(`${SELECT} WHERE d.id = ?`).get(id) as Row | undefined;
    if (!row || !this.store.canSee(actor, row.project_id)) throw new OrcoError('not_found', `No decision ${id}`);
    return toDecision(row);
  }

  /** Decisions the actor can see, newest first: in one project (plus org-wide ones), matching words or a tag. */
  list(actor: Participant, filter: { project?: string; query?: string; tag?: string; all?: boolean; limit?: number } = {}): Decision[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.project) {
      where.push('(d.project_id = ? OR d.project_id IS NULL)');
      params.push(this.store.visibleProject(actor, filter.project).id);
    } else {
      const visible = this.store.projectFilter(actor, 'd.project_id');
      where.push(`(d.project_id IS NULL OR ${visible.sql})`);
      params.push(...visible.params);
    }
    if (!filter.all) where.push('d.superseded_by IS NULL');
    if (filter.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(d.tags) WHERE json_each.value = ?)");
      params.push(filter.tag.toLowerCase());
    }
    for (const word of (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push("lower(d.title || ' ' || d.decision || ' ' || d.context || ' ' || d.tags) LIKE ?");
      params.push(`%${word.replace(/[%_]/g, '')}%`);
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    return (this.store.db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT ${limit}`).all(...params) as unknown as Row[]).map(toDecision);
  }

  /** Decisions in force for work in a project, newest first: the project's and the org's. */
  relevantFor(projectId: number | null, limit = 10): Decision[] {
    const rows = this.store.db
      .prepare(`${SELECT} WHERE d.superseded_by IS NULL AND (d.project_id IS NULL OR d.project_id = ?) ORDER BY d.id DESC LIMIT ?`)
      .all(projectId ?? -1, limit) as unknown as Row[];
    return rows.map(toDecision);
  }

  /** Decisions recorded after a time, for catch-up. */
  since(actor: Participant, iso: string, limit = 20): Decision[] {
    const visible = this.store.projectFilter(actor, 'd.project_id');
    const rows = this.store.db
      .prepare(`${SELECT} WHERE d.created_at > ? AND (d.project_id IS NULL OR ${visible.sql}) ORDER BY d.id DESC LIMIT ?`)
      .all(iso, ...visible.params, limit) as unknown as Row[];
    return rows.map(toDecision);
  }
}
