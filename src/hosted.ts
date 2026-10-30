import { DEFAULT_MODEL_TOOLS } from './bridge/model.js';
import { OrcoError } from './errors.js';
import type { Participant, Store, TaskPolicy } from './store.js';

/**
 * What a hosted agent is for, in plain words, and the Orco tools that takes. Every template is Orco
 * tools only: hosted agents have no shell and no files of their own. Agents that work in a repository
 * run on someone's computer (orco connect), not here.
 */
export const TEMPLATES = {
  questions: {
    title: 'Answers questions',
    description: 'Answers questions from the project’s tickets, notes and files, and says when it does not know.',
    prompt: 'You answer questions from what is in Orco (tickets, notes, files and earlier messages) and, when it is there, the company knowledge in search_knowledge. Say where an answer comes from, and say so plainly when you do not know.',
    tools: ['whoami', 'my_work', 'catch_up', 'read', 'post', 'get_task', 'update_task', 'report_progress', 'ask_question', 'get_ticket', 'list_tickets', 'search', 'search_knowledge', 'project_notes', 'read_file', 'project_files', 'read_project_file', 'my_notes', 'remember', 'flag_message'],
  },
  summaries: {
    title: 'Writes summaries',
    description: 'Sums up threads, tickets and progress, and can comment its summary on a ticket.',
    prompt: 'You write short, accurate summaries: what was decided, what is open, who is doing what. Quote ticket refs. Do not invent progress.',
    tools: ['whoami', 'my_work', 'catch_up', 'read', 'post', 'get_task', 'update_task', 'report_progress', 'ask_question', 'get_ticket', 'list_tickets', 'comment_ticket', 'search', 'search_knowledge', 'project_notes', 'read_file', 'project_files', 'read_project_file', 'my_notes', 'remember', 'flag_message'],
  },
  replies: {
    title: 'Drafts replies',
    description: 'Drafts answers to messages, emails or issues for a person to check and send.',
    prompt: 'You draft replies for a person to review: clear, kind and short. Post the draft as your result; never send anything outside Orco yourself.',
    tools: ['whoami', 'my_work', 'catch_up', 'read', 'post', 'get_task', 'update_task', 'report_progress', 'ask_question', 'get_ticket', 'search', 'search_knowledge', 'project_notes', 'read_file', 'project_files', 'read_project_file', 'my_notes', 'remember', 'flag_message'],
  },
  tickets: {
    title: 'Keeps tickets tidy',
    description: 'Files, updates and comments on tickets: splits plans into tickets, fills in details, links blockers.',
    prompt: 'You keep the project’s tickets clear and current: split work into small tickets, write acceptance criteria, link blockers. Ask before closing anything.',
    tools: ['whoami', 'my_work', 'catch_up', 'read', 'post', 'get_task', 'update_task', 'report_progress', 'ask_question', 'propose_plan', 'get_ticket', 'list_tickets', 'update_ticket', 'comment_ticket', 'search', 'search_knowledge', 'project_notes', 'read_file', 'project_files', 'read_project_file', 'my_notes', 'remember', 'flag_message'],
  },
  general: {
    title: 'General helper',
    description: 'Works on tasks with every Orco tool a task needs: tickets, project files, locks and approvals. Still no shell.',
    prompt: '',
    tools: DEFAULT_MODEL_TOOLS,
  },
} as const satisfies Record<string, { title: string; description: string; prompt: string; tools: readonly string[] }>;

export type TemplateName = keyof typeof TEMPLATES;
const TEMPLATE_NAMES = Object.keys(TEMPLATES) as TemplateName[];
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_INSTRUCTIONS = 4000;
/** A new hosted agent's monthly budget unless its creator picks another: low, so a mistake stays cheap. */
export const DEFAULT_BUDGET_CENTS = 500;
/** The most a person who is not an org admin may let a hosted agent spend a month: it is the org's key. */
export const MAX_MEMBER_BUDGET_CENTS = 5000;
/** How many agents a person who is not an org admin may run on the org's models. */
export const MAX_MEMBER_AGENTS = 3;
/** How many hosted agents one server runs at most: each is a loop inside the server process. */
export const MAX_HOSTED_AGENTS = 50;
const TRY_PER_HOUR = 20;
const MODEL_ERRORS: Record<number, string> = {
  400: 'The model did not accept the request; an org admin checks the model name',
  401: 'The model refused its API key; an org admin checks it',
  403: 'The model refused its API key; an org admin checks it',
  404: 'The model or its address was not found; an org admin checks them',
  429: 'The model is busy or out of credit; try again later',
};
const TRY_MAX_TOKENS = 300;

export interface ModelProvider {
  name: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  priceIn: number | null;
  priceOut: number | null;
  /** People other than org admins may run agents on it. */
  shared: boolean;
}

export interface HostedAgent {
  name: string;
  owner: string;
  provider: string;
  template: TemplateName;
  instructions: string;
  /** Projects it is limited to; empty means every project its owner is in. */
  projects: string[];
}

/** What the runner needs to run a hosted agent: never sent to a browser. */
export interface HostedRun {
  agentId: number;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
  price: { input_per_million: number; output_per_million: number } | undefined;
  tools: string[];
  prompt: string;
}

interface ProviderRow {
  id: number;
  name: string;
  base_url: string;
  model: string;
  ciphertext: Uint8Array | null;
  iv: Uint8Array | null;
  tag: Uint8Array | null;
  price_in: number | null;
  price_out: number | null;
  shared: number;
}

/** A model key is sealed for its provider and the origin it was given for. */
const keyAad = (name: string, origin: string) => `model:${name}:${origin}`;

const toProvider = (row: ProviderRow): ModelProvider => ({
  name: row.name,
  baseUrl: row.base_url,
  model: row.model,
  hasKey: row.ciphertext !== null,
  priceIn: row.price_in,
  priceOut: row.price_out,
  shared: row.shared === 1,
});

/**
 * Agents that run on Orco itself, made in the browser: an org admin sets up a model provider (an
 * OpenAI-compatible API and its key, stored encrypted), and people create agents on it from a
 * template, without a terminal. The server's hosted runner works their tasks with the same tool loop
 * the bridge uses for models. These are the only calls the server makes to the outside, and only to
 * the providers an org admin configured.
 */
export class Hosted {
  /** Told when hosted agents change, so the runner starts or stops them. */
  onChange: (agent: string) => void = () => {};

  constructor(private readonly store: Store) {}

  /* Model providers (org admins) */

  providers(actor: Participant): ModelProvider[] {
    if (actor.kind !== 'user' || actor.scope) throw new OrcoError('forbidden', 'Only people see model providers');
    const rows = this.store.db.prepare('SELECT * FROM model_providers ORDER BY name').all() as unknown as ProviderRow[];
    const admin = this.store.isOrgAdmin(actor);
    return rows.filter((r) => admin || r.shared === 1).map(toProvider);
  }

  saveProvider(
    actor: Participant,
    input: { name: string; baseUrl: string; model: string; apiKey?: string | null; priceIn?: number | null; priceOut?: number | null; shared?: boolean },
  ): ModelProvider {
    this.orgAdmin(actor);
    const name = String(input.name ?? '').trim().toLowerCase();
    if (!NAME.test(name)) throw new OrcoError('invalid', 'Name the provider in lowercase letters, digits and dashes, like openai or local-llama');
    let url: URL;
    try {
      url = new URL(String(input.baseUrl ?? '').trim());
    } catch {
      throw new OrcoError('invalid', 'The API address is not a URL, like https://api.openai.com/v1');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OrcoError('invalid', 'The API address must be http or https');
    if (url.username || url.password) throw new OrcoError('invalid', 'Put the key in the API key field, not in the address');
    const model = String(input.model ?? '').trim();
    if (!model || model.length > 200) throw new OrcoError('invalid', 'Name the model, like gpt-4o-mini or llama3.1');
    const price = (value: number | null | undefined, field: string) => {
      if (value === undefined || value === null) return null;
      if (typeof value !== 'number' || !(value >= 0) || value > 10_000) throw new OrcoError('invalid', `${field} is US dollars per million tokens`);
      return value;
    };
    const existing = this.store.db.prepare('SELECT * FROM model_providers WHERE name = ?').get(name) as unknown as ProviderRow | undefined;
    const baseUrl = url.toString().replace(/\/+$/, '');
    // A stored key is bound to the address it was given for: sending it somewhere new takes typing it
    // again, so nobody can point a provider at their own server and collect a key they never knew.
    if (existing?.ciphertext && new URL(existing.base_url).origin !== url.origin && typeof input.apiKey !== 'string') {
      throw new OrcoError('invalid', 'Enter the API key again to use it at a new address');
    }
    // A key typed in replaces the stored one; leaving it out keeps it; an empty string removes it.
    let sealed: { ciphertext: Buffer | Uint8Array | null; iv: Buffer | Uint8Array | null; tag: Buffer | Uint8Array | null } = existing
      ? { ciphertext: existing.ciphertext, iv: existing.iv, tag: existing.tag }
      : { ciphertext: null, iv: null, tag: null };
    if (typeof input.apiKey === 'string') {
      sealed = input.apiKey.trim() ? this.store.secrets.seal(input.apiKey.trim(), keyAad(name, url.origin)) : { ciphertext: null, iv: null, tag: null };
    }
    const priceIn = price(input.priceIn, 'Input price');
    const priceOut = price(input.priceOut, 'Output price');
    // A model someone pays for needs prices, or no budget could ever stop its agents.
    if (sealed.ciphertext && (priceIn === null || priceOut === null)) {
      throw new OrcoError('invalid', 'A model with an API key needs its prices (US dollars per million input and output tokens), so budgets can stop its agents');
    }
    const values = [baseUrl, model, sealed.ciphertext, sealed.iv, sealed.tag, priceIn, priceOut, input.shared ? 1 : 0];
    if (existing) {
      this.store.db
        .prepare('UPDATE model_providers SET base_url = ?, model = ?, ciphertext = ?, iv = ?, tag = ?, price_in = ?, price_out = ?, shared = ? WHERE id = ?')
        .run(...values, existing.id);
    } else {
      this.store.db
        .prepare('INSERT INTO model_providers (base_url, model, ciphertext, iv, tag, price_in, price_out, shared, name, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(...values, name, actor.id);
    }
    this.store.audit.record(actor, existing ? 'model.update' : 'model.create', { subject: `model:${name}`, detail: { baseUrl: values[0], model, shared: Boolean(input.shared), key: sealed.ciphertext !== null } });
    for (const agent of this.agentsOn(name)) this.onChange(agent);
    return toProvider(this.store.db.prepare('SELECT * FROM model_providers WHERE name = ?').get(name) as unknown as ProviderRow);
  }

  removeProvider(actor: Participant, name: string): void {
    this.orgAdmin(actor);
    const row = this.providerRow(name);
    const using = this.agentsOn(row.name);
    if (using.length) throw new OrcoError('conflict', `${using.join(', ')} ${using.length === 1 ? 'runs' : 'run'} on ${row.name}; stop ${using.length === 1 ? 'it' : 'them'} first`);
    this.store.db.prepare('DELETE FROM model_providers WHERE id = ?').run(row.id);
    this.store.audit.record(actor, 'model.delete', { subject: `model:${row.name}` });
  }

  /* Hosted agents */

  /** Makes an agent that runs on Orco: owned by the actor, with a template, projects, policy and a budget. */
  create(
    actor: Participant,
    input: { name: string; provider: string; template: string; instructions?: string; projects?: string[]; policy?: TaskPolicy; budgetCents?: number | null },
  ): HostedAgent {
    if (actor.kind !== 'user' || actor.scope) throw new OrcoError('forbidden', 'Only people make agents');
    const provider = this.usableProvider(actor, input.provider);
    const admin = this.store.isOrgAdmin(actor);
    const total = (this.store.db.prepare('SELECT count(*) AS n FROM hosted_agents').get() as { n: number }).n;
    if (total >= MAX_HOSTED_AGENTS) throw new OrcoError('conflict', `This Orco runs ${MAX_HOSTED_AGENTS} agents already; remove one first`);
    if (!admin) {
      const mine = (this.store.db.prepare('SELECT count(*) AS n FROM hosted_agents h JOIN participants a ON a.id = h.agent_id WHERE a.owner_id = ?').get(actor.id) as { n: number }).n;
      if (mine >= MAX_MEMBER_AGENTS) throw new OrcoError('conflict', `You run ${MAX_MEMBER_AGENTS} agents on Orco already; remove one, or ask an org admin`);
    }
    const template = this.template(input.template);
    const instructions = this.instructions(input.instructions);
    const projectIds = this.projectIds(actor, input.projects ?? []);
    const name = String(input.name ?? '').trim().toLowerCase();
    let agent!: Participant;
    this.store.begin();
    try {
      agent = this.store.createAgent(actor.name, name).participant;
      this.store.db
        .prepare('INSERT INTO hosted_agents (agent_id, provider_id, template, instructions, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(agent.id, provider.id, template, instructions, actor.id);
      this.setProjects(agent.id, projectIds);
      // Safe defaults: tasks from anyone else wait for the owner's yes, and spending is capped low.
      this.store.setTaskPolicy(actor, agent.name, input.policy ?? 'ask');
      const budget = input.budgetCents === undefined ? DEFAULT_BUDGET_CENTS : input.budgetCents;
      if (!admin && (budget === null || budget + this.memberCommitted(actor.id, agent.id) > MAX_MEMBER_BUDGET_CENTS)) {
        throw new OrcoError('invalid', `Your agents on the org's models can have at most $${MAX_MEMBER_BUDGET_CENTS / 100} a month between them; an org admin can raise it`);
      }
      if (budget !== null) this.store.controls.setBudget(actor, 'agent', agent.name, budget);
      this.store.audit.record(actor, 'hosted.create', { subject: `agent:${agent.name}`, detail: { provider: provider.name, template, projects: input.projects ?? [] } });
      this.store.commit();
    } catch (err) {
      this.store.rollback();
      throw err;
    }
    this.onChange(agent.name);
    return this.get(actor, agent.name);
  }

  update(actor: Participant, name: string, input: { provider?: string; template?: string; instructions?: string; projects?: string[] }): HostedAgent {
    const agent = this.owned(actor, name);
    const row = this.hostedRow(agent.id);
    if (!row) throw new OrcoError('not_found', `${name} does not run on Orco`);
    if (input.provider !== undefined) this.store.db.prepare('UPDATE hosted_agents SET provider_id = ? WHERE agent_id = ?').run(this.usableProvider(actor, input.provider).id, agent.id);
    if (input.template !== undefined) this.store.db.prepare('UPDATE hosted_agents SET template = ? WHERE agent_id = ?').run(this.template(input.template), agent.id);
    if (input.instructions !== undefined) this.store.db.prepare('UPDATE hosted_agents SET instructions = ? WHERE agent_id = ?').run(this.instructions(input.instructions), agent.id);
    if (input.projects !== undefined) this.setProjects(agent.id, this.projectIds(this.store.participantById(agent.ownerId!)!, input.projects));
    this.store.audit.record(actor, 'hosted.update', { subject: `agent:${name}`, detail: input });
    this.onChange(name);
    return this.get(actor, name);
  }

  /** Stops running it on Orco. The agent stays (its history, its name), and can be connected elsewhere. */
  remove(actor: Participant, name: string): void {
    const agent = this.owned(actor, name);
    const { changes } = this.store.db.prepare('DELETE FROM hosted_agents WHERE agent_id = ?').run(agent.id);
    if (!changes) throw new OrcoError('not_found', `${name} does not run on Orco`);
    this.store.rotateToken(name); // the runner's token stops working at once
    // What only made sense on Orco goes too: its project limits and the budget on the org's model.
    this.store.db.prepare('DELETE FROM agent_projects WHERE agent_id = ?').run(agent.id);
    this.store.db.prepare("DELETE FROM budgets WHERE scope = 'agent' AND target_id = ?").run(agent.id);
    this.store.audit.record(actor, 'hosted.remove', { subject: `agent:${name}` });
    this.onChange(name);
  }

  get(actor: Participant, name: string): HostedAgent {
    const agent = this.store.participantByName(name);
    if (!agent || agent.kind !== 'agent' || (agent.ownerId !== actor.id && !this.store.isOrgAdmin(actor))) throw new OrcoError('not_found', `No agent ${name}`);
    const row = this.hostedRow(agent.id);
    if (!row) throw new OrcoError('not_found', `${name} does not run on Orco`);
    return this.toHosted(agent, row);
  }

  /** The hosted part of an agent's settings, or null when it runs elsewhere. */
  of(agent: Participant): HostedAgent | null {
    const row = this.hostedRow(agent.id);
    return row ? this.toHosted(agent, row) : null;
  }

  /** Every hosted agent, with what the runner needs. Server-side only: it holds decrypted keys. */
  runs(): HostedRun[] {
    const rows = this.store.db.prepare('SELECT h.agent_id FROM hosted_agents h ORDER BY h.agent_id').all() as { agent_id: number }[];
    return rows.flatMap(({ agent_id }) => {
      const run = this.runFor(agent_id);
      return run ? [run] : [];
    });
  }

  runFor(agentId: number): HostedRun | null {
    const agent = this.store.participantById(agentId);
    const row = this.hostedRow(agentId);
    if (!agent || !row) return null;
    const provider = this.store.db.prepare('SELECT * FROM model_providers WHERE id = ?').get(row.provider_id) as unknown as ProviderRow;
    const template = TEMPLATES[row.template as TemplateName] ?? TEMPLATES.questions;
    let apiKey: string | undefined;
    if (provider.ciphertext && provider.iv && provider.tag) {
      const sealed = { ciphertext: provider.ciphertext, iv: provider.iv, tag: provider.tag };
      try {
        apiKey = this.store.secrets.open(sealed, keyAad(provider.name, new URL(provider.base_url).origin));
      } catch {
        apiKey = this.store.secrets.open(sealed, `model:${provider.name}`); // stored before keys were bound to an address
      }
    }
    const prompt = [template.prompt, row.instructions ? `Your owner's instructions:\n${row.instructions}` : ''].filter(Boolean).join('\n\n');
    return {
      agentId,
      name: agent.name,
      baseUrl: provider.base_url,
      model: provider.model,
      apiKey,
      price: provider.price_in !== null && provider.price_out !== null ? { input_per_million: provider.price_in, output_per_million: provider.price_out } : undefined,
      tools: [...template.tools],
      prompt,
    };
  }

  /** One message to the model, no tools, for "Try it": the owner sees how it answers before giving it work. */
  async tryIt(actor: Participant, name: string, message: string, signal?: AbortSignal): Promise<{ reply: string }> {
    const agent = this.owned(actor, name);
    const text = String(message ?? '').trim();
    if (!text || text.length > 2000) throw new OrcoError('invalid', 'Say something to it, up to 2000 characters');
    this.store.checkRate(actor, 'post');
    const run = this.runFor(agent.id);
    if (!run) throw new OrcoError('not_found', `${name} does not run on Orco`);
    // Tries cost money too: limited per hour, short, and counted against its budget.
    const hour = this.store.now() - 3600_000;
    const recent = (this.tries.get(agent.id) ?? []).filter((t) => t > hour);
    if (recent.length >= TRY_PER_HOUR) throw new OrcoError('rate_limited', `${name} can be tried ${TRY_PER_HOUR} times an hour`);
    const left = this.budgetLeft(agent.id);
    if (left !== null && left <= 0) throw new OrcoError('forbidden', `${name}'s monthly budget is used up`);
    if (run.apiKey && !run.price) throw new OrcoError('conflict', `${name}'s model has no prices set; an org admin adds them so its budget can work`);
    this.tries.set(agent.id, [...recent, this.store.now()]);
    const res = await fetch(`${run.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(run.apiKey ? { Authorization: `Bearer ${run.apiKey}` } : {}) },
      body: JSON.stringify({
        model: run.model,
        messages: [
          { role: 'system', content: `You are ${name}, an AI agent in Orco, a team chat. ${run.prompt}\nThis is a quick test from your owner: answer briefly. You cannot use tools here.` },
          { role: 'user', content: text },
        ],
        max_tokens: TRY_MAX_TOKENS,
      }),
      redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]),
    }).catch(() => {
      throw new OrcoError('conflict', 'Could not reach the model; an org admin checks its address');
    });
    const data = (await res.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string } | string;
    };
    // The provider's own error text stays out: it can echo the key or name internal hosts.
    if (!res.ok) throw new OrcoError('conflict', MODEL_ERRORS[res.status] ?? `The model answered with an error (HTTP ${res.status})`);
    if (run.price) {
      const reply = String(data.choices?.[0]?.message?.content ?? '');
      // No usage reported is charged by an estimate (four characters a token), never as free.
      const input = data.usage ? Number(data.usage.prompt_tokens) || 0 : Math.ceil((run.prompt.length + text.length + 200) / 4);
      const output = data.usage ? Number(data.usage.completion_tokens) || 0 : Math.ceil(reply.length / 4);
      const cents = (input * run.price.input_per_million + output * run.price.output_per_million) / 10_000;
      this.store.controls.recordSpend(agent.id, cents, { note: 'try it' });
    }
    return { reply: String(data.choices?.[0]?.message?.content ?? '').slice(0, 8000) };
  }

  /** The org admin who answers for a hosted agent's spending: whoever set up its model (or any org admin). */
  providerCreatorOf(agent: Participant): Participant | null {
    const row = this.store.db
      .prepare('SELECT m.created_by FROM hosted_agents h JOIN model_providers m ON m.id = h.provider_id WHERE h.agent_id = ?')
      .get(agent.id) as { created_by: number } | undefined;
    if (!row) return null;
    const creator = this.store.participantById(row.created_by);
    return creator && this.store.isOrgAdmin(creator) ? creator : (this.store.orgAdmins()[0] ?? null);
  }

  /**
   * What a person has committed on the org's models this month, apart from one agent: each of their
   * other hosted agents counts its budget or what it spent, whichever is more, and money spent by
   * agents that no longer run here (removed ones too) counts as spent.
   */
  memberCommitted(ownerId: number, except?: number): number {
    const hosted = this.store.db
      .prepare(
        `SELECT a.id, b.monthly_cents FROM hosted_agents h JOIN participants a ON a.id = h.agent_id
         LEFT JOIN budgets b ON b.scope = 'agent' AND b.target_id = a.id WHERE a.owner_id = ?`,
      )
      .all(ownerId) as { id: number; monthly_cents: number | null }[];
    const since = this.store.controls.monthStart();
    let cents = 0;
    for (const row of hosted) if (row.id !== except) cents += Math.max(row.monthly_cents ?? 0, this.store.controls.spentThisMonth('agent', row.id));
    const ids = hosted.map((r) => r.id);
    cents += (
      this.store.db
        .prepare(`SELECT coalesce(sum(cents), 0) AS cents FROM spend WHERE owner_id = ? AND org_model = 1 AND created_at >= ? AND agent_id NOT IN (${ids.map(() => '?').join(',') || 'NULL'})`)
        .get(ownerId, since, ...ids) as { cents: number }
    ).cents;
    return cents;
  }

  /**
   * What an agent may still spend this month, in cents, under both its own budget and its owner's cap
   * on the org's models (people who are not org admins); null when neither applies.
   */
  budgetLeft(agentId: number): number | null {
    const own = this.store.controls.agentBudgetLeft(agentId);
    const agent = this.store.participantById(agentId);
    const owner = agent?.ownerId ? this.store.participantById(agent.ownerId) : null;
    const cap = owner && !this.store.isOrgAdmin(owner) && this.hostedRow(agentId) ? MAX_MEMBER_BUDGET_CENTS - this.store.controls.ownerOrgSpend(owner.id) : null;
    if (own === null) return cap;
    return cap === null ? own : Math.min(own, cap);
  }

  private readonly tries = new Map<number, number[]>();

  /* Helpers */

  private toHosted(agent: Participant, row: { provider_id: number; template: string; instructions: string }): HostedAgent {
    const provider = this.store.db.prepare('SELECT name FROM model_providers WHERE id = ?').get(row.provider_id) as { name: string };
    const projects = this.store.db
      .prepare('SELECT p.name FROM agent_projects ap JOIN projects p ON p.id = ap.project_id WHERE ap.agent_id = ? ORDER BY p.name')
      .all(agent.id) as { name: string }[];
    return {
      name: agent.name,
      owner: this.store.ownerName(agent)!,
      provider: provider.name,
      template: row.template as TemplateName,
      instructions: row.instructions,
      projects: projects.map((p) => p.name),
    };
  }

  private hostedRow(agentId: number) {
    return this.store.db.prepare('SELECT provider_id, template, instructions FROM hosted_agents WHERE agent_id = ?').get(agentId) as
      | { provider_id: number; template: string; instructions: string }
      | undefined;
  }

  private agentsOn(provider: string): string[] {
    return (
      this.store.db
        .prepare('SELECT a.name FROM hosted_agents h JOIN participants a ON a.id = h.agent_id JOIN model_providers m ON m.id = h.provider_id WHERE m.name = ? ORDER BY a.name')
        .all(provider) as { name: string }[]
    ).map((r) => r.name);
  }

  private providerRow(name: string): ProviderRow {
    const row = this.store.db.prepare('SELECT * FROM model_providers WHERE name = ?').get(String(name ?? '').trim().toLowerCase()) as unknown as ProviderRow | undefined;
    if (!row) throw new OrcoError('not_found', `No model provider ${name}`);
    return row;
  }

  private usableProvider(actor: Participant, name: string): ProviderRow {
    if (!this.store.secrets.enabled) throw new OrcoError('invalid', 'Agents that run on Orco need ORCO_SECRETS_KEY on the server, to keep model keys encrypted');
    const row = this.providerRow(name);
    if (row.shared !== 1 && !this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', `Only org admins run agents on ${row.name}`);
    return row;
  }

  private template(name: string): TemplateName {
    if (!TEMPLATE_NAMES.includes(name as TemplateName)) throw new OrcoError('invalid', `Pick what it does: ${TEMPLATE_NAMES.join(', ')}`);
    return name as TemplateName;
  }

  private instructions(text: string | undefined): string {
    const out = String(text ?? '').trim();
    if (out.length > MAX_INSTRUCTIONS) throw new OrcoError('invalid', `Instructions are at most ${MAX_INSTRUCTIONS} characters`);
    return out;
  }

  /** Projects the owner is in (and can write to), by name. */
  private projectIds(owner: Participant, names: string[]): number[] {
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) throw new OrcoError('invalid', 'projects is a list of project names');
    return [...new Set(names)].map((n) => this.store.writableProject(owner, n).id);
  }

  private setProjects(agentId: number, projectIds: number[]): void {
    this.store.db.prepare('DELETE FROM agent_projects WHERE agent_id = ?').run(agentId);
    for (const id of projectIds) this.store.db.prepare('INSERT INTO agent_projects (agent_id, project_id) VALUES (?, ?)').run(agentId, id);
  }

  private owned(actor: Participant, name: string): Participant {
    if (actor.kind !== 'user' || actor.scope) throw new OrcoError('forbidden', 'Only people manage agents');
    const agent = this.store.participantByName(name);
    if (!agent || agent.kind !== 'agent' || (agent.ownerId !== actor.id && !this.store.isOrgAdmin(actor))) throw new OrcoError('not_found', `No agent ${name}`);
    return agent;
  }

  private orgAdmin(actor: Participant): void {
    if (!this.store.isOrgAdmin(actor)) throw new OrcoError('forbidden', 'Only org admins set up model providers');
  }
}
