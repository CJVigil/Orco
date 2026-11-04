import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/*
 * Checked rules (#113). A policy sentence an agent is told can be forgotten; a checked rule cannot.
 * Org admins add rules: a name, a pattern (plain text, or a regular expression), and where to look:
 * plans (propose_plan), approval requests, and code blocks or diffs in messages and ticket comments.
 * A match blocks the plan or approval, naming the rule, and tells the rule's owner; in a message it
 * flags it instead. Examples ship switched off.
 */

export const RULE_SCOPES = ['plan', 'approval', 'message'] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

export interface CheckedRule {
  id: number;
  name: string;
  pattern: string;
  regex: boolean;
  scopes: RuleScope[];
  enabled: boolean;
  owner: string | null;
  why: string;
}

/** Examples an org admin can switch on. */
export const EXAMPLE_RULES: Omit<CheckedRule, 'id' | 'enabled' | 'owner'>[] = [
  { name: 'No Docker socket mounts', pattern: '/var/run/docker\\.sock|docker\\.sock:', regex: true, scopes: ['plan', 'approval', 'message'], why: 'Mounting the Docker socket gives a container root on the host.' },
  { name: 'No host port mappings in compose', pattern: '^\\s*ports\\s*:', regex: true, scopes: ['approval', 'message'], why: 'Services sit behind the proxy; host ports bypass it.' },
  { name: 'No terminals on servers', pattern: '\\b(ssh|mosh|telnet)\\s+[\\w.@-]+|docker\\s+exec\\s+-it|kubectl\\s+exec\\s+-it', regex: true, scopes: ['plan', 'approval'], why: 'Change servers through deploys, not by hand.' },
  { name: 'No skipping hooks', pattern: '--no-verify|--no-gpg-sign|HUSKY=0|SKIP=', regex: true, scopes: ['plan', 'approval', 'message'], why: 'Hooks run the checks a change must pass.' },
  { name: 'No force-push to main', pattern: 'push\\s+(-f|--force|--force-with-lease)\\b.*\\b(main|master)\\b|push\\s+.*\\b(main|master)\\b.*\\s(-f|--force)\\b|\\+(main|master)\\b', regex: true, scopes: ['plan', 'approval', 'message'], why: 'Rewriting main loses other people\'s work.' },
];

const MAX_TEXT = 50_000;

interface Row {
  id: number;
  name: string;
  pattern: string;
  regex: number;
  scopes: string;
  enabled: number;
  owner: string | null;
  owner_id: number | null;
  why: string;
}

const toRule = (r: Row): CheckedRule => ({ id: r.id, name: r.name, pattern: r.pattern, regex: r.regex === 1, scopes: r.scopes.split(',') as RuleScope[], enabled: r.enabled === 1, owner: r.owner, why: r.why });

export class CheckedRules {
  constructor(private readonly store: Store) {}

  list(): CheckedRule[] {
    return (this.store.db.prepare('SELECT c.*, u.name AS owner FROM checked_rules c LEFT JOIN participants u ON u.id = c.owner_id ORDER BY c.id').all() as unknown as Row[]).map(toRule);
  }

  /** Org admins add a rule, or change one (id): name, pattern, where, on or off, its owner. */
  save(actor: Participant, input: { id?: number; name?: string; pattern?: string; regex?: boolean; scopes?: string[]; enabled?: boolean; owner?: string | null; why?: string }): CheckedRule {
    if (actor.kind !== 'user' || !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins manage checked rules');
    const current = input.id !== undefined ? this.list().find((r) => r.id === input.id) : undefined;
    if (input.id !== undefined && !current) throw new OrcoError('not_found', `No rule ${input.id}`);
    const name = (input.name ?? current?.name ?? '').trim();
    const pattern = input.pattern ?? current?.pattern ?? '';
    const regex = input.regex ?? current?.regex ?? false;
    const scopes = (input.scopes ?? current?.scopes ?? ['approval']).filter((s): s is RuleScope => (RULE_SCOPES as readonly string[]).includes(s));
    if (!name || name.length > 80) throw new OrcoError('invalid', 'A rule needs a name of at most 80 characters');
    if (!pattern || pattern.length > 300) throw new OrcoError('invalid', 'A pattern is 1-300 characters');
    if (!scopes.length) throw new OrcoError('invalid', `Check it in one or more of: ${RULE_SCOPES.join(', ')}`);
    if (regex) {
      try {
        new RegExp(pattern, 'im');
      } catch {
        throw new OrcoError('invalid', 'That pattern is not a valid regular expression');
      }
    }
    let ownerId: number | null = null;
    const ownerName = input.owner === undefined ? current?.owner : input.owner;
    if (ownerName) {
      const owner = this.store.participantByName(ownerName.replace(/^@/, ''));
      if (!owner || owner.kind !== 'user') throw new OrcoError('invalid', 'A rule\'s owner is a person');
      ownerId = owner.id;
    }
    const why = (input.why ?? current?.why ?? '').trim().slice(0, 300);
    const enabled = input.enabled ?? current?.enabled ?? true;
    if (current) {
      this.store.db
        .prepare('UPDATE checked_rules SET name = ?, pattern = ?, regex = ?, scopes = ?, enabled = ?, owner_id = ?, why = ? WHERE id = ?')
        .run(name, pattern, regex ? 1 : 0, scopes.join(','), enabled ? 1 : 0, ownerId, why, current.id);
    } else {
      this.store.db
        .prepare('INSERT INTO checked_rules (name, pattern, regex, scopes, enabled, owner_id, why) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(name, pattern, regex ? 1 : 0, scopes.join(','), enabled ? 1 : 0, ownerId, why);
    }
    this.store.audit.record(actor, 'checked_rule.save', { projectId: null, subject: `rule:${name}`, detail: { pattern, regex, scopes, enabled } });
    return this.list().find((r) => r.name === name)!;
  }

  remove(actor: Participant, id: number): void {
    if (actor.kind !== 'user' || !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins manage checked rules');
    this.store.db.prepare('DELETE FROM checked_rules WHERE id = ?').run(id);
    this.store.audit.record(actor, 'checked_rule.remove', { projectId: null, subject: `rule:${id}` });
  }

  /** The enabled rules of a scope that the text matches. */
  matches(scope: RuleScope, text: string): CheckedRule[] {
    const sample = text.slice(0, MAX_TEXT);
    return this.list().filter((r) => {
      if (!r.enabled || !r.scopes.includes(scope)) return false;
      if (!r.regex) return sample.toLowerCase().includes(r.pattern.toLowerCase());
      try {
        return new RegExp(r.pattern, 'im').test(sample);
      } catch {
        return false;
      }
    });
  }

  /**
   * Blocks a plan or approval request that matches a rule: tells the rule's owner in the room, audits
   * it, and refuses naming the rule.
   */
  enforce(actor: Participant, scope: 'plan' | 'approval', text: string, room: string | null, projectId: number | null): void {
    const hit = this.matches(scope, text);
    if (!hit.length) return;
    for (const rule of hit) {
      this.store.audit.record(actor, 'checked_rule.block', { projectId, subject: `rule:${rule.name}`, detail: { scope, excerpt: text.slice(0, 300) } });
      this.tellOwner(rule, room, `${actor.name}'s ${scope === 'plan' ? 'plan' : 'approval request'} was blocked by the rule "${rule.name}".`);
    }
    throw new OrcoError('conflict', `Blocked by the rule${hit.length > 1 ? 's' : ''} ${hit.map((r) => `"${r.name}"${r.why ? ` (${r.why})` : ''}`).join(', ')}. Change the ${scope === 'plan' ? 'plan' : 'request'}, or ask an org admin.`);
  }

  /** Code blocks and diff lines in a message or comment, checked against message rules: flagged, not blocked. */
  flagged(text: string): CheckedRule[] {
    const code = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
    const diff = text.split('\n').filter((l) => /^[+-](?![+-]{2})/.test(l)).join('\n');
    const sample = `${code}\n${diff}`.trim();
    return sample ? this.matches('message', sample) : [];
  }

  /** After a message is posted: if its code or diff matches, say so in its thread and tell the owner. */
  afterPost(author: Participant, room: string, messageId: number, text: string, projectId: number | null): void {
    if (author.kind !== 'agent') return;
    const hit = this.flagged(text);
    if (!hit.length) return;
    const system = this.store.system();
    if (!system) return;
    const owners = [...new Set(hit.map((r) => r.owner).filter((o): o is string => o !== null))];
    this.store.post(system, room, `${owners.map((o) => `@${o} `).join('')}This message matches the checked rule${hit.length > 1 ? 's' : ''} ${hit.map((r) => `"${r.name}"`).join(', ')}.`, messageId, { skipRateLimit: true });
    for (const rule of hit) this.store.audit.record(author, 'checked_rule.flag', { projectId, subject: `rule:${rule.name}`, detail: { messageId } });
  }

  private tellOwner(rule: CheckedRule, room: string | null, text: string): void {
    if (!rule.owner || !room) return;
    const system = this.store.system();
    if (!system) return;
    try {
      this.store.post(system, room, `@${rule.owner} ${text}`, undefined, { skipRateLimit: true });
    } catch {
      // The room is gone or private to someone else: the audit log still has it.
    }
  }
}
