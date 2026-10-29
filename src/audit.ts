import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

export interface AuditEntry {
  id: number;
  at: string;
  actor: string | null;
  actorKind: 'user' | 'agent' | null;
  actorOwner: string | null;
  action: string;
  project: string | null;
  subject: string | null;
  detail: unknown;
}

interface AuditRow {
  id: number;
  at: string;
  actor: string | null;
  actor_kind: 'user' | 'agent' | null;
  actor_owner: string | null;
  action: string;
  project: string | null;
  project_id: number | null;
  subject: string | null;
  detail: string | null;
}

const AUDIT_SELECT = `
  SELECT au.id, au.at, a.name AS actor, a.kind AS actor_kind, o.name AS actor_owner, au.action,
         p.name AS project, au.project_id, au.subject, au.detail
  FROM audit au
  LEFT JOIN participants a ON a.id = au.actor_id
  LEFT JOIN participants o ON o.id = a.owner_id
  LEFT JOIN projects p ON p.id = au.project_id
`;

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    actorKind: row.actor_kind,
    actorOwner: row.actor_owner,
    action: row.action,
    project: row.project,
    subject: row.subject,
    detail: row.detail === null ? null : JSON.parse(row.detail),
  };
}

export class Audit {
  constructor(private readonly store: Store) {}

  record(
    actor: Participant | null,
    action: string,
    entry: { projectId?: number | null; subject?: string; detail?: unknown } = {},
  ): void {
    this.store.db
      .prepare('INSERT INTO audit (at, actor_id, action, project_id, subject, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        new Date(this.store.now()).toISOString(),
        actor?.id ?? null,
        action,
        entry.projectId ?? null,
        entry.subject ?? null,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
      );
  }

  list(actor: Participant, options: { project?: string; sinceId?: number; limit?: number } = {}): AuditEntry[] {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people can read the audit log');
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 10_000);
    const since = options.sinceId ?? 0;
    if (options.project !== undefined) {
      const project = this.store.visibleProject(actor, options.project);
      const rows = this.store.db
        .prepare(`${AUDIT_SELECT} WHERE au.project_id = ? AND au.id > ? ORDER BY au.id LIMIT ?`)
        .all(project.id, since, limit) as unknown as AuditRow[];
      return rows.map(toEntry);
    }
    const rows = this.store.db
      .prepare(`${AUDIT_SELECT} WHERE au.id > ? ORDER BY au.id LIMIT ?`)
      .all(since, limit) as unknown as AuditRow[];
    const orgAdmin = this.store.isOrgAdmin(actor);
    const mine = new Set([
      actor.name,
      ...(this.store.db.prepare('SELECT name FROM participants WHERE owner_id = ?').all(actor.id) as { name: string }[]).map((a) => a.name),
    ]);
    return rows.filter((row) => (row.project_id === null ? orgAdmin || this.aboutMe(mine, actor, row) : this.store.canSee(actor, row.project_id))).map(toEntry);
  }

  /**
   * Entries outside any project (accounts, tokens, sign-ins, agent settings and memory, pairings) are
   * for org admins. Anyone else sees only those about themselves or their own agents, or done by them.
   */
  private aboutMe(mine: Set<string>, actor: Participant, row: AuditRow): boolean {
    if (row.actor !== null && (mine.has(row.actor) || row.actor_owner === actor.name)) return true;
    const subject = /^(?:user|agent):(.+)$/.exec(row.subject ?? '')?.[1];
    return subject !== undefined && mine.has(subject);
  }

  /**
   * What happened around one task, for people: everything recorded about it, plus everything its
   * assignee did from when the task was created until it closed. Work the agent did for other tasks
   * in the same window shows up too; the entries say what they were about.
   */
  trailForTask(actor: Participant, taskId: number): AuditEntry[] {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people can read the audit log');
    const task = this.store.tasks.get(actor, taskId);
    const assignee = this.store.participantByName(task.assignee)!;
    const subject = `task:${taskId}`;
    const start = this.store.db.prepare("SELECT min(id) AS id FROM audit WHERE subject = ? AND action = 'task.create'").get(subject) as { id: number | null };
    const end = this.store.db
      .prepare(
        `SELECT max(id) AS id FROM audit WHERE subject = ? AND action = 'task.update'
         AND json_extract(detail, '$.state') IN ('done', 'failed', 'declined', 'cancelled')`,
      )
      .get(subject) as { id: number | null };
    const rows = this.store.db
      .prepare(
        `${AUDIT_SELECT} WHERE au.subject = ? OR (au.actor_id = ? AND au.id BETWEEN ? AND ?) ORDER BY au.id LIMIT 2000`,
      )
      .all(subject, assignee.id, start.id ?? 0, end.id ?? Number.MAX_SAFE_INTEGER) as unknown as AuditRow[];
    return rows.filter((row) => this.store.canSee(actor, row.project_id)).map(toEntry);
  }

  all(sinceId = 0): AuditEntry[] {
    const rows = this.store.db.prepare(`${AUDIT_SELECT} WHERE au.id > ? ORDER BY au.id`).all(sinceId) as unknown as AuditRow[];
    return rows.map(toEntry);
  }
}
