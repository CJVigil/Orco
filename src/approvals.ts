import { OrcoError } from './errors.js';
import type { Participant, Room, Store } from './store.js';

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired';
export type ApprovalKind = 'action' | 'task';

export interface Approval {
  id: number;
  kind: ApprovalKind;
  room: string;
  projectId: number | null;
  messageId: number;
  requester: string;
  requesterOwner: string | null;
  approver: string | null;
  summary: string;
  details: string | null;
  state: ApprovalState;
  decidedBy: string | null;
  note: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

export interface ApprovalSummary {
  id: number;
  kind: ApprovalKind;
  state: ApprovalState;
  approver: string | null;
}

interface ApprovalRow {
  id: number;
  kind: ApprovalKind;
  room_id: number;
  project_id: number | null;
  project: string | null;
  room: string;
  message_id: number;
  requester_id: number;
  requester: string;
  requester_owner_id: number | null;
  requester_owner: string | null;
  approver_id: number | null;
  approver: string | null;
  summary: string;
  details: string | null;
  state: ApprovalState;
  decided_by: string | null;
  note: string | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
}

const APPROVAL_SELECT = `
  SELECT ap.id, ap.kind, ap.room_id, r.project_id, p.name AS project, r.name AS room, ap.message_id,
         ap.requester_id, rq.name AS requester, rq.owner_id AS requester_owner_id, rqo.name AS requester_owner,
         ap.approver_id, av.name AS approver, ap.summary, ap.details, ap.state, d.name AS decided_by, ap.note,
         ap.created_at, ap.expires_at, ap.decided_at
  FROM approvals ap
  JOIN rooms r ON r.id = ap.room_id
  LEFT JOIN projects p ON p.id = r.project_id
  JOIN participants rq ON rq.id = ap.requester_id
  LEFT JOIN participants rqo ON rqo.id = rq.owner_id
  LEFT JOIN participants av ON av.id = ap.approver_id
  LEFT JOIN participants d ON d.id = ap.decided_by
`;

export const DEFAULT_APPROVAL_TTL_SECONDS = 3600;
export const MAX_APPROVAL_TTL_SECONDS = 7 * 24 * 3600;
const TASK_APPROVAL_TTL_MS = 100 * 365 * 24 * 3600 * 1000;
const MAX_SUMMARY = 300;
const MAX_DETAILS = 4_000;

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    kind: row.kind,
    room: row.project ? `${row.project}/${row.room}` : row.room,
    projectId: row.project_id,
    messageId: row.message_id,
    requester: row.requester,
    requesterOwner: row.requester_owner,
    approver: row.approver,
    summary: row.summary,
    details: row.details,
    state: row.state,
    decidedBy: row.decided_by,
    note: row.note,
    createdAt: iso(row.created_at)!,
    expiresAt: iso(row.expires_at)!,
    decidedAt: iso(row.decided_at),
  };
}

export class Approvals {
  constructor(private readonly store: Store) {}

  request(
    actor: Participant,
    input: { room: string; summary: string; details?: string; approver?: 'owner' | 'members'; ttlSeconds?: number },
  ): Approval {
    const summary = input.summary.trim();
    if (!summary) throw new OrcoError('invalid', 'Say what needs approval');
    if (summary.length > MAX_SUMMARY) throw new OrcoError('invalid', `Keep the summary under ${MAX_SUMMARY} characters`);
    const details = input.details?.trim() || null;
    if (details && details.length > MAX_DETAILS) throw new OrcoError('invalid', `Details are over ${MAX_DETAILS} characters`);
    const ttl = input.ttlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > MAX_APPROVAL_TTL_SECONDS) {
      throw new OrcoError('invalid', `Approval TTL must be 60-${MAX_APPROVAL_TTL_SECONDS} seconds`);
    }
    const mode = input.approver ?? (actor.kind === 'agent' ? 'owner' : 'members');
    if (mode === 'owner' && actor.ownerId === null) throw new OrcoError('invalid', 'People have no owner; use approver "members"');
    const room = this.store.room(actor, input.room);

    const approver = mode === 'owner' ? this.store.participantById(actor.ownerId!) : null;
    const notify = approver ? [approver.name] : this.deciders(actor, room).map((p) => p.name);
    const ping = notify.length ? `${notify.map((n) => `@${n}`).join(' ')} ` : '';
    const text = `${ping}Approval needed: ${summary}${details ? `\n${details}` : ''}`;
    let id = 0;
    this.store.post(actor, room.ref, text, undefined, {
      onInsert: (messageId) => {
        id = this.insert('action', room, messageId, actor, approver?.id ?? null, summary, details, ttl * 1000);
      },
    });
    this.store.audit.record(actor, 'approval.request', {
      projectId: room.projectId,
      subject: `approval:${id}`,
      detail: { room: room.ref, summary, approver: approver?.name ?? 'members', expiresInSeconds: ttl },
    });
    return this.changed(id);
  }

  /** An approval only one named person can decide, posted in a room (used for leases on secrets). */
  requestFrom(actor: Participant, roomRef: string, approver: Participant, summary: string, details: string | null, ttlSeconds: number): Approval {
    if (approver.kind !== 'user') throw new OrcoError('invalid', 'Only a person can be asked to approve');
    const room = this.store.room(actor, roomRef);
    let id = 0;
    this.store.post(actor, room.ref, `@${approver.name} Approval needed: ${summary}${details ? `\n${details}` : ''}`, undefined, {
      skipRateLimit: true,
      onInsert: (messageId) => {
        id = this.insert('action', room, messageId, actor, approver.id, summary.slice(0, MAX_SUMMARY), details, ttlSeconds * 1000);
      },
    });
    this.store.audit.record(actor, 'approval.request', { projectId: room.projectId, subject: `approval:${id}`, detail: { room: room.ref, summary, approver: approver.name } });
    return this.changed(id);
  }

  createForTask(actor: Participant, room: Room, messageId: number, approver: Participant, summary: string): number {
    return this.insert('task', room, messageId, actor, approver.id, summary, null, TASK_APPROVAL_TTL_MS);
  }

  decide(
    actor: Participant,
    id: number,
    decision: 'approved' | 'denied',
    note?: string,
    options: { alwaysAllow?: boolean } = {},
  ): Approval {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people can approve or deny');
    this.expireDue();
    const row = this.row(id);
    if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No approval ${id}`);
    if (row.state !== 'pending') throw new OrcoError('conflict', `Approval ${id} is already ${row.state}`);
    if (row.approver_id !== null ? row.approver_id !== actor.id : !this.isDecider(actor, row)) {
      throw new OrcoError('forbidden', row.approver ? `Only ${row.approver} can decide this` : 'You cannot decide your own request');
    }
    const trimmedNote = note?.trim().slice(0, MAX_DETAILS) || null;
    this.store.db
      .prepare('UPDATE approvals SET state = ?, decided_by = ?, note = ?, decided_at = ? WHERE id = ?')
      .run(decision, actor.id, trimmedNote, this.store.now(), id);
    this.store.audit.record(actor, 'approval.decide', {
      projectId: row.project_id,
      subject: `approval:${id}`,
      detail: { decision, note: trimmedNote, kind: row.kind },
    });

    if (row.kind === 'task') {
      const task = this.store.tasks.forApproval(id);
      this.store.tasks.resolveApproval(actor, id, decision, trimmedNote);
      if (options.alwaysAllow && decision === 'approved' && task) {
        const requester = this.store.participantByName(task.requester)!;
        const human = this.store.participantById(this.store.humanOf(requester))!;
        this.store.setTrust(actor, task.assignee, human.name, true);
      }
    } else {
      const verb = decision === 'approved' ? 'Approved' : 'Denied';
      this.store.post(
        actor,
        toApproval(row).room,
        `@${row.requester} ${verb} by ${actor.name}.${trimmedNote ? `\n${trimmedNote}` : ''}`,
        row.message_id,
      );
      this.store.schedules.onApproval(id, decision, actor);
      this.store.secrets.onApproval(id, decision, actor);
    }
    return this.changed(id);
  }

  withdraw(id: number): void {
    this.store.db.prepare("UPDATE approvals SET state = 'expired', decided_at = ? WHERE id = ? AND state = 'pending'").run(this.store.now(), id);
    this.changed(id);
  }

  get(actor: Participant, id: number): Approval {
    this.expireDue();
    const row = this.row(id);
    if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No approval ${id}`);
    return toApproval(row);
  }

  async wait(actor: Participant, id: number, timeoutMs: number, signal?: AbortSignal): Promise<Approval> {
    const current = this.get(actor, id);
    if (current.state !== 'pending' || timeoutMs <= 0) return current;
    await new Promise<void>((resolve) => {
      const done = (changed?: Approval) => {
        if (changed && changed.id !== id) return;
        clearTimeout(timer);
        this.store.events.off('approval', done);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => done();
      const timer = setTimeout(() => done(), Math.min(timeoutMs, Math.max(Date.parse(current.expiresAt) - this.store.now(), 0) + 50));
      this.store.events.on('approval', done);
      signal?.addEventListener('abort', onAbort);
    });
    return this.get(actor, id);
  }

  list(actor: Participant, filter: { pending?: boolean; forMe?: boolean; room?: string; limit?: number } = {}): Approval[] {
    this.expireDue();
    const where: string[] = [];
    const params: (number | string)[] = [];
    if (filter.pending) where.push("ap.state = 'pending'");
    if (filter.room) {
      where.push('ap.room_id = ?');
      params.push(this.store.room(actor, filter.room).id);
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = this.store.db
      .prepare(`${APPROVAL_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ap.id DESC LIMIT ?`)
      .all(...params, limit) as unknown as ApprovalRow[];
    return rows
      .filter((row) => this.store.canSee(actor, row.project_id))
      .filter((row) => !filter.forMe || (row.approver_id !== null ? row.approver_id === actor.id : this.isDecider(actor, row)))
      .map(toApproval);
  }

  summaryForMessage(messageId: number): ApprovalSummary | null {
    const row = this.store.db
      .prepare(
        `SELECT ap.id, ap.kind, ap.state, ap.expires_at, av.name AS approver
         FROM approvals ap LEFT JOIN participants av ON av.id = ap.approver_id
         WHERE ap.message_id = ? ORDER BY ap.id DESC LIMIT 1`,
      )
      .get(messageId) as (ApprovalSummary & { expires_at: number }) | undefined;
    if (!row) return null;
    const state = row.state === 'pending' && row.expires_at <= this.store.now() ? 'expired' : row.state;
    return { id: row.id, kind: row.kind, state, approver: row.approver };
  }

  /**
   * Re-sends a pending approval once after `escalateHours`. The approver never changes: consent stays
   * with whoever it belonged to.
   */
  remindDue(): number {
    const hours = this.store.limits.escalateHours;
    if (hours <= 0) return 0;
    const now = this.store.now();
    const rows = this.store.db
      .prepare(`${APPROVAL_SELECT} WHERE ap.state = 'pending' AND ap.reminded_at IS NULL AND ap.created_at < ? AND ap.expires_at > ?`)
      .all(now - hours * 3600_000, now) as unknown as ApprovalRow[];
    for (const row of rows) {
      this.store.db.prepare('UPDATE approvals SET reminded_at = ? WHERE id = ?').run(now, row.id);
      const room = this.store.db.prepare('SELECT r.id, r.project_id, p.name AS project, r.name FROM rooms r LEFT JOIN projects p ON p.id = r.project_id WHERE r.id = ?').get(row.room_id) as {
        id: number;
        project_id: number | null;
        project: string | null;
        name: string;
      };
      const requester = this.store.participantById(row.requester_id)!;
      const roomRef = room.project ? `${room.project}/${room.name}` : room.name;
      const who = row.approver
        ? [row.approver]
        : this.deciders(requester, { id: room.id, projectId: room.project_id, project: room.project, name: room.name, ref: roomRef }).map((p) => p.name);
      if (who.length === 0) continue;
      this.store.post(requester, roomRef, `${who.map((n) => `@${n}`).join(' ')} Still waiting for a decision on this (asked ${hours} hours ago).`, row.message_id, {
        skipRateLimit: true,
      });
      this.store.audit.record(null, 'approval.remind', { projectId: room.project_id, subject: `approval:${row.id}`, detail: { hours } });
    }
    return rows.length;
  }

  expireDue(): void {
    const due = this.store.db
      .prepare("SELECT id FROM approvals WHERE state = 'pending' AND expires_at <= ?")
      .all(this.store.now()) as unknown as { id: number }[];
    for (const { id } of due) {
      this.store.db.prepare("UPDATE approvals SET state = 'expired', decided_at = ? WHERE id = ? AND state = 'pending'").run(this.store.now(), id);
      const row = this.row(id)!;
      this.store.audit.record(null, 'approval.expire', { projectId: row.project_id, subject: `approval:${id}` });
      this.store.events.emit('approval', toApproval(row));
    }
  }

  private insert(
    kind: 'action' | 'task',
    room: Room,
    messageId: number,
    requester: Participant,
    approverId: number | null,
    summary: string,
    details: string | null,
    ttlMs: number,
  ): number {
    const now = this.store.now();
    const { lastInsertRowid } = this.store.db
      .prepare(
        `INSERT INTO approvals (kind, room_id, message_id, requester_id, approver_id, summary, details, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(kind, room.id, messageId, requester.id, approverId, summary, details, now, now + ttlMs);
    return Number(lastInsertRowid);
  }

  private deciders(actor: Participant, room: Room): Participant[] {
    const requesterHuman = this.store.humanOf(actor);
    return this.store
      .listParticipants()
      .filter((p) => p.kind === 'user' && p.id !== requesterHuman && this.store.canSee(p, room.projectId));
  }

  private isDecider(actor: Participant, row: ApprovalRow): boolean {
    const requesterHuman = row.requester_owner_id ?? row.requester_id;
    return actor.kind === 'user' && actor.id !== requesterHuman && this.store.canSee(actor, row.project_id);
  }

  private row(id: number): ApprovalRow | undefined {
    return this.store.db.prepare(`${APPROVAL_SELECT} WHERE ap.id = ?`).get(id) as ApprovalRow | undefined;
  }

  private changed(id: number): Approval {
    const approval = toApproval(this.row(id)!);
    this.store.events.emit('approval', approval);
    return approval;
  }
}
