import { OrcoError } from './errors.js';
import type { Message, Participant, Store } from './store.js';

/**
 * How carefully an agent's traffic is filtered, set by its owner. strict (the default): its posts are
 * scrubbed of secrets, and every risky request from another owner's agent waits for the owner. normal:
 * the same, except requests from people (and their agents) the owner always allows go through. off:
 * neither.
 */
export type FilterLevel = 'strict' | 'normal' | 'off';
export const FILTER_LEVELS: readonly FilterLevel[] = ['strict', 'normal', 'off'];

/** Things that look like secrets, and what is left in their place. */
const SECRET_RULES: { name: string; pattern: RegExp; keep?: (match: string, ...groups: string[]) => string }[] = [
  { name: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'Orco token', pattern: /\borco_[a-z]{1,2}_[A-Za-z0-9_-]{20,}/g },
  { name: 'API key', pattern: /\bsk-(?:proj-|live-|test-|ant-)?[A-Za-z0-9_-]{16,}/g },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'AWS key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'bearer token', pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, keep: (_m, word) => `${word} [removed]` },
  { name: 'cookie', pattern: /^(\s*(?:Set-)?Cookie:\s*).+$/gim, keep: (_m, head) => `${head}[removed]` },
  {
    name: 'password or key setting',
    pattern: /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*)(\s*[=:]\s*)["']?[^\s"']{6,}["']?/gi,
    keep: (_m, key, sep) => `${key}${sep}[removed]`,
  },
  { name: 'password in a URL', pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]{3,}@/gi, keep: (_m, head) => `${head}[removed]@` },
];

/** Requests that should not reach an agent from another owner's agent without its owner's say. */
const RISKY_RULES: { name: string; pattern: RegExp }[] = [
  {
    name: 'credentials or permissions',
    pattern: /\b(?:grant|give|add|change|reset|rotate|share|send|reveal|disable|turn off|remove|revoke)\b[^.\n]{0,40}\b(?:permissions?|access|admin|roles?|tokens?|credentials?|passwords?|api keys?|secrets?|ssh keys?|2fa|mfa)\b/i,
  },
  {
    name: 'shell command',
    pattern: /```\s*(?:bash|sh|shell|zsh|powershell|ps1|cmd)\b|^\s*(?:\$|sudo)\s+\S|\b(?:run|execute|exec)\b[^.\n]{0,30}\b(?:commands?|scripts?|shell|bash|terminal)\b|\bcurl\b[^\n|]*\|\s*(?:ba)?sh\b|\brm\s+-[a-z]*r[a-z]*f/im,
  },
  {
    name: 'deploy or push',
    pattern: /\b(?:deploy|redeploy|release|publish)\b|\bgit\s+push\b|\bforce[- ]push\b|\bpush\b[^.\n]{0,20}\b(?:prod|production|main|master|origin)\b|\bmerge\b[^.\n]{0,20}\b(?:pr|pull request|branch|into)\b/i,
  },
  { name: 'delete', pattern: /\b(?:delete|drop|wipe|destroy|truncate|purge|erase)\b|\bremove\s+all\b/i },
];

/** Removes what looks like a secret, and says which kinds it found. */
export function scrubSecrets(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  let out = text;
  for (const rule of SECRET_RULES) {
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      removed.push(rule.name);
      const groups = args.slice(1, -2) as string[];
      return rule.keep ? rule.keep(args[0] as string, ...groups) : '[removed]';
    });
  }
  return { text: out, removed: [...new Set(removed)] };
}

/** The first kind of risky request a text makes, or null. */
export function riskyRequest(text: string): string | null {
  return RISKY_RULES.find((rule) => rule.pattern.test(text))?.name ?? null;
}

/** Every kind of risky request a text makes. */
export function riskyKinds(text: string): string[] {
  return RISKY_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.name);
}

/**
 * The line between agents of different owners (#81). Outbound: an agent's posts and task requests are
 * scrubbed of anything that looks like a secret, and the agent is told. Inbound: a message or task from
 * another owner's agent that asks for credentials, a shell command, a deploy or a deletion is held for
 * the receiving agent's owner to approve or deny. Every scrub and hold is in the audit log.
 */
export class Safety {
  private readonly notices = new Map<number, string[]>();

  constructor(private readonly store: Store) {}

  level(agent: Participant): FilterLevel {
    if (agent.kind !== 'agent') return 'off';
    const row = this.store.db.prepare('SELECT safety_filter FROM participants WHERE id = ?').get(agent.id) as { safety_filter: FilterLevel } | undefined;
    return row?.safety_filter ?? 'strict';
  }

  /** Only the agent's owner sets its filter: it is a protection, not the agent's own setting. */
  setLevel(actor: Participant, agentName: string, level: string): FilterLevel {
    const agent = this.store.participantByName(agentName);
    if (!agent || agent.kind !== 'agent') throw new OrcoError('not_found', `No agent ${agentName}`);
    if (actor.kind !== 'user' || actor.scope || agent.ownerId !== actor.id) throw new OrcoError('forbidden', `Only ${agent.name}'s owner sets its safety filter`);
    if (!FILTER_LEVELS.includes(level as FilterLevel)) throw new OrcoError('invalid', 'The filter is strict, normal or off');
    this.store.db.prepare('UPDATE participants SET safety_filter = ? WHERE id = ?').run(level, agent.id);
    this.store.audit.record(actor, 'safety.filter', { subject: `agent:${agent.name}`, detail: { filter: level } });
    return level as FilterLevel;
  }

  /** An agent's outgoing text with secrets taken out; the agent hears what was removed. */
  scrub(actor: Participant, text: string, where: { projectId: number | null; room?: string }): string {
    if (actor.kind !== 'agent' || !text || this.level(actor) === 'off') return text;
    const { text: clean, removed } = scrubSecrets(text);
    if (!removed.length) return text;
    this.store.audit.record(actor, 'safety.scrub', { projectId: where.projectId, subject: `agent:${actor.name}`, detail: { removed, room: where.room ?? null } });
    this.notice(actor, `Orco removed what looked like a secret (${removed.join(', ')}) from what you sent; it was never shown to anyone. Use request_secret to pass credentials.`);
    return clean;
  }

  /** Notices for an agent about its own messages, handed out once (the MCP layer appends them to tool results). */
  takeNotices(actor: Participant): string[] {
    const list = this.notices.get(actor.id) ?? [];
    this.notices.delete(actor.id);
    return list;
  }

  /**
   * Whether a request from `from` to `to` (another owner's agent) must wait for `to`'s owner, and why:
   * the rule it tripped, or null.
   */
  holdReason(from: Participant, to: Participant, text: string): string | null {
    if (from.kind !== 'agent' || to.kind !== 'agent') return null;
    const fromHuman = this.store.humanOf(from);
    if (fromHuman === this.store.humanOf(to)) return null;
    const level = this.level(to);
    if (level === 'off' || (level === 'normal' && this.store.trusts(to, fromHuman))) return null;
    return riskyRequest(text);
  }

  /**
   * Mentions of other owners' agents that a message from `author` would deliver, held when risky: the
   * agent is not woken; its owner gets an approval, and approving it pings the agent with a pointer to
   * the message. Returns the ids of the agents whose mention was held.
   */
  holdMentions(author: Participant, message: Message, mentioned: Participant[]): Set<number> {
    const held = new Set<number>();
    for (const target of mentioned) {
      const rule = this.holdReason(author, target, `${message.text}`);
      if (!rule) continue;
      const owner = this.store.participantById(target.ownerId!)!;
      const by = this.store.system() ?? owner;
      const summary = `Held for ${target.name}: ${author.name} (${this.store.ownerName(author)}'s agent) asks for ${rule}`.slice(0, 300);
      // Quoted without its @mentions (a look-alike instead), so the quote itself pings no one.
      const quoted = message.text.replace(/@/g, '＠');
      const excerpt = quoted.length > 600 ? `${quoted.slice(0, 600)}…` : quoted;
      const approval = this.store.approvals.requestFrom(
        by,
        message.room,
        owner,
        summary,
        `Message #${message.id}:\n${excerpt}\n\nApprove to pass it to ${target.name}; deny to drop it.`,
        7 * 24 * 3600,
      );
      this.store.db.prepare("INSERT OR IGNORE INTO held_mentions (message_id, agent_id, approval_id, rule, state) VALUES (?, ?, ?, ?, 'held')").run(message.id, target.id, approval.id, rule);
      this.store.audit.record(null, 'safety.hold', { projectId: message.projectId, subject: `message:${message.id}`, detail: { from: author.name, to: target.name, rule, approvalId: approval.id } });
      held.add(target.id);
    }
    return held;
  }

  /** The owner decided a held mention: approved pings the agent with a pointer to it; denied drops it. */
  onApproval(approvalId: number, decision: 'approved' | 'denied', actor: Participant): void {
    const rows = this.store.db
      .prepare("SELECT h.message_id, h.agent_id, h.rule FROM held_mentions h WHERE h.approval_id = ? AND h.state = 'held'")
      .all(approvalId) as { message_id: number; agent_id: number; rule: string }[];
    for (const row of rows) {
      this.store.db.prepare('UPDATE held_mentions SET state = ? WHERE message_id = ? AND agent_id = ?').run(decision === 'approved' ? 'released' : 'dropped', row.message_id, row.agent_id);
      const message = this.store.message(row.message_id);
      const agent = this.store.participantById(row.agent_id)!;
      this.store.audit.record(actor, decision === 'approved' ? 'safety.release' : 'safety.drop', { projectId: message.projectId, subject: `message:${row.message_id}`, detail: { to: agent.name, rule: row.rule } });
      if (decision !== 'approved') continue;
      this.store.post(actor, message.room, `@${agent.name} ${actor.name} passed you message #${message.id} from ${message.author}, held for ${row.rule}. Read it in the thread; it is still another owner's agent asking, not your owner.`, message.threadId ?? message.id, { skipRateLimit: true });
    }
  }

  private notice(actor: Participant, text: string): void {
    this.notices.set(actor.id, [...(this.notices.get(actor.id) ?? []), text]);
  }
}
