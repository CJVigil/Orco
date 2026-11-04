import type { Participant, Store } from './store.js';

/*
 * Commits on tickets (#107). A push delivered to a project's webhook links each commit whose message
 * names one of the project's ticket keys (BFF-134) on that ticket, with its sha, branch, author and
 * link. CI deliveries then mark the commit passed or failed, and a successful deploy job marks it
 * deployed. CI results are kept per repository, branch and sha, so wait_for can wait on one.
 * All of it is text from outside Orco, shown as data.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

export type CiState = 'success' | 'failure' | 'pending';

export interface TicketCommit {
  sha: string;
  repo: string;
  branch: string;
  author: string;
  message: string;
  url: string | null;
  at: string;
  ci: CiState | null;
  ciSummary: string | null;
  deployedAt: string | null;
}

const KEY_REF = /\b([A-Z][A-Z0-9]{0,9})-(\d{1,9})\b/g;
const DEPLOY = /\bdeploy/i;
const MAX_COMMITS = 50;

export class Commits {
  constructor(private readonly store: Store) {}

  /** Reads a forge delivery for a project: links pushed commits to tickets, and records CI per commit. */
  ingest(projectId: number, event: string, payload: unknown, now: string): void {
    const body = obj(payload);
    const repo = str(obj(body.repository).full_name).slice(0, 200);
    if (event === 'push') {
      const branch = str(body.ref).replace(/^refs\/heads\//, '').slice(0, 200);
      const commits = Array.isArray(body.commits) ? (body.commits as unknown[]).slice(0, MAX_COMMITS) : [];
      for (const raw of commits) {
        const c = obj(raw);
        const sha = str(c.id) || str(c.sha);
        if (!/^[0-9a-f]{7,64}$/i.test(sha)) continue;
        const message = str(c.message).slice(0, 2000);
        const author = (str(obj(c.author).username) || str(obj(c.author).name) || str(obj(c.committer).name)).slice(0, 100);
        const url = /^https:\/\//.test(str(c.url)) ? str(c.url).slice(0, 500) : null;
        for (const ticketId of this.ticketsNamed(projectId, message)) {
          this.store.db
            .prepare(
              `INSERT INTO ticket_commits (ticket_id, sha, repo, branch, author, message, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (ticket_id, sha) DO UPDATE SET branch = excluded.branch`,
            )
            .run(ticketId, sha.toLowerCase(), repo, branch, author, message, url, now);
          // A result that arrived before the push (it happens) applies at once.
          const known = this.store.db.prepare('SELECT state, summary FROM ci_results WHERE project_id = ? AND sha = ? ORDER BY updated_at DESC LIMIT 1').get(projectId, sha.toLowerCase()) as
            | { state: CiState; summary: string }
            | undefined;
          if (known) this.store.db.prepare('UPDATE ticket_commits SET ci = ?, ci_summary = ? WHERE ticket_id = ? AND sha = ?').run(known.state, known.summary, ticketId, sha.toLowerCase());
          this.store.events.emit('ticket', { projectId, ref: null });
        }
      }
      return;
    }
    const ci = ciOfCommit(event, body);
    if (!ci) return;
    this.store.db
      .prepare(
        `INSERT INTO ci_results (project_id, repo, branch, sha, source, state, summary, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, repo, sha, source) DO UPDATE SET state = excluded.state, summary = excluded.summary, branch = excluded.branch, updated_at = excluded.updated_at`,
      )
      .run(projectId, repo, ci.branch, ci.sha, ci.source, ci.state, ci.summary, now);
    // The commit's overall result: failed if any check failed, pending if any still runs, else passed.
    const all = this.store.db.prepare('SELECT state FROM ci_results WHERE project_id = ? AND sha = ?').all(projectId, ci.sha) as { state: CiState }[];
    const overall: CiState = all.some((r) => r.state === 'failure') ? 'failure' : all.some((r) => r.state === 'pending') ? 'pending' : 'success';
    const changed = this.store.db
      .prepare('UPDATE ticket_commits SET ci = ?, ci_summary = ? WHERE sha = ? AND ticket_id IN (SELECT id FROM tickets WHERE project_id = ?)')
      .run(overall, ci.summary, ci.sha, projectId);
    if (ci.state === 'success' && DEPLOY.test(ci.source)) {
      this.store.db.prepare('UPDATE ticket_commits SET deployed_at = ? WHERE sha = ? AND ticket_id IN (SELECT id FROM tickets WHERE project_id = ?)').run(now, ci.sha, projectId);
    }
    this.store.events.emit('ci', { projectId, sha: ci.sha, repo, branch: ci.branch });
    if (Number(changed.changes) > 0) this.store.events.emit('ticket', { projectId, ref: null });
  }

  forTicket(ticketId: number): TicketCommit[] {
    return (
      this.store.db
        .prepare('SELECT sha, repo, branch, author, message, url, created_at, ci, ci_summary, deployed_at FROM ticket_commits WHERE ticket_id = ? ORDER BY created_at DESC, sha LIMIT 30')
        .all(ticketId) as {
        sha: string;
        repo: string;
        branch: string;
        author: string;
        message: string;
        url: string | null;
        created_at: string;
        ci: CiState | null;
        ci_summary: string | null;
        deployed_at: string | null;
      }[]
    ).map((r) => ({ sha: r.sha, repo: r.repo, branch: r.branch, author: r.author, message: r.message, url: r.url, at: r.created_at, ci: r.ci, ciSummary: r.ci_summary, deployedAt: r.deployed_at }));
  }

  /** The latest CI result for a sha (or a branch's newest commit) in projects the actor can see: overall state and checks. */
  ciFor(actor: Participant, where: { repo?: string; sha?: string; branch?: string }): { state: CiState; checks: { source: string; state: CiState; summary: string }[]; sha: string } | null {
    const visible = this.store.projectFilter(actor, 'c.project_id');
    const params: string[] = [];
    let cond = '';
    if (where.repo) {
      cond += ' AND c.repo = ?';
      params.push(where.repo);
    }
    let sha = where.sha?.toLowerCase();
    if (!sha && where.branch) {
      const latest = this.store.db
        .prepare(`SELECT c.sha FROM ci_results c WHERE ${visible.sql} AND c.branch = ?${cond} ORDER BY c.updated_at DESC LIMIT 1`)
        .get(...visible.params, where.branch, ...params) as { sha: string } | undefined;
      sha = latest?.sha;
    }
    if (!sha) return null;
    const rows = this.store.db
      .prepare(`SELECT c.source, c.state, c.summary FROM ci_results c WHERE ${visible.sql} AND (c.sha = ? OR c.sha LIKE ?)${cond} ORDER BY c.source`)
      .all(...visible.params, sha, `${sha}%`, ...params) as { source: string; state: CiState; summary: string }[];
    if (!rows.length) return null;
    const state: CiState = rows.some((r) => r.state === 'failure') ? 'failure' : rows.some((r) => r.state === 'pending') ? 'pending' : 'success';
    return { state, checks: rows, sha };
  }

  /** Tickets of this project a commit message names, by the project's key. */
  private ticketsNamed(projectId: number, message: string): number[] {
    const key = (this.store.db.prepare('SELECT ticket_key FROM projects WHERE id = ?').get(projectId) as { ticket_key: string | null } | undefined)?.ticket_key;
    if (!key) return [];
    const ids = new Set<number>();
    for (const m of message.matchAll(KEY_REF)) {
      if (m[1] !== key) continue;
      const row = this.store.db.prepare('SELECT id FROM tickets WHERE project_id = ? AND number = ?').get(projectId, Number(m[2])) as { id: number } | undefined;
      if (row) ids.add(row.id);
      if (ids.size >= 5) break;
    }
    return [...ids];
  }
}

/** A CI result for one commit, from a GitHub, Gitea or Forgejo delivery: any branch, keyed by sha. */
export function ciOfCommit(event: string, body: Json): { sha: string; branch: string; source: string; state: CiState; summary: string } | null {
  const repo = str(obj(body.repository).full_name);
  const state = (conclusion: string, status: string): CiState | null => {
    if (['success', 'neutral', 'skipped'].includes(conclusion)) return 'success';
    if (['failure', 'timed_out', 'startup_failure', 'action_required', 'error'].includes(conclusion)) return 'failure';
    if (conclusion === 'cancelled' || conclusion === 'stale') return null;
    return ['queued', 'in_progress', 'requested', 'waiting', 'pending', 'running'].includes(status) ? 'pending' : null;
  };
  let sha = '';
  let branch = '';
  let source = '';
  let result: CiState | null = null;
  if (event === 'workflow_run' || event === 'workflow_job' || event === 'check_suite' || event === 'check_run') {
    const run = obj(body[event]);
    sha = str(run.head_sha) || str(obj(run.check_suite).head_sha);
    branch = str(run.head_branch) || str(obj(run.check_suite).head_branch);
    source = str(run.name) || str(obj(run.app).name) || event;
    result = state(str(run.conclusion), str(run.status));
  } else if (event === 'status') {
    sha = str(body.sha);
    const names = Array.isArray(body.branches) ? (body.branches as unknown[]).map((b) => str(obj(b).name)) : [];
    branch = names[0] ?? '';
    source = str(body.context) || 'CI';
    result = str(body.state) === 'error' ? 'failure' : state(str(body.state), str(body.state));
  } else {
    return null;
  }
  if (!result || !/^[0-9a-f]{7,64}$/i.test(sha)) return null;
  const word = result === 'success' ? 'passed' : result === 'failure' ? 'failed' : 'running';
  return { sha: sha.toLowerCase(), branch: branch.slice(0, 200), source: source.slice(0, 200), state: result, summary: `${source} ${word}${repo ? ` in ${repo}` : ''}`.slice(0, 200) };
}
