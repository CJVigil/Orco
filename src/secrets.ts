import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';
import { OPEN_STATES } from './tasks.js';

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_VALUE = 8 * 1024;
const MAX_DESCRIPTION = 300;
const MAX_REASON = 500;
const REQUEST_TTL_SECONDS = 3600;
const LEASE_MS = 8 * 3600_000;

export interface SecretInfo {
  name: string;
  description: string;
  owner: string;
  updatedAt: string;
}

export interface Lease {
  id: number;
  secret: string;
  project: string;
  taskId: number;
  agent: string;
  reason: string;
  state: 'pending' | 'granted' | 'denied' | 'revoked';
  expiresAt: string;
  uses: number;
  approvalId: number;
}

interface LeaseRow {
  id: number;
  secret_id: number;
  secret: string;
  project: string;
  project_id: number;
  owner_id: number;
  task_id: number;
  agent_id: number;
  agent: string;
  agent_owner_id: number | null;
  reason: string;
  state: Lease['state'];
  expires_at: number;
  uses: number;
  approval_id: number;
}

const LEASE_SELECT = `
  SELECT l.id, l.secret_id, s.name AS secret, p.name AS project, s.project_id, s.owner_id, l.task_id, l.agent_id,
         a.name AS agent, a.owner_id AS agent_owner_id, l.reason, l.state, l.expires_at, l.uses, l.approval_id
  FROM secret_leases l JOIN secrets s ON s.id = l.secret_id JOIN projects p ON p.id = s.project_id
  JOIN participants a ON a.id = l.agent_id
`;

/** Reads the key from ORCO_SECRETS_KEY: 32 bytes, as 64 hex characters or base64. */
export function parseSecretsKey(raw: string | undefined): Buffer | undefined {
  if (!raw) return undefined;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new OrcoError('invalid', 'ORCO_SECRETS_KEY must be 32 bytes, as 64 hex characters or base64 (openssl rand -hex 32)');
  return key;
}

/**
 * A credentials broker. People store secrets for a project (write-only: nobody reads a value back in
 * Orco). An agent working a task asks to use one; the person who stored it approves or denies; a
 * granted lease lets that agent read the value while the task is open, for at most 8 hours. Values
 * are encrypted with AES-256-GCM under a key the server admin sets (ORCO_SECRETS_KEY); without the
 * key the broker is off. Every request, decision and use is audited by name, never by value.
 */
export class Secrets {
  constructor(
    private readonly store: Store,
    private readonly key: Buffer | undefined,
  ) {}

  get enabled(): boolean {
    return this.key !== undefined;
  }

  set(actor: Participant, project: string, name: string, value: string, description = ''): SecretInfo {
    this.requireKey();
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people store secrets');
    const proj = this.store.visibleProject(actor, project);
    if (!NAME.test(name)) throw new OrcoError('invalid', 'Secret names look like environment variables: STRIPE_TEST_KEY');
    if (!value) throw new OrcoError('invalid', 'The value is empty');
    if (Buffer.byteLength(value) > MAX_VALUE) throw new OrcoError('invalid', `Values are at most ${MAX_VALUE / 1024} KB`);
    const text = description.trim().slice(0, MAX_DESCRIPTION);
    const existing = this.store.db.prepare('SELECT id, owner_id FROM secrets WHERE project_id = ? AND name = ?').get(proj.id, name) as { id: number; owner_id: number } | undefined;
    if (existing && existing.owner_id !== actor.id) throw new OrcoError('forbidden', `${name} belongs to someone else; pick another name`);
    const { ciphertext, iv, tag } = this.encrypt(value, `${proj.id}:${name}`);
    if (existing) {
      this.store.db
        .prepare("UPDATE secrets SET ciphertext = ?, iv = ?, tag = ?, description = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
        .run(ciphertext, iv, tag, text, existing.id);
      // Leases granted for the old value end with it.
      this.store.db.prepare("UPDATE secret_leases SET state = 'revoked' WHERE secret_id = ? AND state IN ('pending', 'granted')").run(existing.id);
    } else {
      this.store.db
        .prepare('INSERT INTO secrets (project_id, name, description, ciphertext, iv, tag, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(proj.id, name, text, ciphertext, iv, tag, actor.id);
    }
    this.store.audit.record(actor, existing ? 'secret.replace' : 'secret.create', { projectId: proj.id, subject: `secret:${project}/${name}` });
    return this.list(actor, project).find((s) => s.name === name)!;
  }

  list(actor: Participant, project: string): SecretInfo[] {
    const proj = this.store.visibleProject(actor, project);
    const rows = this.store.db
      .prepare('SELECT s.name, s.description, u.name AS owner, s.updated_at FROM secrets s JOIN participants u ON u.id = s.owner_id WHERE s.project_id = ? AND length(s.ciphertext) > 0 ORDER BY s.name')
      .all(proj.id) as unknown as { name: string; description: string; owner: string; updated_at: string }[];
    return rows.map((r) => ({ name: r.name, description: r.description, owner: r.owner, updatedAt: r.updated_at }));
  }

  delete(actor: Participant, project: string, name: string): void {
    const proj = this.store.visibleProject(actor, project);
    const row = this.store.db.prepare('SELECT id, owner_id FROM secrets WHERE project_id = ? AND name = ?').get(proj.id, name) as { id: number; owner_id: number } | undefined;
    if (!row) throw new OrcoError('not_found', `No secret ${name}`);
    if (row.owner_id !== actor.id) throw new OrcoError('forbidden', 'Only whoever stored a secret deletes it');
    this.store.db.prepare("UPDATE secret_leases SET state = 'revoked' WHERE secret_id = ? AND state IN ('pending', 'granted')").run(row.id);
    // Keep the row's leases for the record, but drop the value.
    this.store.db.prepare("UPDATE secrets SET ciphertext = x'', iv = x'', tag = x'', name = name || '#deleted-' || id WHERE id = ?").run(row.id);
    this.store.audit.record(actor, 'secret.delete', { projectId: proj.id, subject: `secret:${project}/${name}` });
  }

  /** An agent asks to use a secret for one of its open tasks; the secret's owner decides. */
  request(actor: Participant, taskId: number, name: string, reason: string): Lease {
    this.requireKey();
    if (actor.kind !== 'agent') throw new OrcoError('forbidden', 'Agents ask for secrets for a task; people store them');
    const task = this.store.tasks.get(actor, taskId);
    if (task.assignee !== actor.name) throw new OrcoError('forbidden', `Task ${taskId} is ${task.assignee}'s`);
    if (!OPEN_STATES.includes(task.state)) throw new OrcoError('conflict', `Task ${taskId} is ${task.state}`);
    if (task.projectId === null) throw new OrcoError('invalid', 'Secrets belong to projects; this task is in a server room');
    const secret = this.store.db.prepare('SELECT id, owner_id FROM secrets WHERE project_id = ? AND name = ?').get(task.projectId, name) as
      | { id: number; owner_id: number }
      | undefined;
    if (!secret) throw new OrcoError('not_found', `No secret ${name} in this task's project; see list_secrets`);
    const why = reason.trim();
    if (!why) throw new OrcoError('invalid', 'Say what you need it for');
    if (why.length > MAX_REASON) throw new OrcoError('invalid', `Keep the reason under ${MAX_REASON} characters`);
    const now = this.store.now();
    const current = this.store.db
      .prepare(`${LEASE_SELECT} WHERE l.secret_id = ? AND l.task_id = ? AND l.agent_id = ? AND (l.state = 'pending' OR (l.state = 'granted' AND l.expires_at > ?)) ORDER BY l.id DESC`)
      .get(secret.id, taskId, actor.id, now) as LeaseRow | undefined;
    if (current) return this.toLease(current);
    const owner = this.store.participantById(secret.owner_id)!;
    const approval = this.store.approvals.requestFrom(
      actor,
      task.room,
      owner,
      `${actor.name} asks to use the secret ${name} for task #${taskId}`,
      `Why: ${why}\nIf you approve, ${actor.name} can read the value until the task closes (at most 8 hours). The value will be in its context.`,
      REQUEST_TTL_SECONDS,
    );
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO secret_leases (secret_id, task_id, agent_id, approval_id, reason, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(secret.id, taskId, actor.id, approval.id, why, now + REQUEST_TTL_SECONDS * 1000);
    this.store.audit.record(actor, 'secret.request', { projectId: task.projectId, subject: `secret:${name}`, detail: { taskId, reason: why } });
    return this.lease(Number(lastInsertRowid))!;
  }

  /** The owner's decision on a lease request. Called by Approvals. */
  onApproval(approvalId: number, decision: 'approved' | 'denied', actor: Participant): void {
    const row = this.store.db.prepare(`${LEASE_SELECT} WHERE l.approval_id = ?`).get(approvalId) as LeaseRow | undefined;
    if (!row || row.state !== 'pending') return;
    if (decision === 'approved') {
      this.store.db.prepare("UPDATE secret_leases SET state = 'granted', expires_at = ? WHERE id = ?").run(this.store.now() + LEASE_MS, row.id);
    } else {
      this.store.db.prepare("UPDATE secret_leases SET state = 'denied' WHERE id = ?").run(row.id);
    }
    this.store.audit.record(actor, `secret.${decision === 'approved' ? 'grant' : 'deny'}`, { projectId: row.project_id, subject: `secret:${row.secret}`, detail: { leaseId: row.id, agent: row.agent, taskId: row.task_id } });
  }

  /** The value, for the agent holding a granted lease on an open task. */
  reveal(actor: Participant, leaseId: number): { name: string; value: string; expiresAt: string } {
    this.requireKey();
    const row = this.store.db.prepare(`${LEASE_SELECT} WHERE l.id = ?`).get(leaseId) as LeaseRow | undefined;
    if (!row || row.agent_id !== actor.id) throw new OrcoError('not_found', `No lease ${leaseId} of yours`);
    if (row.state === 'pending') throw new OrcoError('conflict', `Lease ${leaseId} is waiting for ${this.store.participantById(row.owner_id)!.name} to decide`);
    if (row.state !== 'granted') throw new OrcoError('forbidden', `Lease ${leaseId} was ${row.state}`);
    if (row.expires_at <= this.store.now()) throw new OrcoError('forbidden', `Lease ${leaseId} has expired; ask again`);
    const task = this.store.tasks.find(row.task_id);
    if (!task || !OPEN_STATES.includes(task.state)) throw new OrcoError('forbidden', `Task ${row.task_id} is closed, and the lease with it`);
    if (actor.scope && actor.scope.taskId !== row.task_id) throw new OrcoError('forbidden', 'This token is for a different task');
    const secret = this.store.db.prepare('SELECT ciphertext, iv, tag, project_id, name FROM secrets WHERE id = ?').get(row.secret_id) as {
      ciphertext: Uint8Array;
      iv: Uint8Array;
      tag: Uint8Array;
      project_id: number;
      name: string;
    };
    const value = this.decrypt(secret, `${secret.project_id}:${secret.name}`);
    this.store.db.prepare('UPDATE secret_leases SET uses = uses + 1 WHERE id = ?').run(leaseId);
    this.store.audit.record(actor, 'secret.use', { projectId: row.project_id, subject: `secret:${row.secret}`, detail: { leaseId, taskId: row.task_id } });
    return { name: row.secret, value, expiresAt: new Date(row.expires_at).toISOString() };
  }

  /** Ends a lease early: the secret's owner, or the agent's owner. */
  revoke(actor: Participant, leaseId: number): Lease {
    const row = this.store.db.prepare(`${LEASE_SELECT} WHERE l.id = ?`).get(leaseId) as LeaseRow | undefined;
    if (!row || ![row.owner_id, row.agent_owner_id].includes(actor.id)) throw new OrcoError('not_found', `No lease ${leaseId} you can revoke`);
    this.store.db.prepare("UPDATE secret_leases SET state = 'revoked' WHERE id = ? AND state IN ('pending', 'granted')").run(leaseId);
    this.store.audit.record(actor, 'secret.revoke', { projectId: row.project_id, subject: `secret:${row.secret}`, detail: { leaseId } });
    return this.lease(leaseId)!;
  }

  /** Leases on secrets you stored, or held by your agents, newest first. */
  leasesFor(actor: Participant, project?: string): Lease[] {
    const projectId = project ? this.store.visibleProject(actor, project).id : undefined;
    const rows = this.store.db
      .prepare(`${LEASE_SELECT} WHERE (s.owner_id = ? OR a.owner_id = ? OR l.agent_id = ?) ORDER BY l.id DESC LIMIT 100`)
      .all(actor.id, actor.id, actor.id) as unknown as LeaseRow[];
    return rows.filter((r) => projectId === undefined || r.project_id === projectId).map((r) => this.toLease(r));
  }

  private toLease(row: LeaseRow): Lease {
    const expired = row.state === 'granted' && row.expires_at <= this.store.now();
    return {
      id: row.id,
      secret: row.secret,
      project: row.project,
      taskId: row.task_id,
      agent: row.agent,
      reason: row.reason,
      state: expired ? 'revoked' : row.state,
      expiresAt: new Date(row.expires_at).toISOString(),
      uses: row.uses,
      approvalId: row.approval_id,
    };
  }

  private lease(id: number): Lease | null {
    const row = this.store.db.prepare(`${LEASE_SELECT} WHERE l.id = ?`).get(id) as LeaseRow | undefined;
    return row ? this.toLease(row) : null;
  }

  private requireKey(): void {
    if (!this.key) throw new OrcoError('invalid', 'Secrets are off on this server; an admin turns them on with ORCO_SECRETS_KEY');
  }

  private encrypt(value: string, aad: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key!, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  }

  private decrypt(row: { ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array }, aad: string): string {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key!, Buffer.from(row.iv));
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(Buffer.from(row.tag));
      return Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]).toString('utf8');
    } catch {
      throw new OrcoError('conflict', 'This secret cannot be decrypted with the current ORCO_SECRETS_KEY; its owner should store it again');
    }
  }
}
