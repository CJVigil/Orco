import { OrcoError } from './errors.js';
import { riskyKinds } from './safety.js';
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
  /** The ticket it is about, if any. */
  ticket: string | null;
  /** What exactly is approved: the steps or limits, in words. */
  scope: string | null;
  /** Once approved, until when it stays in force (null: no end given). */
  validUntil: string | null;
  /** Approved and not past validUntil. */
  inForce: boolean;
  /** A short label for the kind of action, like "push to main". */
  actionKind: string | null;
  /** Approved as "don't ask again for this kind on this ticket" until validUntil (#95). */
  standing: boolean;
  /** Outside the deploy window, or an override, shown to the approver (#112). */
  warning: string | null;
}

export interface ApprovalSummary {
  id: number;
  kind: ApprovalKind;
  state: ApprovalState;
  approver: string | null;
  ticket: string | null;
  actionKind: string | null;
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
  ticket_id: number | null;
  ticket: string | null;
  scope: string | null;
  valid_hours: number | null;
  valid_until: number | null;
  action_kind: string | null;
  standing: number;
  decided_by_id: number | null;
  warning: string | null;
}

const APPROVAL_SELECT = `
  SELECT ap.id, ap.kind, ap.room_id, r.project_id, p.name AS project, r.name AS room, ap.message_id,
         ap.requester_id, rq.name AS requester, rq.owner_id AS requester_owner_id, rqo.name AS requester_owner,
         ap.approver_id, av.name AS approver, ap.summary, ap.details, ap.state, d.name AS decided_by, ap.note,
         ap.created_at, ap.expires_at, ap.decided_at, ap.ticket_id, tp.ticket_key || '-' || tk.number AS ticket, ap.scope,
         ap.valid_hours, ap.valid_until, ap.action_kind, ap.standing, ap.decided_by AS decided_by_id, ap.warning
  FROM approvals ap
  LEFT JOIN tickets tk ON tk.id = ap.ticket_id
  LEFT JOIN projects tp ON tp.id = tk.project_id
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
const MAX_SCOPE = 2_000;
/** The longest an approval stays in force once given ("these prod pushes, until Sunday"). */
export const MAX_VALID_HOURS = 7 * 24;
/** A kind of action, like "push to main": one short line. */
export const MAX_ACTION_KIND = 40;

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function toApproval(row: ApprovalRow, now: number = Date.now()): Approval {
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
    ticket: row.ticket,
    scope: row.scope,
    validUntil: iso(row.valid_until),
    inForce: row.state === 'approved' && (row.valid_until === null || row.valid_until > now),
    actionKind: row.action_kind,
    standing: row.standing === 1 && row.state === 'approved' && row.valid_until !== null && row.valid_until > now,
    warning: row.warning,
  };
}

export class Approvals {
  constructor(private readonly store: Store) {}

  request(
    actor: Participant,
    input: {
      room?: string;
      summary: string;
      details?: string;
      approver?: 'owner' | 'members';
      ttlSeconds?: number;
      /** The ticket it is about: it shows there, and its room is the default. */
      ticket?: string;
      /** What exactly is approved: a sentence, or the steps one per line. */
      scope?: string | string[];
      /** Once approved, how long it stays in force, in hours (at most a week). */
      validForHours?: number;
      /** A short label for the kind of action ("push to main"), so a person can say "don't ask again" for it on the ticket. */
      kind?: string;
      /** An admin's reason to go ahead during a freeze or outside a deploy window (#112). */
      override?: string;
    },
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
    // An agent's gated actions are decided by its owner, never by whoever it picks: otherwise text that
    // steered the agent could also steer who approves it.
    if (actor.kind === 'agent' && input.approver === 'members') throw new OrcoError('forbidden', "An agent's approvals go to its owner");
    const mode = input.approver ?? (actor.kind === 'agent' ? 'owner' : 'members');
    if (mode === 'owner' && actor.ownerId === null) throw new OrcoError('invalid', 'People have no owner; use approver "members"');
    const ticket = input.ticket ? this.store.tickets.get(actor, input.ticket) : null;
    if (!input.room && !ticket) throw new OrcoError('invalid', 'Give a room or a ticket');
    // No repos, stacks or deploys for a project whose scope is not approved yet (#108).
    if (actor.kind === 'agent') {
      const projectId = ticket ? ticket.projectId : input.room ? this.store.room(actor, input.room).projectId : null;
      this.store.scope.assertActionAllowed(projectId, `${input.kind ?? ''}\n${summary}\n${details ?? ''}`);
    }
    const room = this.store.room(actor, input.room || this.store.tickets.workRoom(ticket!.projectId));
    const scope = (Array.isArray(input.scope) ? input.scope.map((s) => `- ${String(s).trim()}`).join('\n') : String(input.scope ?? '')).trim() || null;
    if (scope && scope.length > MAX_SCOPE) throw new OrcoError('invalid', `The scope is over ${MAX_SCOPE} characters`);
    const validHours = input.validForHours ?? null;
    if (validHours !== null && !(Number.isInteger(validHours) && validHours >= 1 && validHours <= MAX_VALID_HOURS)) {
      throw new OrcoError('invalid', `valid_for_hours is 1 to ${MAX_VALID_HOURS}`);
    }
    const actionKind = String(input.kind ?? '').replace(/\s+/g, ' ').trim() || null;
    if (actionKind && actionKind.length > MAX_ACTION_KIND) throw new OrcoError('invalid', `kind is one line of at most ${MAX_ACTION_KIND} characters`);
    // Someone already said "don't ask again" for this kind on this ticket: approved at once, on the record.
    const standing = ticket && actionKind ? this.standingFor(ticket.id, actor.id, actionKind) : null;
    // The kind is the agent's own label, so a request that looks like any risky action the approved one
    // (with its label) did not, such as a delete under "push to main", asks again.
    if (standing) {
      const approved = new Set(riskyKinds(`${standing.action_kind}\n${standing.summary}\n${standing.details ?? ''}`));
      if (riskyKinds(`${actionKind}\n${summary}\n${details ?? ''}`).every((risk) => approved.has(risk))) {
        this.store.owners.assertMayApprove(ticket!.id, `${actionKind}\n${summary}\n${details ?? ''}`, ticket!.ref);
        return this.autoApprove(actor, room, ticket!, actionKind!, summary, details, scope, standing);
      }
    }

    // Deploy windows and freezes (#112): refused during a freeze, flagged (or refused) outside a window.
    const warning = this.store.windows.check(actor, room.projectId, `${actionKind ?? ''}\n${summary}\n${details ?? ''}`, input.override);
    // Checked rules (#113): a request whose command or diff matches one is refused, naming it.
    this.store.rules.enforce(actor, 'approval', `${actionKind ?? ''}\n${summary}\n${details ?? ''}\n${Array.isArray(input.scope) ? input.scope.join('\n') : (input.scope ?? '')}`, room.ref, room.projectId);
    // The ticket's permission mode (#119): what it allows goes ahead, on the record; deploys always ask.
    if (actor.kind === 'agent' && ticket) {
      const allowed = this.store.modes.allows(ticket.id, `${actionKind ?? ''}\n${summary}\n${details ?? ''}`);
      if (allowed.yes) return this.modeApprove(actor, room, ticket, actionKind, summary, details, scope, allowed.info.label);
    }
    const approver = mode === 'owner' ? this.store.participantById(actor.ownerId!) : null;
    const notify = approver ? [approver.name] : this.deciders(actor, room).map((p) => p.name);
    const ping = notify.length ? `${notify.map((n) => `@${n}`).join(' ')} ` : '';
    const lines = [
      `${ping}Approval needed${ticket ? ` on ${ticket.ref}` : ''}: ${summary}`,
      ...(scope ? [`Scope:\n${scope}`] : []),
      ...(validHours ? [`In force for ${validHours} hours once approved.`] : []),
      ...(warning ? [`⚠ ${warning}`] : []),
      ...(details ? [details] : []),
    ];
    let id = 0;
    this.store.post(actor, room.ref, lines.join('\n'), undefined, {
      onInsert: (messageId) => {
        id = this.insert('action', room, messageId, actor, approver?.id ?? null, summary, details, ttl * 1000);
        this.store.db.prepare('UPDATE approvals SET ticket_id = ?, scope = ?, valid_hours = ?, action_kind = ?, warning = ? WHERE id = ?').run(ticket?.id ?? null, scope, validHours, actionKind, warning, id);
      },
    });
    if (ticket) this.store.tickets.note(ticket.id, actor, 'change', null, { changes: [{ field: 'approval', from: null, to: `requested #${id}: ${summary}` }] });
    this.store.audit.record(actor, 'approval.request', {
      projectId: room.projectId,
      subject: `approval:${id}`,
      detail: { room: room.ref, summary, approver: approver?.name ?? 'members', expiresInSeconds: ttl, ticket: ticket?.ref ?? null, scope, validForHours: validHours, kind: actionKind },
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
    options: { alwaysAllow?: boolean; standing?: boolean } = {},
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
    if (decision === 'approved' && row.ticket_id !== null) this.store.owners.assertMayApprove(row.ticket_id, `${row.action_kind ?? ''}\n${row.summary}\n${row.details ?? ''}`, row.ticket ?? 'This ticket');
    // "Yes, and don't ask again for this kind on this ticket": it stands for its hours, a week at most.
    const standing = decision === 'approved' && options.standing === true;
    if (standing && (row.kind !== 'action' || row.ticket_id === null || !row.action_kind)) {
      throw new OrcoError('invalid', 'Only an approval on a ticket with a kind (like "push to main") can stand for later requests');
    }
    const hours = standing ? row.valid_hours ?? MAX_VALID_HOURS : row.valid_hours;
    const validUntil = decision === 'approved' && hours ? this.store.now() + hours * 3600_000 : null;
    this.store.db
      .prepare('UPDATE approvals SET state = ?, decided_by = ?, note = ?, decided_at = ?, valid_until = ?, standing = ? WHERE id = ?')
      .run(decision, actor.id, trimmedNote, this.store.now(), validUntil, standing ? 1 : 0, id);
    // On its ticket: the decision in the history, and (approved) a decision record agents can look up.
    if (row.ticket_id !== null) {
      const until = validUntil ? ` until ${new Date(validUntil).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
      this.store.tickets.note(row.ticket_id, actor, 'change', null, { changes: [{ field: 'approval', from: `#${id}`, to: `${decision} by ${actor.name}${until}` }] });
      if (decision === 'approved' && row.project_id !== null) {
        this.store.decisions.fromAnswer(actor, {
          projectId: row.project_id,
          ticketId: row.ticket_id,
          questionId: null,
          question: `Approve: ${row.summary}`,
          answer: `Approved${until}${row.scope ? `. Scope:\n${row.scope}` : ''}${trimmedNote ? `\n${trimmedNote}` : ''}`,
          options: [],
          context: `${row.requester} asked for approval #${id}.`,
        });
      }
    }
    this.store.audit.record(actor, 'approval.decide', {
      projectId: row.project_id,
      subject: `approval:${id}`,
      detail: { decision, note: trimmedNote, kind: row.kind, ...(standing ? { standing: { actionKind: row.action_kind, ticket: row.ticket, until: iso(validUntil) } } : {}) },
    });

    if (row.kind === 'task') {
      const task = this.store.tasks.forApproval(id);
      this.store.tasks.resolveApproval(actor, id, decision, trimmedNote);
      // Only the agent's owner can trust a requester; whoever confirms a webhook or over-budget task cannot.
      if (options.alwaysAllow && decision === 'approved' && task && this.store.participantByName(task.assignee)?.ownerId === actor.id) {
        const requester = this.store.participantByName(task.requester)!;
        const human = this.store.participantById(this.store.humanOf(requester))!;
        this.store.setTrust(actor, task.assignee, human.name, true);
      }
    } else {
      const verb = decision === 'approved' ? 'Approved' : 'Denied';
      const stands = standing
        ? ` Later requests for "${row.action_kind}" on ${row.ticket} are approved without asking until ${new Date(validUntil!).toISOString().slice(0, 16).replace('T', ' ')} UTC.`
        : '';
      this.store.post(
        actor,
        toApproval(row).room,
        `@${row.requester} ${verb} by ${actor.name}.${stands}${trimmedNote ? `\n${trimmedNote}` : ''}`,
        row.message_id,
      );
      this.store.schedules.onApproval(id, decision, actor);
      this.store.secrets.onApproval(id, decision, actor);
      this.store.safety.onApproval(id, decision, actor);
      this.store.outline.onApproval(id, decision, actor);
    }
    return this.changed(id);
  }

  /** Ends a standing approval now: the next request of its kind asks again. Its decider or approver only. */
  revoke(actor: Participant, id: number): Approval {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people can end an approval');
    const row = this.row(id);
    if (!row || !this.store.canSeeRoomId(actor, row.room_id)) throw new OrcoError('not_found', `No approval ${id}`);
    if (row.decided_by_id !== actor.id && row.approver_id !== actor.id) throw new OrcoError('forbidden', `Only ${row.decided_by ?? row.approver ?? 'whoever approved it'} can end approval ${id}`);
    if (row.state !== 'approved' || row.valid_until === null || row.valid_until <= this.store.now()) throw new OrcoError('conflict', `Approval ${id} is not in force`);
    this.store.db.prepare('UPDATE approvals SET valid_until = ?, standing = 0 WHERE id = ?').run(this.store.now(), id);
    this.store.audit.record(actor, 'approval.revoke', { projectId: row.project_id, subject: `approval:${id}`, detail: { kind: row.action_kind, ticket: row.ticket } });
    if (row.ticket_id !== null) this.store.tickets.note(row.ticket_id, actor, 'change', null, { changes: [{ field: 'approval', from: `#${id}`, to: `ended by ${actor.name}` }] });
    return this.changed(id);
  }

  /** The approval standing for this kind of action by this requester on this ticket, if one is in force. */
  private standingFor(ticketId: number, requesterId: number, actionKind: string): ApprovalRow | null {
    const row = this.store.db
      .prepare(`${APPROVAL_SELECT} WHERE ap.ticket_id = ? AND ap.requester_id = ? AND ap.standing = 1 AND ap.state = 'approved' AND ap.valid_until > ? AND lower(ap.action_kind) = lower(?) ORDER BY ap.id DESC LIMIT 1`)
      .get(ticketId, requesterId, this.store.now(), actionKind) as ApprovalRow | undefined;
    return row ?? null;
  }

  /** A request covered by a standing approval: recorded and approved at once, without pinging anyone. */
  private modeApprove(actor: Participant, room: Room, ticket: { id: number; ref: string }, actionKind: string | null, summary: string, details: string | null, scope: string | null, label: string): Approval {
    const note = `Approved without asking: ${ticket.ref} is in ${label} mode.`;
    let id = 0;
    this.store.post(actor, room.ref, `Approved without asking on ${ticket.ref}: ${summary}\n${note}`, undefined, {
      onInsert: (messageId) => {
        id = this.insert('action', room, messageId, actor, actor.ownerId, summary, details, 60_000);
        this.store.db
          .prepare('UPDATE approvals SET state = ?, note = ?, decided_at = ?, ticket_id = ?, scope = ?, action_kind = ? WHERE id = ?')
          .run('approved', note, this.store.now(), ticket.id, scope, actionKind, id);
      },
    });
    this.store.tickets.note(ticket.id, actor, 'change', null, { changes: [{ field: 'approval', from: null, to: `#${id} approved by the ${label} mode: ${summary}` }] });
    this.store.audit.record(actor, 'approval.mode', { projectId: room.projectId, subject: `approval:${id}`, detail: { mode: label, ticket: ticket.ref, summary } });
    return this.changed(id);
  }

  private autoApprove(
    actor: Participant,
    room: Room,
    ticket: { id: number; ref: string },
    actionKind: string,
    summary: string,
    details: string | null,
    scope: string | null,
    standing: ApprovalRow,
  ): Approval {
    const until = new Date(standing.valid_until!).toISOString().slice(0, 16).replace('T', ' ');
    const note = `Approved without asking: ${standing.decided_by} said not to ask again for "${actionKind}" on ${ticket.ref} until ${until} UTC (#${standing.id}).`;
    let id = 0;
    this.store.post(actor, room.ref, `Approved without asking on ${ticket.ref}: ${summary}\n${note}`, undefined, {
      onInsert: (messageId) => {
        id = this.insert('action', room, messageId, actor, standing.approver_id, summary, details, 60_000);
        this.store.db
          .prepare('UPDATE approvals SET state = ?, decided_by = ?, note = ?, decided_at = ?, valid_until = ?, ticket_id = ?, scope = ?, action_kind = ? WHERE id = ?')
          .run('approved', standing.decided_by_id, note, this.store.now(), standing.valid_until, ticket.id, scope, actionKind, id);
      },
    });
    this.store.tickets.note(ticket.id, actor, 'change', null, { changes: [{ field: 'approval', from: null, to: `#${id} approved under #${standing.id}: ${summary}` }] });
    this.store.audit.record(actor, 'approval.auto', { projectId: room.projectId, subject: `approval:${id}`, detail: { standing: standing.id, kind: actionKind, ticket: ticket.ref, summary } });
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
    return toApproval(row, this.store.now());
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
        `SELECT ap.id, ap.kind, ap.state, ap.expires_at, av.name AS approver, ap.action_kind,
                tp.ticket_key || '-' || tk.number AS ticket
         FROM approvals ap LEFT JOIN participants av ON av.id = ap.approver_id
         LEFT JOIN tickets tk ON tk.id = ap.ticket_id LEFT JOIN projects tp ON tp.id = tk.project_id
         WHERE ap.message_id = ? ORDER BY ap.id DESC LIMIT 1`,
      )
      .get(messageId) as { id: number; kind: ApprovalKind; state: ApprovalState; expires_at: number; approver: string | null; action_kind: string | null; ticket: string | null } | undefined;
    if (!row) return null;
    const state = row.state === 'pending' && row.expires_at <= this.store.now() ? 'expired' : row.state;
    return { id: row.id, kind: row.kind, state, approver: row.approver, ticket: row.ticket, actionKind: row.action_kind };
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
    const approval = toApproval(this.row(id)!, this.store.now());
    this.store.events.emit('approval', approval);
    return approval;
  }

  /** Approvals asked for on a ticket, newest first. */
  forTicket(ticketId: number): Approval[] {
    this.expireDue();
    return (this.store.db.prepare(`${APPROVAL_SELECT} WHERE ap.ticket_id = ? ORDER BY ap.id DESC LIMIT 20`).all(ticketId) as unknown as ApprovalRow[]).map((r) => toApproval(r, this.store.now()));
  }
}
