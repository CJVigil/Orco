import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { type Participant, Store } from '../src/store.js';
import { type ForgeKind, ForgeSync, loadForgeSyncConfig } from '../src/sync/forge.js';

interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  html_url: string;
  updated_at: string;
  labels: { name: string }[];
}
interface Comment {
  id: number;
  issue_url: string;
  body: string;
  user: { login: string };
  updated_at: string;
}

async function listen(app: express.Express, closers: (() => Promise<void>)[]) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** An in-memory forge speaking the slice of the Gitea or GitHub issues API the sync uses. */
function fakeForge(kind: ForgeKind, issues: Issue[], comments: Comment[], tick: () => string, apiBase: () => string) {
  const app = express();
  app.use(express.json());
  const prefix = kind === 'gitea' ? '/api/v1' : '';
  const pageOf = <T>(items: T[], query: Record<string, unknown>) => {
    const size = Number(query[kind === 'gitea' ? 'limit' : 'per_page'] ?? 30);
    const page = Number(query.page ?? 1);
    return items.slice((page - 1) * size, page * size);
  };
  app.use((req, res, next) => {
    const ok =
      kind === 'gitea'
        ? req.headers.authorization === 'token forge-secret'
        : req.headers.authorization === 'Bearer forge-secret' && req.headers['user-agent'] === 'orco-sync' && req.headers.accept === 'application/vnd.github+json';
    if (ok) next();
    else res.status(401).json({ message: 'Bad credentials' });
  });
  app.get(`${prefix}/repos/home/api/issues`, (req, res) => {
    const since = String(req.query.since ?? '');
    res.json(pageOf(issues.filter((i) => !since || i.updated_at >= since), req.query));
  });
  app.get(`${prefix}/repos/home/api/issues/comments`, (req, res) => {
    const since = String(req.query.since ?? '');
    res.json(pageOf(comments.filter((c) => !since || c.updated_at >= since), req.query));
  });
  app.post(`${prefix}/repos/home/api/issues/:n/comments`, (req, res) => {
    const comment = { id: 1000 + comments.length, issue_url: `${apiBase()}/repos/home/api/issues/${req.params.n}`, body: req.body.body, user: { login: 'orco-bot' }, updated_at: tick() };
    comments.push(comment);
    res.status(201).json(comment);
  });
  app.patch(`${prefix}/repos/home/api/issues/:n`, (req, res) => {
    const issue = issues.find((i) => i.number === Number(req.params.n))!;
    Object.assign(issue, req.body, { updated_at: tick() });
    res.json(issue);
  });
  return app;
}

for (const kind of ['gitea', 'github'] as const) {
  const name = kind === 'gitea' ? 'Gitea' : 'GitHub';

  describe(`${name} sync`, () => {
    let store: Store;
    let ana: Participant;
    let anaClaude: Participant;
    let syncToken: string;
    let orcoUrl: string;
    let forgeUrl: string;
    const issues: Issue[] = [];
    const comments: Comment[] = [];
    const closers: (() => Promise<void>)[] = [];
    let clock = Date.parse('2026-10-01T00:00:00Z');
    const tick = () => new Date((clock += 1000)).toISOString();
    const api = () => (kind === 'gitea' ? `${forgeUrl}/api/v1` : forgeUrl);

    before(async () => {
      store = new Store(openDatabase(':memory:'));
      ana = store.createUser('ana').participant;
      syncToken = store.createUser(kind).token;
      anaClaude = store.createAgent('ana', 'ana-claude').participant;
      store.createProject(ana, 'api');
      store.addMember(ana, 'api', kind);
      const { app, close } = createApp(store);
      closers.push(close);
      orcoUrl = await listen(app, closers);
      forgeUrl = await listen(fakeForge(kind, issues, comments, tick, api), closers);
    });

    after(async () => {
      for (const close of closers.reverse()) await close();
    });

    const newSync = (statePath: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'orco-forge-config-'));
      const configPath = join(dir, 'sync.json');
      const forge = kind === 'gitea' ? { gitea: { url: forgeUrl, token_env: 'FORGE_TOKEN' } } : { github: { api_url: forgeUrl, token_env: 'FORGE_TOKEN' } };
      writeFileSync(configPath, JSON.stringify({ orco: { server: orcoUrl, token_env: 'ORCO_SYNC' }, ...forge, repos: [{ repo: 'home/api', project: 'api' }], state: statePath }));
      return new ForgeSync(loadForgeSyncConfig(configPath, kind), { orco: syncToken, forge: 'forge-secret' });
    };

    const issue = (number: number, title: string, state: 'open' | 'closed' = 'open', labels: string[] = []): Issue => ({
      number,
      title,
      body: `Body of ${title}`,
      state,
      html_url: `https://forge.example/home/api/issues/${number}`,
      updated_at: tick(),
      labels: labels.map((label) => ({ name: label })),
    });

    const statePath = join(mkdtempSync(join(tmpdir(), 'orco-forge-')), 'state.json');

    it('keeps issues and tickets in step both ways, without echoes', async () => {
      const sync = newSync(statePath);
      issues.push(issue(1, 'Login fails on Safari', 'open', ['bug']), issue(2, 'Old cleanup', 'closed'));
      await sync.runOnce();
      const [first, second] = store.tickets.list(ana, { project: 'api' }).sort((a, b) => a.number - b.number);
      assert.equal(first!.title, 'Login fails on Safari');
      assert.deepEqual(first!.labels.map((l) => l.name), ['bug']);
      assert.equal(second!.status.category, 'completed');
      assert.match(store.tickets.get(ana, first!.ref).description, /Synced from \[home\/api#1\]\(https:\/\/forge\.example\/home\/api\/issues\/1\)/);

      // A forge comment reaches the ticket.
      comments.push({ id: 100, issue_url: `${api()}/repos/home/api/issues/1`, body: 'Also on iOS', user: { login: 'ben' }, updated_at: tick() });
      await sync.runOnce();
      assert.ok(store.tickets.get(ana, first!.ref).activity.some((a) => a.kind === 'comment' && a.body === `**ben** on ${name}:\n\nAlso on iOS`));

      // A person's comment and a move to Done in Orco reach the issue.
      store.tickets.comment(ana, first!.ref, 'Fixed in the auth refactor');
      store.tickets.update(ana, first!.ref, { status: 'Done' });
      await sync.runOnce();
      assert.equal(issues[0]!.state, 'closed');
      const posted = comments.filter((c) => c.issue_url.endsWith('/issues/1') && c.user.login === 'orco-bot');
      assert.equal(posted.length, 1);
      assert.match(posted[0]!.body, /\*\*ana\*\* in Orco \(API-1\):\n\nFixed in the auth refactor/);

      // Nothing echoes on further rounds.
      const before = { comments: comments.length, activity: store.tickets.get(ana, first!.ref).activity.length };
      await sync.runOnce();
      await sync.runOnce();
      assert.deepEqual({ comments: comments.length, activity: store.tickets.get(ana, first!.ref).activity.length }, before);

      // Retitling and reopening on the forge follow into Orco.
      Object.assign(issues[0]!, { title: 'Login fails on Safari and iOS', state: 'open', updated_at: tick() });
      await sync.runOnce();
      const reopened = store.tickets.get(ana, first!.ref);
      assert.equal(reopened.title, 'Login fails on Safari and iOS');
      assert.equal(reopened.status.category, 'unstarted');
      assert.equal(issues[0]!.state, 'open', 'the reopening does not bounce back as a close');

      // An agent finishing the ticket's task reports on the issue.
      store.tickets.update(ana, first!.ref, { assignee: 'ana-claude' });
      const taskId = store.tickets.get(ana, first!.ref).task!.id;
      store.tasks.update(anaClaude, taskId, 'accepted');
      store.tasks.update(anaClaude, taskId, 'done', 'Patched the cookie SameSite setting');
      await sync.runOnce();
      assert.ok(comments.some((c) => /ana-claude\*\* finished task #\d+ on API-1:\n\nPatched the cookie SameSite setting/.test(c.body)));

      // A restarted sync picks up where it left off.
      const count = comments.length;
      await newSync(statePath).runOnce();
      assert.equal(comments.length, count);
      assert.equal(store.tickets.list(ana, { project: 'api' }).length, 2);
    });

    it('reads every page of a long backlog', async () => {
      for (let n = 0; n < 120; n++) issues.push(issue(100 + n, `Backlog item ${n}`));
      for (let n = 0; n < 60; n++) comments.push({ id: 5000 + n, issue_url: `${api()}/repos/home/api/issues/150`, body: `note ${n}`, user: { login: 'ben' }, updated_at: tick() });
      await newSync(statePath).runOnce();
      const titles = store.tickets.list(ana, { project: 'api' }).map((t) => t.title);
      assert.equal(titles.length, 122);
      assert.ok(titles.includes('Backlog item 0') && titles.includes('Backlog item 119'));
      const ticket = store.tickets.list(ana, { project: 'api' }).find((t) => t.title === 'Backlog item 50')!;
      assert.equal(store.tickets.get(ana, ticket.ref).activity.filter((a) => a.kind === 'comment').length, 60);
    });

    it('reports a refused token without stopping', async () => {
      const lines: string[] = [];
      const dir = mkdtempSync(join(tmpdir(), 'orco-forge-'));
      const configPath = join(dir, 'sync.json');
      const forge = kind === 'gitea' ? { gitea: { url: forgeUrl, token_env: 'T' } } : { github: { api_url: forgeUrl, token_env: 'T' } };
      writeFileSync(configPath, JSON.stringify({ orco: { server: orcoUrl, token_env: 'O' }, ...forge, repos: [{ repo: 'home/api', project: 'api' }] }));
      await new ForgeSync(loadForgeSyncConfig(configPath, kind), { orco: syncToken, forge: 'wrong' }, (m) => lines.push(m)).runOnce();
      assert.match(lines.join('\n'), new RegExp(`${name} GET .* answered 401: Bad credentials`));
    });
  });
}

describe('forge sync config', () => {
  it('needs the forge section matching the command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orco-forge-'));
    const path = join(dir, 'sync.json');
    writeFileSync(path, JSON.stringify({ orco: { server: 'http://orco.test', token_env: 'O' }, github: { token_env: 'G' }, repos: [{ repo: 'a/b', project: 'b' }] }));
    const config = loadForgeSyncConfig(path, 'github');
    assert.equal(config.forge.api, 'https://api.github.com');
    assert.equal(config.state, join(dir, 'orco-github-state.json'));
    assert.throws(() => loadForgeSyncConfig(path, 'gitea'), /Gitea sync config is not valid:\n {2}gitea:/);
  });
});
