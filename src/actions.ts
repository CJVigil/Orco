import { createHash } from 'node:crypto';
import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';
import type { Task } from './tasks.js';

/*
 * Project actions (#133): one-tap buttons that start a saved agent request. A tap creates an ordinary
 * task from the person who tapped, so project policies, budgets, pauses and the safety filter apply.
 *
 * The agent's owner can approve an action once: from then on a tap starts the agent without asking,
 * like a standing approval for that exact request. The approval is tied to a hash of the agent, room
 * and request text, so editing any of them asks the owner again.
 */
const MAX_LABEL = 40;
const MAX_REQUEST = 4000;
const MAX_FIELDS = 5;
const MAX_FIELD_VALUE = 200;
const MAX_PER_PROJECT = 30;

export interface ProjectAction {
  id: number;
  project: string;
  label: string;
  agent: string;
  room: string;
  request: string;
  /** Fill-in fields named in the request as {{name}}. */
  fields: string[];
  budgetMinutes: number | null;
  budgetCents: number | null;
  /** True while the agent's owner's approval still matches the current text. */
  approved: boolean;
  approvedBy: string | null;
  createdBy: string;
  updatedAt: string;
}

interface Row {
  id: number;
  project_id: number;
  project: string;
  label: string;
  agent_id: number;
  agent: string;
  agent_owner_id: number;
  room_id: number;
  room: string;
  request: string;
  budget_minutes: number | null;
  budget_cents: number | null;
  approved_hash: string | null;
  approver: string | null;
  creator: string;
  updated_at: string;
}

const SELECT = `
  SELECT a.id, a.project_id, p.name AS project, a.label, a.agent_id, ag.name AS agent, ag.owner_id AS agent_owner_id,
         a.room_id, r.name AS room, a.request, a.budget_minutes, a.budget_cents, a.approved_hash, ap.name AS approver,
         c.name AS creator, a.updated_at
  FROM project_actions a
  JOIN projects p ON p.id = a.project_id
  JOIN participants ag ON ag.id = a.agent_id
  JOIN rooms r ON r.id = a.room_id
  JOIN participants c ON c.id = a.created_by
  LEFT JOIN participants ap ON ap.id = a.approved_by
`;

/** The {{name}} fields in a request, in order, once each. */
export function fieldsOf(request: string): string[] {
  return [...new Set([...request.matchAll(/\{\{\s*([a-z][a-z0-9_]{0,30})\s*\}\}/gi)].map((m) => m[1]!.toLowerCase()))];
}

/** The request with its fields filled in. Values are one line each, with no mentions. */
export function fill(request: string, values: Record<string, unknown>): string {
  return request.replace(/\{\{\s*([a-z][a-z0-9_]{0,30})\s*\}\}/gi, (_m, name: string) => {
    const raw = values[name.toLowerCase()];
    const value = String(raw ?? '').replace(/\s+/g, ' ').replace(/@/g, '＠').trim();
    if (!value) throw new OrcoError('invalid', `Fill in ${name}`);
    if (value.length > MAX_FIELD_VALUE) throw new OrcoError('invalid', `${name} is at most ${MAX_FIELD_VALUE} characters`);
    return value;
  });
}

const fingerprint = (row: { agent_id: number; room_id: number; request: string }) =>
  createHash('sha256').update(`${row.agent_id}\n${row.room_id}\n${row.request}`).digest('hex');

export class Actions {
  constructor(private readonly store: Store) {}

  private toAction(row: Row): ProjectAction {
    return {
      id: row.id,
      project: row.project,
      label: row.label,
      agent: row.agent,
      room: `${row.project}/${row.room}`,
      request: row.request,
      fields: fieldsOf(row.request),
      budgetMinutes: row.budget_minutes,
      budgetCents: row.budget_cents,
      approved: row.approved_hash !== null && row.approved_hash === fingerprint(row),
      approvedBy: row.approved_hash !== null && row.approved_hash === fingerprint(row) ? row.approver : null,
      createdBy: row.creator,
      updatedAt: row.updated_at,
    };
  }

  private row(actor: Participant, id: number): Row {
    const row = this.store.db.prepare(`${SELECT} WHERE a.id = ?`).get(id) as unknown as Row | undefined;
    if (!row || !this.store.canSee(actor, row.project_id)) throw new OrcoError('not_found', `No action ${id}`);
    return row;
  }

  list(actor: Participant, project: string): ProjectAction[] {
    const p = this.store.visibleProject(actor, project);
    return (this.store.db.prepare(`${SELECT} WHERE a.project_id = ? ORDER BY a.label`).all(p.id) as unknown as Row[]).map((r) => this.toAction(r));
  }

  /** Every action in the projects the actor can see, for the buttons in Needs you. */
  mine(actor: Participant): ProjectAction[] {
    return (this.store.db.prepare(`${SELECT} ORDER BY p.name, a.label`).all() as unknown as Row[]).filter((r) => this.store.canSee(actor, r.project_id)).map((r) => this.toAction(r));
  }

  private assertAdmin(actor: Participant, projectId: number) {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people set up actions');
    if (this.store.roleIn(actor, projectId) !== 'admin' && !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only project admins set up actions');
  }

  private checked(actor: Participant, project: { id: number; name: string }, input: { label?: string; agent?: string; room?: string; request?: string; budgetMinutes?: number | null; budgetCents?: number | null }) {
    const label = (input.label ?? '').trim();
    if (!label || label.length > MAX_LABEL) throw new OrcoError('invalid', `Label the action in 1-${MAX_LABEL} characters, like "Daily numbers"`);
    const request = (input.request ?? '').trim();
    if (!request) throw new OrcoError('invalid', 'Say what the agent should do');
    if (request.length > MAX_REQUEST) throw new OrcoError('invalid', `The request is at most ${MAX_REQUEST} characters`);
    if (fieldsOf(request).length > MAX_FIELDS) throw new OrcoError('invalid', `At most ${MAX_FIELDS} fill-in fields`);
    const agent = this.store.participantByName(String(input.agent ?? '').replace(/^@/, ''));
    if (!agent || agent.kind !== 'agent') throw new OrcoError('not_found', `No agent named ${input.agent}`);
    if (!this.store.canSee(agent, project.id)) throw new OrcoError('forbidden', `${agent.name} cannot see ${project.name}`);
    const roomName = String(input.room ?? 'general').replace(new RegExp(`^${project.name}/`), '').replace(/^#/, '');
    const room = this.store.room(actor, `${project.name}/${roomName}`);
    for (const [name, v] of [['minutes', input.budgetMinutes], ['cents', input.budgetCents]] as const) {
      if (v !== undefined && v !== null && !(Number.isInteger(v) && v > 0)) throw new OrcoError('invalid', `The budget ${name} is a whole number above 0`);
    }
    return { label, request, agentId: agent.id, roomId: room.id, budgetMinutes: input.budgetMinutes ?? null, budgetCents: input.budgetCents ?? null };
  }

  create(actor: Participant, project: string, input: Parameters<Actions['checked']>[2]): ProjectAction {
    const p = this.store.visibleProject(actor, project);
    this.assertAdmin(actor, p.id);
    const count = (this.store.db.prepare('SELECT count(*) AS n FROM project_actions WHERE project_id = ?').get(p.id) as { n: number }).n;
    if (count >= MAX_PER_PROJECT) throw new OrcoError('conflict', `${p.name} has ${MAX_PER_PROJECT} actions already`);
    const c = this.checked(actor, p, input);
    const now = new Date(this.store.now()).toISOString();
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO project_actions (project_id, label, agent_id, room_id, request, budget_minutes, budget_cents, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, c.label, c.agentId, c.roomId, c.request, c.budgetMinutes, c.budgetCents, actor.id, now, now);
    const id = Number(lastInsertRowid);
    // The owner setting up an action for their own agent has approved it by writing it.
    const agent = this.store.participantById(c.agentId)!;
    if (agent.ownerId === actor.id) this.markApproved(actor, id);
    this.store.audit.record(actor, 'action.create', { projectId: p.id, subject: `action:${id}`, detail: { label: c.label, agent: agent.name, request: c.request } });
    this.store.events.emit('actions', { projectId: p.id });
    return this.toAction(this.row(actor, id));
  }

  update(actor: Participant, id: number, input: Parameters<Actions['checked']>[2]): ProjectAction {
    const row = this.row(actor, id);
    this.assertAdmin(actor, row.project_id);
    const current = this.toAction(row);
    const c = this.checked(actor, { id: row.project_id, name: row.project }, {
      label: input.label ?? current.label,
      agent: input.agent ?? current.agent,
      room: input.room ?? current.room,
      request: input.request ?? current.request,
      budgetMinutes: input.budgetMinutes !== undefined ? input.budgetMinutes : current.budgetMinutes,
      budgetCents: input.budgetCents !== undefined ? input.budgetCents : current.budgetCents,
    });
    this.store.db
      .prepare('UPDATE project_actions SET label = ?, agent_id = ?, room_id = ?, request = ?, budget_minutes = ?, budget_cents = ?, updated_at = ? WHERE id = ?')
      .run(c.label, c.agentId, c.roomId, c.request, c.budgetMinutes, c.budgetCents, new Date(this.store.now()).toISOString(), id);
    // A changed request, agent or room no longer matches the approval's hash: taps ask again until re-approved.
    const agent = this.store.participantById(c.agentId)!;
    if (agent.ownerId === actor.id) this.markApproved(actor, id);
    this.store.audit.record(actor, 'action.update', { projectId: row.project_id, subject: `action:${id}`, detail: { label: c.label, agent: agent.name, request: c.request } });
    this.store.events.emit('actions', { projectId: row.project_id });
    return this.toAction(this.row(actor, id));
  }

  delete(actor: Participant, id: number): void {
    const row = this.row(actor, id);
    this.assertAdmin(actor, row.project_id);
    this.store.db.prepare('DELETE FROM project_actions WHERE id = ?').run(id);
    this.store.audit.record(actor, 'action.delete', { projectId: row.project_id, subject: `action:${id}`, detail: { label: row.label } });
    this.store.events.emit('actions', { projectId: row.project_id });
  }

  private markApproved(actor: Participant, id: number) {
    const row = this.store.db.prepare(`${SELECT} WHERE a.id = ?`).get(id) as unknown as Row;
    this.store.db.prepare('UPDATE project_actions SET approved_hash = ?, approved_by = ?, approved_at = ? WHERE id = ?').run(fingerprint(row), actor.id, new Date(this.store.now()).toISOString(), id);
  }

  /** The agent's owner approves this exact action; only people, and only the owner. */
  approve(actor: Participant, id: number, approve = true): ProjectAction {
    const row = this.row(actor, id);
    if (actor.kind !== 'user' || row.agent_owner_id !== actor.id) throw new OrcoError('forbidden', `Only ${row.agent}'s owner approves its actions`);
    if (approve) this.markApproved(actor, id);
    else this.store.db.prepare('UPDATE project_actions SET approved_hash = NULL, approved_by = NULL, approved_at = NULL WHERE id = ?').run(id);
    this.store.audit.record(actor, approve ? 'action.approve' : 'action.unapprove', { projectId: row.project_id, subject: `action:${id}`, detail: { label: row.label, request: row.request } });
    this.store.events.emit('actions', { projectId: row.project_id });
    return this.toAction(this.row(actor, id));
  }

  /** A tap: an ordinary task from the person who tapped. */
  run(actor: Participant, id: number, values: Record<string, unknown> = {}): Task {
    const row = this.row(actor, id);
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Actions are buttons for people; agents use create_task');
    const action = this.toAction(row);
    const request = fill(row.request, values);
    const task = this.store.tasks.create(actor, {
      agent: row.agent,
      room: action.room,
      request: `${request}\n(From the "${row.label}" action.)`,
      budgetMinutes: row.budget_minutes,
      budgetCents: row.budget_cents,
      ownerConsented: action.approved,
    });
    this.store.audit.record(actor, 'action.run', { projectId: row.project_id, subject: `action:${id}`, detail: { taskId: task.id, approved: action.approved } });
    return task;
  }
}
