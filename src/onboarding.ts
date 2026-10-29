import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { PRESET_NAMES } from './bridge/presets.js';
import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

const PAIR_TTL_MS = 10 * 60_000;
const MAX_PENDING = 200;
/** No 0/O, 1/I/L: codes are read off one screen and typed into another. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface PairChoice {
  /** The agent to run on that computer: an existing agent of yours, or a new one with this name. */
  agent: string;
  /** Which tool runs it there (a bridge preset). */
  preset: string;
}

interface Pairing {
  id: string;
  code: string;
  secretHash: string;
  host: string;
  tools: string[];
  cwd: string;
  expiresAt: number;
  state: 'pending' | 'approved' | 'denied';
  approvedBy?: string;
  /** Tokens, held in memory only until the computer collects them once. */
  agents?: { name: string; token: string; preset: string }[];
}

export interface PairingView {
  code: string;
  host: string;
  tools: string[];
  cwd: string;
  expiresAt: string;
  state: Pairing['state'];
}

export interface Step {
  key: 'project' | 'agent' | 'connect' | 'task' | 'result';
  title: string;
  done: boolean;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function code(): string {
  const pick = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  return `${pick()}-${pick()}`;
}

/**
 * Getting started without a terminal: the first person sets up the server in the browser (with the
 * setup code it prints), and a computer joins with `orco connect`, which shows a code that a person
 * approves in the browser, choosing which of their agents run there. Tokens for the computer are
 * made at approval, kept in memory, and handed over once; Orco still stores only their hashes.
 */
export class Onboarding {
  private readonly pairings = new Map<string, Pairing>();

  constructor(private readonly store: Store) {}

  /** True until the first person exists. */
  setupNeeded(): boolean {
    return this.store.db.prepare("SELECT 1 FROM participants WHERE kind = 'user' AND system = 0").get() === undefined;
  }

  /** Creates the first person (an org admin), if the setup code matches. */
  setup(expected: string | undefined, given: string, name: string): { participant: Participant; token: string } {
    if (!this.setupNeeded()) throw new OrcoError('conflict', 'This Orco is already set up; sign in instead');
    const a = Buffer.from(hash(given));
    const b = Buffer.from(hash(expected ?? randomBytes(16).toString('hex')));
    if (!expected || !timingSafeEqual(a, b)) throw new OrcoError('forbidden', 'That setup code is not right; it is in the server log, printed at start');
    return this.store.createUser(name.trim().toLowerCase(), { orgAdmin: true });
  }

  /* Pairing a computer */

  start(input: { host?: unknown; tools?: unknown; cwd?: unknown }): { id: string; code: string; secret: string; expiresAt: string } {
    this.sweep();
    if (this.pairings.size >= MAX_PENDING) throw new OrcoError('rate_limited', 'Too many computers are waiting to be approved; try again in a few minutes');
    const host = String(input.host ?? 'a computer').trim().slice(0, 80) || 'a computer';
    const tools = Array.isArray(input.tools) ? input.tools.map(String).filter((t) => PRESET_NAMES.includes(t)) : [];
    const cwd = String(input.cwd ?? '').slice(0, 300);
    const id = randomBytes(12).toString('base64url');
    const secret = randomBytes(24).toString('base64url');
    let value = code();
    while ([...this.pairings.values()].some((p) => p.code === value)) value = code();
    const expiresAt = this.store.now() + PAIR_TTL_MS;
    this.pairings.set(id, { id, code: value, secretHash: hash(secret), host, tools, cwd, expiresAt, state: 'pending' });
    return { id, code: value, secret, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** What a person sees before approving: which computer, with which tools. */
  view(actor: Participant, value: string): PairingView {
    const pairing = this.byCode(actor, value);
    return { code: pairing.code, host: pairing.host, tools: pairing.tools, cwd: pairing.cwd, expiresAt: new Date(pairing.expiresAt).toISOString(), state: pairing.state };
  }

  /**
   * Approves a computer: for each choice, makes the agent (or gives an existing one of yours a new
   * token, which ends its old one) and holds the tokens for the computer to collect.
   */
  approve(actor: Participant, value: string, choices: PairChoice[]): { agents: { name: string; preset: string; created: boolean }[] } {
    const pairing = this.byCode(actor, value);
    if (pairing.state !== 'pending') throw new OrcoError('conflict', `This computer was already ${pairing.state}`);
    if (!Array.isArray(choices) || choices.length === 0 || choices.length > 8) throw new OrcoError('invalid', 'Choose 1 to 8 agents to run there');
    const seen = new Set<string>();
    for (const c of choices) {
      if (!NAME.test(String(c.agent))) throw new OrcoError('invalid', 'Agent names are 1-32 lowercase letters, digits or dashes');
      if (!PRESET_NAMES.includes(c.preset)) throw new OrcoError('invalid', `Unknown tool ${c.preset}`);
      if (seen.has(c.agent)) throw new OrcoError('invalid', `${c.agent} is listed twice`);
      seen.add(c.agent);
      const existing = this.store.participantByName(c.agent);
      if (existing && (existing.kind !== 'agent' || existing.ownerId !== actor.id)) throw new OrcoError('conflict', `The name ${c.agent} is taken`);
    }
    const agents: { name: string; token: string; preset: string; created: boolean }[] = [];
    for (const c of choices) {
      const existing = this.store.participantByName(c.agent);
      const token = existing ? this.store.rotateToken(c.agent) : this.store.createAgent(actor.name, c.agent).token;
      agents.push({ name: c.agent, token, preset: c.preset, created: !existing });
    }
    pairing.state = 'approved';
    pairing.approvedBy = actor.name;
    pairing.agents = agents.map(({ name, token, preset }) => ({ name, token, preset }));
    this.store.audit.record(actor, 'pair.approve', { subject: `computer:${pairing.host}`, detail: { agents: agents.map((a) => ({ name: a.name, preset: a.preset, created: a.created })) } });
    this.store.events.emit('structure');
    return { agents: agents.map(({ name, preset, created }) => ({ name, preset, created })) };
  }

  deny(actor: Participant, value: string): void {
    const pairing = this.byCode(actor, value);
    pairing.state = 'denied';
    this.store.audit.record(actor, 'pair.deny', { subject: `computer:${pairing.host}` });
  }

  /** For the computer: still waiting, refused, or its agents and tokens (handed over once). */
  poll(id: string, secret: string): { state: 'pending' | 'denied' } | { state: 'approved'; approvedBy: string; agents: { name: string; token: string; preset: string }[] } {
    this.sweep();
    const pairing = this.pairings.get(id);
    if (!pairing || !timingSafeEqual(Buffer.from(hash(secret)), Buffer.from(pairing.secretHash))) throw new OrcoError('not_found', 'This pairing has expired; run orco connect again');
    if (pairing.state === 'pending') return { state: 'pending' };
    this.pairings.delete(id);
    if (pairing.state === 'denied') return { state: 'denied' };
    return { state: 'approved', approvedBy: pairing.approvedBy!, agents: pairing.agents! };
  }

  private byCode(actor: Participant, value: string): Pairing {
    if (actor.kind !== 'user') throw new OrcoError('forbidden', 'Only people approve computers');
    this.sweep();
    const wanted = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const pairing = [...this.pairings.values()].find((p) => p.code.replace('-', '') === wanted);
    if (!pairing) throw new OrcoError('not_found', 'No computer is waiting with that code; it may have expired (codes last 10 minutes)');
    return pairing;
  }

  private sweep(): void {
    const now = this.store.now();
    for (const [id, p] of this.pairings) if (p.expiresAt <= now) this.pairings.delete(id);
  }

  /* Getting started */

  /** The first things to do, and which are done, for this person. */
  steps(actor: Participant, isConnected: (agentId: number) => boolean): Step[] {
    const db = this.store.db;
    const projects = this.store.listProjects(actor).length;
    const agents = db.prepare("SELECT id FROM participants WHERE kind = 'agent' AND owner_id = ?").all(actor.id) as { id: number }[];
    const ids = agents.map((a) => a.id);
    const list = ids.length ? ids.join(',') : '0';
    const worked = (db.prepare(`SELECT 1 FROM task_runs WHERE agent_id IN (${list}) UNION SELECT 1 FROM messages WHERE author_id IN (${list}) LIMIT 1`).get() !== undefined);
    const asked = db.prepare('SELECT 1 FROM tasks t JOIN participants a ON a.id = t.requester_id WHERE t.requester_id = ? OR a.owner_id = ? LIMIT 1').get(actor.id, actor.id) !== undefined;
    const finished = db.prepare("SELECT 1 FROM tasks WHERE requester_id = ? AND state = 'done' LIMIT 1").get(actor.id) !== undefined;
    return [
      { key: 'project', title: 'Make a project for your work', done: projects > 0 },
      { key: 'agent', title: 'Add an agent', done: ids.length > 0 },
      { key: 'connect', title: 'Connect it from your computer', done: worked || ids.some(isConnected) },
      { key: 'task', title: 'Ask it to do something', done: asked },
      { key: 'result', title: 'See it finish', done: finished },
    ];
  }
}
