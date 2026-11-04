/*
 * orco forge-poll (#107): for an Orco the forge cannot reach (a LAN-only server and GitHub-hosted
 * repositories), a machine that can reach both polls the forge's API and posts what it finds to a
 * project webhook, shaped like the forge's own deliveries: pushes, then check runs or commit
 * statuses for each new commit. The Orco server still never calls out; this runs where you start it.
 */

type Json = Record<string, unknown>;

export interface PollOptions {
  forge: 'github' | 'gitea';
  /** owner/name */
  repo: string;
  branch: string;
  /** The project webhook URL from Orco (Integrations), which is its own credential. */
  hook: string;
  /** API base: https://api.github.com, or https://gitea.example/api/v1. */
  api: string;
  token?: string;
  intervalMs: number;
  /** Stop after this many rounds (default: run until stopped). */
  rounds?: number;
  log: (line: string) => void;
  fetchFn?: typeof fetch;
}

export async function forgePoll(o: PollOptions): Promise<void> {
  const f = o.fetchFn ?? fetch;
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'orco-forge-poll' };
  if (o.token) headers.authorization = o.forge === 'github' ? `Bearer ${o.token}` : `token ${o.token}`;
  const get = async (path: string): Promise<unknown> => {
    const res = await f(`${o.api.replace(/\/+$/, '')}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${o.forge} answered ${res.status} for ${path}`);
    return res.json();
  };
  const deliver = async (event: string, body: Json) => {
    const res = await f(o.hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [o.forge === 'github' ? 'x-github-event' : 'x-gitea-event']: event },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Orco answered ${res.status} to the ${event} delivery`);
  };
  const repository = { full_name: o.repo, default_branch: o.branch };
  const seen = new Set<string>();
  const results = new Map<string, string>();
  let first = true;
  for (let round = 1; ; round++) {
    try {
      const commits = (await get(o.forge === 'github' ? `/repos/${o.repo}/commits?sha=${encodeURIComponent(o.branch)}&per_page=20` : `/repos/${o.repo}/commits?sha=${encodeURIComponent(o.branch)}&limit=20`)) as Json[];
      const fresh = commits.filter((c) => !seen.has(String(c.sha)));
      for (const c of fresh) seen.add(String(c.sha));
      // The first look only learns what is there, so starting the poller does not replay history.
      if (!first && fresh.length) {
        await deliver('push', {
          ref: `refs/heads/${o.branch}`,
          repository,
          commits: fresh.reverse().map((c) => {
            const commit = (c.commit ?? {}) as Json;
            const author = (commit.author ?? {}) as Json;
            return { id: c.sha, message: commit.message, author: { name: author.name, username: ((c.author ?? {}) as Json).login }, url: c.html_url };
          }),
        });
        o.log(`${fresh.length} new commit${fresh.length === 1 ? '' : 's'} on ${o.branch}`);
      }
      first = false;
      // CI on the newest commits: GitHub check runs, Gitea commit statuses.
      for (const c of commits.slice(0, 5)) {
        const sha = String(c.sha);
        if (o.forge === 'github') {
          const runs = ((await get(`/repos/${o.repo}/commits/${sha}/check-runs?per_page=50`)) as Json).check_runs as Json[];
          for (const run of runs ?? []) {
            const key = `${sha}:${run.name}`;
            const state = `${run.status}:${run.conclusion}`;
            if (results.get(key) === state) continue;
            results.set(key, state);
            await deliver('check_run', { action: 'completed', repository, check_run: { name: run.name, head_sha: sha, status: run.status, conclusion: run.conclusion, check_suite: { head_branch: o.branch } } });
          }
        } else {
          const statuses = (await get(`/repos/${o.repo}/commits/${sha}/statuses?limit=50`)) as Json[];
          for (const st of statuses ?? []) {
            const key = `${sha}:${st.context}`;
            if (results.get(key) === st.status) continue;
            results.set(key, String(st.status));
            await deliver('status', { repository, sha, context: st.context, state: st.status, description: st.description, branches: [{ name: o.branch }] });
          }
        }
      }
    } catch (err) {
      o.log(`forge-poll: ${(err as Error).message}`);
    }
    if (o.rounds !== undefined && round >= o.rounds) return;
    await new Promise((resolve) => setTimeout(resolve, o.intervalMs));
  }
}
