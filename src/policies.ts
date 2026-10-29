import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/**
 * Rules for agents, set once for the whole server by org admins and per project by project admins.
 * A project can add to the org's policy but never loosen it.
 */
export interface Policy {
  /** Plain rules agents get with every task ("Never push to main"). */
  rules: string[];
  /** Actions agents must ask a person about first, with request_approval ("deploy to production"). */
  approvalRequired: string[];
  /** Budgets given to tasks created without one. */
  defaultTaskMinutes: number | null;
  defaultTaskCents: number | null;
  /** The largest budget a task may have. */
  maxTaskMinutes: number | null;
  maxTaskCents: number | null;
  /** Only these agents may take tasks; null lets any agent that can see the project. */
  allowedAgents: string[] | null;
}

export interface PolicyView {
  org: Policy;
  project: Policy | null;
  /** What applies: the org's policy tightened by the project's. */
  effective: Policy;
  updatedBy: string | null;
  updatedAt: string | null;
}

const EMPTY: Policy = {
  rules: [],
  approvalRequired: [],
  defaultTaskMinutes: null,
  defaultTaskCents: null,
  maxTaskMinutes: null,
  maxTaskCents: null,
  allowedAgents: null,
};

const MAX_ITEMS = 30;
const MAX_ITEM = 300;

function list(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new OrcoError('invalid', `${field} is a list of short texts`);
  const items = [...new Set(value.map((v) => String(v).trim().replace(/\s+/g, ' ')).filter(Boolean))];
  if (items.length > MAX_ITEMS || items.some((i) => i.length > MAX_ITEM)) throw new OrcoError('invalid', `${field}: at most ${MAX_ITEMS} items of ${MAX_ITEM} characters`);
  return items;
}

function amount(value: unknown, field: string, max: number): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw new OrcoError('invalid', `${field} is a whole number from 1 to ${max}`);
  return value as number;
}

/** Checks a policy as sent over the API (snake_case or camelCase). */
export function parsePolicy(raw: Record<string, unknown>): Policy {
  const get = (snake: string, camel: string) => raw[snake] ?? raw[camel];
  const agents = get('allowed_agents', 'allowedAgents');
  return {
    rules: list(raw.rules, 'rules'),
    approvalRequired: list(get('approval_required', 'approvalRequired'), 'approval_required'),
    defaultTaskMinutes: amount(get('default_task_minutes', 'defaultTaskMinutes'), 'default_task_minutes', 7 * 24 * 60),
    defaultTaskCents: amount(get('default_task_cents', 'defaultTaskCents'), 'default_task_cents', 1_000_000),
    maxTaskMinutes: amount(get('max_task_minutes', 'maxTaskMinutes'), 'max_task_minutes', 7 * 24 * 60),
    maxTaskCents: amount(get('max_task_cents', 'maxTaskCents'), 'max_task_cents', 1_000_000),
    allowedAgents: agents === undefined || agents === null ? null : list(agents, 'allowed_agents'),
  };
}

const smaller = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

/** The org's policy tightened by a project's. */
export function mergePolicy(org: Policy, project: Policy | null): Policy {
  if (!project) return org;
  const maxTaskMinutes = smaller(org.maxTaskMinutes, project.maxTaskMinutes);
  const maxTaskCents = smaller(org.maxTaskCents, project.maxTaskCents);
  return {
    rules: [...new Set([...org.rules, ...project.rules])],
    approvalRequired: [...new Set([...org.approvalRequired, ...project.approvalRequired])],
    defaultTaskMinutes: smaller(project.defaultTaskMinutes ?? org.defaultTaskMinutes, maxTaskMinutes),
    defaultTaskCents: smaller(project.defaultTaskCents ?? org.defaultTaskCents, maxTaskCents),
    maxTaskMinutes,
    maxTaskCents,
    allowedAgents:
      org.allowedAgents === null ? project.allowedAgents : project.allowedAgents === null ? org.allowedAgents : org.allowedAgents.filter((a) => project.allowedAgents!.includes(a)),
  };
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export class Policies {
  constructor(private readonly store: Store) {}

  /** The org policy (org admins) or a project's (its admins). Null clears it. */
  set(actor: Participant, project: string | null, policy: Policy | null): PolicyView {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people set policies');
    let projectId: number | null = null;
    if (project === null) {
      if (!this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins set the org-wide policy');
    } else {
      projectId = this.store.adminProject(actor, project).id;
      if (policy) this.checkNotLooser(this.org(), policy);
    }
    if (policy === null) {
      this.store.db.prepare('DELETE FROM policies WHERE ifnull(project_id, 0) = ?').run(projectId ?? 0);
    } else {
      for (const name of policy.allowedAgents ?? []) {
        const agent = this.store.participantByName(name);
        if (!agent || agent.kind !== 'agent') throw new OrcoError('invalid', `allowed_agents: no agent named ${name}`);
      }
      this.store.db.prepare('DELETE FROM policies WHERE ifnull(project_id, 0) = ?').run(projectId ?? 0);
      this.store.db.prepare('INSERT INTO policies (project_id, body, updated_by) VALUES (?, ?, ?)').run(projectId, JSON.stringify(policy), actor.id);
    }
    this.store.audit.record(actor, 'policy.set', { projectId, subject: project ? `project:${project}` : 'org', detail: policy ?? { cleared: true } });
    this.store.events.emit('controls', { kind: 'policy' });
    return this.view(actor, project);
  }

  view(actor: Participant, project: string | null): PolicyView {
    const org = this.org();
    if (project === null) {
      const meta = this.meta(null);
      return { org, project: null, effective: org, ...meta };
    }
    const proj = this.store.isOrgAdmin(actor) ? this.store.adminProject(actor, project) : this.store.visibleProject(actor, project);
    const own = this.load(proj.id);
    return { org, project: own, effective: mergePolicy(org, own), ...this.meta(proj.id) };
  }

  /** What applies in a project (or server rooms, for null). */
  effective(projectId: number | null): Policy {
    return projectId === null ? this.org() : mergePolicy(this.org(), this.load(projectId));
  }

  /** The policy as lines for an agent's prompt or tool result. */
  rulesFor(projectId: number | null): string[] {
    const p = this.effective(projectId);
    const lines = [...p.rules];
    if (p.approvalRequired.length) lines.push(`Ask a person first, with request_approval, before you: ${p.approvalRequired.join('; ')}.`);
    if (p.maxTaskCents !== null || p.maxTaskMinutes !== null) {
      const caps = [p.maxTaskMinutes !== null ? `${p.maxTaskMinutes} minutes` : null, p.maxTaskCents !== null ? money(p.maxTaskCents) : null].filter(Boolean);
      lines.push(`A task here may use at most ${caps.join(' and ')}; stop and ask before going over.`);
    }
    return lines;
  }

  /** Applies the policy to a new task: who may take it, and its budget. Returns the budget to use. */
  forNewTask(projectId: number | null, assignee: string, budget: { minutes?: number | null; cents?: number | null }): { minutes: number | null; cents: number | null } {
    const p = this.effective(projectId);
    if (p.allowedAgents !== null && !p.allowedAgents.includes(assignee)) {
      throw new OrcoError('forbidden', `Policy: only ${p.allowedAgents.join(', ') || 'no agents'} may take tasks here`);
    }
    const minutes = budget.minutes ?? p.defaultTaskMinutes ?? p.maxTaskMinutes;
    const cents = budget.cents ?? p.defaultTaskCents ?? p.maxTaskCents;
    if (p.maxTaskMinutes !== null && minutes !== null && minutes > p.maxTaskMinutes) throw new OrcoError('forbidden', `Policy: a task here may have at most ${p.maxTaskMinutes} minutes`);
    if (p.maxTaskCents !== null && cents !== null && cents > p.maxTaskCents) throw new OrcoError('forbidden', `Policy: a task here may cost at most ${money(p.maxTaskCents)}`);
    return { minutes, cents };
  }

  private checkNotLooser(org: Policy, project: Policy): void {
    if (org.maxTaskMinutes !== null && project.maxTaskMinutes !== null && project.maxTaskMinutes > org.maxTaskMinutes) {
      throw new OrcoError('invalid', `The org caps tasks at ${org.maxTaskMinutes} minutes; a project can only lower that`);
    }
    if (org.maxTaskCents !== null && project.maxTaskCents !== null && project.maxTaskCents > org.maxTaskCents) {
      throw new OrcoError('invalid', `The org caps tasks at ${money(org.maxTaskCents)}; a project can only lower that`);
    }
    if (org.allowedAgents !== null && project.allowedAgents !== null) {
      const extra = project.allowedAgents.filter((a) => !org.allowedAgents!.includes(a));
      if (extra.length) throw new OrcoError('invalid', `The org does not allow ${extra.join(', ')}; a project can only narrow the list`);
    }
  }

  private org(): Policy {
    return this.load(null) ?? EMPTY;
  }

  private load(projectId: number | null): Policy | null {
    const row = this.store.db.prepare('SELECT body FROM policies WHERE ifnull(project_id, 0) = ?').get(projectId ?? 0) as { body: string } | undefined;
    return row ? { ...EMPTY, ...(JSON.parse(row.body) as Partial<Policy>) } : null;
  }

  private meta(projectId: number | null): { updatedBy: string | null; updatedAt: string | null } {
    const row = this.store.db
      .prepare('SELECT u.name, p.updated_at FROM policies p JOIN participants u ON u.id = p.updated_by WHERE ifnull(p.project_id, 0) = ?')
      .get(projectId ?? 0) as { name: string; updated_at: string } | undefined;
    return { updatedBy: row?.name ?? null, updatedAt: row?.updated_at ?? null };
  }
}
