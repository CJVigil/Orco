import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as z from 'zod/v4';
import { OrcoError } from '../errors.js';

/** Marks comments the sync wrote, so it never copies them back. */
const MARKER = '<!-- orco-sync -->';

const tokenEnv = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const common = {
  orco: z.object({ server: z.url(), token_env: tokenEnv }),
  repos: z
    .array(
      z.object({
        repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'repo is owner/name'),
        project: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
        /** Copy issue labels onto tickets (creating missing labels in Orco). */
        labels: z.boolean().default(true),
      }),
    )
    .min(1),
  poll_seconds: z.number().int().min(10).max(3600).default(60),
};
const giteaSchema = z.object({
  ...common,
  gitea: z.object({ url: z.url(), token_env: tokenEnv }),
  state: z.string().default('./orco-gitea-state.json'),
});
const githubSchema = z.object({
  ...common,
  /** api_url is https://<host>/api/v3 for GitHub Enterprise Server. */
  github: z.object({ api_url: z.url().default('https://api.github.com'), token_env: tokenEnv }),
  state: z.string().default('./orco-github-state.json'),
});

export type ForgeKind = 'gitea' | 'github';

const FORGE_NAMES: Record<ForgeKind, string> = { gitea: 'Gitea', github: 'GitHub' };

export interface ForgeSyncConfig {
  orco: { server: string; token_env: string };
  forge: { kind: ForgeKind; api: string; token_env: string };
  repos: { repo: string; project: string; labels: boolean }[];
  poll_seconds: number;
  state: string;
}

/** Reads a sync config: `gitea: {url, token_env}` for Gitea or Forgejo, `github: {api_url?, token_env}` for GitHub. */
export function loadForgeSyncConfig(path: string, kind: ForgeKind): ForgeSyncConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new OrcoError('invalid', `Cannot read ${path}: ${(err as Error).message}`);
  }
  const issues = (error: z.ZodError) => error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
  const invalid = (error: z.ZodError) => new OrcoError('invalid', `${FORGE_NAMES[kind]} sync config is not valid:\n${issues(error)}`);
  const at = (state: string) => resolve(dirname(resolve(path)), state);
  if (kind === 'gitea') {
    const result = giteaSchema.safeParse(raw);
    if (!result.success) throw invalid(result.error);
    const { gitea, state, ...rest } = result.data;
    return { ...rest, forge: { kind, api: `${gitea.url.replace(/\/+$/, '')}/api/v1`, token_env: gitea.token_env }, state: at(state) };
  }
  const result = githubSchema.safeParse(raw);
  if (!result.success) throw invalid(result.error);
  const { github, state, ...rest } = result.data;
  return { ...rest, forge: { kind, api: github.api_url.replace(/\/+$/, ''), token_env: github.token_env }, state: at(state) };
}

interface IssueSnapshot {
  ref: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
}

interface RepoState {
  /** Issues and comments are read from the forge from these times on. */
  issuesSince: string | null;
  commentsSince: string | null;
  /** Issue number to its ticket, with the issue as last synced. */
  issues: Record<string, IssueSnapshot>;
  /** Forge comment ids already copied into Orco. */
  comments: number[];
  /** Per ticket: the last Orco activity already copied to the forge. */
  activity: Record<string, number>;
}

interface SyncState {
  repos: Record<string, RepoState>;
}

type Json = Record<string, any>;
type Repo = ForgeSyncConfig['repos'][number];

/**
 * Keeps Gitea (or Forgejo) or GitHub issues and Orco tickets in step, run beside Orco as
 * `orco sync gitea` or `orco sync github`:
 *
 * - New issues become tickets (title, body with a link back, labels; closed issues land in a
 *   completed status). Edits to the title and body, and closing or reopening, follow.
 * - Issue comments become ticket comments, and ticket comments become issue comments.
 * - Moving a ticket to a completed or canceled status closes the issue; moving it back reopens it.
 *   When an agent finishes the ticket's task, its note is posted on the issue.
 *
 * It polls both sides, so Orco still makes no outbound calls. It acts in Orco as the user whose token
 * it holds (best a dedicated one, like "gitea") and skips that user's own changes, and it marks the
 * comments it writes on the forge, so nothing echoes back and forth.
 */
export class ForgeSync {
  private state: SyncState;
  private me = '';

  constructor(
    private readonly config: ForgeSyncConfig,
    private readonly tokens: { orco: string; forge: string },
    private readonly log: (message: string) => void = () => {},
  ) {
    this.state = existsSync(config.state) ? (JSON.parse(readFileSync(config.state, 'utf8')) as SyncState) : { repos: {} };
  }

  async runOnce(): Promise<void> {
    if (!this.me) this.me = ((await this.orco('GET', '/api/me')) as Json).name;
    for (const repo of this.config.repos) {
      const state = (this.state.repos[repo.repo] ??= { issuesSince: null, commentsSince: null, issues: {}, comments: [], activity: {} });
      try {
        await this.pullIssues(repo, state);
        await this.pullComments(repo, state);
        await this.pushTickets(repo, state);
      } catch (err) {
        this.log(`${repo.repo}: ${(err as Error).message}`);
      }
      this.save();
    }
  }

  /** Runs forever, every poll_seconds; resolves when the signal aborts. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.runOnce();
      await new Promise<void>((done) => {
        const timer = setTimeout(done, this.config.poll_seconds * 1000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          done();
        });
      });
    }
  }

  /* Forge → Orco */

  private async pullIssues(repo: Repo, state: RepoState): Promise<void> {
    const plan = (await this.orco('GET', `/api/projects/${repo.project}/plan`)) as Json;
    const completed = plan.statuses.find((s: Json) => s.category === 'completed')?.name;
    const reopened = (plan.statuses.find((s: Json) => s.category === 'unstarted') ?? plan.statuses.find((s: Json) => s.category === 'backlog'))?.name;
    let newest = state.issuesSince;
    for (let page = 1; page <= 100; page++) {
      const query = this.page(page, { state: 'all', ...(this.config.forge.kind === 'gitea' ? { type: 'issues' } : {}) });
      if (state.issuesSince) query.set('since', state.issuesSince);
      const issues = (await this.forge('GET', `/repos/${repo.repo}/issues?${query}`)) as Json[];
      for (const issue of issues) {
        if (issue.pull_request) continue;
        if (!newest || issue.updated_at > newest) newest = issue.updated_at;
        const key = String(issue.number);
        const known = state.issues[key];
        const body = issue.body ?? '';
        const description = `${body}\n\n— Synced from [${repo.repo}#${issue.number}](${issue.html_url})`.trim();
        if (!known) {
          const labels = repo.labels ? await this.labels(repo.project, issue.labels ?? []) : [];
          const written = (await this.orco('POST', `/api/projects/${repo.project}/tickets`, {
            title: issue.title,
            description,
            labels,
            ...(issue.state === 'closed' && completed ? { status: completed } : {}),
          })) as Json;
          state.issues[key] = { ref: written.ticket.ref, title: issue.title, body, state: issue.state };
          state.activity[written.ticket.ref] = written.ticket.lastActivityId;
          this.log(`${repo.repo}#${issue.number} → ${written.ticket.ref}`);
          continue;
        }
        const changes: Json = {};
        if (issue.title !== known.title) changes.title = issue.title;
        if (body !== known.body) changes.description = description;
        if (issue.state !== known.state) changes.status = issue.state === 'closed' ? completed : reopened;
        if (Object.keys(changes).length) {
          await this.orco('POST', `/api/tickets/${known.ref}`, changes);
          this.log(`${repo.repo}#${issue.number} → ${known.ref}: ${Object.keys(changes).join(', ')}`);
        }
        state.issues[key] = { ...known, title: issue.title, body, state: issue.state };
      }
      if (issues.length < this.pageSize) break;
    }
    state.issuesSince = newest;
  }

  private async pullComments(repo: Repo, state: RepoState): Promise<void> {
    let newest = state.commentsSince;
    for (let page = 1; page <= 100; page++) {
      // Oldest first, so a long backlog is read in order across pages.
      const query = this.page(page, this.config.forge.kind === 'github' ? { sort: 'updated', direction: 'asc' } : {});
      if (state.commentsSince) query.set('since', state.commentsSince);
      const comments = (await this.forge('GET', `/repos/${repo.repo}/issues/comments?${query}`)) as Json[];
      for (const comment of comments) {
        if (!newest || comment.updated_at > newest) newest = comment.updated_at;
        const number = /\/issues\/(\d+)$/.exec(comment.issue_url ?? '')?.[1];
        const known = number ? state.issues[number] : undefined;
        if (!known || state.comments.includes(comment.id) || String(comment.body ?? '').includes(MARKER)) continue;
        await this.orco('POST', `/api/tickets/${known.ref}/comments`, { text: `**${comment.user?.login ?? 'someone'}** on ${this.name}:\n\n${comment.body}` });
        state.comments.push(comment.id);
      }
      if (comments.length < this.pageSize) break;
    }
    state.comments = state.comments.slice(-2000);
    state.commentsSince = newest;
  }

  /* Orco → forge */

  private async pushTickets(repo: Repo, state: RepoState): Promise<void> {
    const plan = (await this.orco('GET', `/api/projects/${repo.project}/plan`)) as Json;
    const category = new Map<string, string>(plan.statuses.map((s: Json) => [s.name, s.category]));
    for (const [number, issue] of Object.entries(state.issues)) {
      const since = state.activity[issue.ref] ?? 0;
      const ticket = (await this.orco('GET', `/api/tickets/${issue.ref}?since=${since}`)) as Json;
      for (const a of ticket.activity as Json[]) {
        if (a.actor === this.me) continue;
        if (a.kind === 'comment') {
          await this.comment(repo.repo, number, `**${a.actor ?? 'Orco'}** in Orco (${issue.ref}):\n\n${a.body}`);
        } else if (a.kind === 'task' && a.detail?.state === 'done' && a.body) {
          await this.comment(repo.repo, number, `**${a.detail.agent}** finished task #${a.detail.taskId} on ${issue.ref}:\n\n${a.body}`);
        } else if (a.kind === 'change') {
          const status = (a.detail?.changes ?? []).find((c: Json) => c.field === 'status');
          if (!status) continue;
          const closed = ['completed', 'canceled'].includes(category.get(status.to) ?? '');
          const wanted = closed ? 'closed' : 'open';
          if (wanted !== issue.state) {
            await this.forge('PATCH', `/repos/${repo.repo}/issues/${number}`, { state: wanted });
            state.issues[number] = { ...issue, state: wanted };
            this.log(`${issue.ref} → ${repo.repo}#${number}: ${wanted}`);
          }
        }
      }
      state.activity[issue.ref] = ticket.lastActivityId;
    }
  }

  private async comment(repo: string, number: string, body: string): Promise<void> {
    await this.forge('POST', `/repos/${repo}/issues/${number}/comments`, { body: `${body}\n\n${MARKER}` });
  }

  /** Label names for a ticket, creating the ones Orco lacks. */
  private async labels(project: string, labels: Json[]): Promise<string[]> {
    const names = labels.map((l) => String(l.name).slice(0, 32)).filter(Boolean);
    const plan = (await this.orco('GET', `/api/projects/${project}/plan`)) as Json;
    for (const name of names) {
      if (plan.labels.some((l: Json) => l.name.toLowerCase() === name.toLowerCase())) continue;
      await this.orco('POST', `/api/projects/${project}/labels`, { name }).catch(() => {});
    }
    return names;
  }

  private save(): void {
    const tmp = `${this.config.state}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.config.state);
  }

  private get name(): string {
    return FORGE_NAMES[this.config.forge.kind];
  }

  private get pageSize(): number {
    return this.config.forge.kind === 'github' ? 100 : 50;
  }

  private page(page: number, extra: Record<string, string>): URLSearchParams {
    return new URLSearchParams({ ...extra, [this.config.forge.kind === 'github' ? 'per_page' : 'limit']: String(this.pageSize), page: String(page) });
  }

  private orco(method: string, path: string, body?: unknown): Promise<unknown> {
    return call(`${this.config.orco.server.replace(/\/+$/, '')}${path}`, method, { Authorization: `Bearer ${this.tokens.orco}` }, body, 'Orco');
  }

  private forge(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> =
      this.config.forge.kind === 'github'
        ? { Authorization: `Bearer ${this.tokens.forge}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'orco-sync' }
        : { Authorization: `token ${this.tokens.forge}` };
    return call(`${this.config.forge.api}${path}`, method, headers, body, this.name);
  }
}

async function call(url: string, method: string, headers: Record<string, string>, body: unknown, who: string): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = (data as { error?: string; message?: string } | null)?.error ?? (data as { message?: string } | null)?.message ?? text.slice(0, 200);
    throw new Error(`${who} ${method} ${new URL(url).pathname} answered ${res.status}: ${message}`);
  }
  return data;
}
