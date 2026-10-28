import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { type Participant, Store } from '../src/store.js';
import { GiteaSync, type GiteaSyncConfig } from '../src/sync/gitea.js';

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

let store: Store;
let ana: Participant;
let anaClaude: Participant;
let syncToken: string;
let orcoUrl: string;
let giteaUrl: string;
const issues: Issue[] = [];
const comments: Comment[] = [];
const closers: (() => Promise<void>)[] = [];
let clock = Date.parse('2026-10-01T00:00:00Z');
const tick = () => new Date((clock += 1000)).toISOString();

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  store = new Store(openDatabase(':memory:'));
  ana = store.createUser('ana').participant;
  const sync = store.createUser('gitea');
  syncToken = sync.token;
  anaClaude = store.createAgent('ana', 'ana-claude').participant;
  store.createProject(ana, 'api');
  store.addMember(ana, 'api', 'gitea');
  const { app, close } = createApp(store);
  closers.push(close);
  orcoUrl = await listen(app);

  const gitea = express();
  gitea.use(express.json());
  gitea.use((req, res, next) => (req.headers.authorization === 'token gitea-secret' ? next() : res.status(401).json({ message: 'bad token' })));
  gitea.get('/api/v1/repos/home/api/issues', (req, res) => {
    const since = String(req.query.since ?? '');
    const page = Number(req.query.page ?? 1);
    const found = issues.filter((i) => !since || i.updated_at >= since);
    res.json(page === 1 ? found : []);
  });
  gitea.get('/api/v1/repos/home/api/issues/comments', (req, res) => {
    const since = String(req.query.since ?? '');
    res.json(comments.filter((c) => !since || c.updated_at >= since));
  });
  gitea.post('/api/v1/repos/home/api/issues/:n/comments', (req, res) => {
    const comment = { id: comments.length + 1, issue_url: `${giteaUrl}/api/v1/repos/home/api/issues/${req.params.n}`, body: req.body.body, user: { login: 'orco-bot' }, updated_at: tick() };
    comments.push(comment);
    res.status(201).json(comment);
  });
  gitea.patch('/api/v1/repos/home/api/issues/:n', (req, res) => {
    const issue = issues.find((i) => i.number === Number(req.params.n))!;
    Object.assign(issue, req.body, { updated_at: tick() });
    res.json(issue);
  });
  giteaUrl = await listen(gitea);
});

after(async () => {
  for (const close of closers.reverse()) await close();
});

function newSync(statePath: string) {
  const config: GiteaSyncConfig = {
    orco: { server: orcoUrl, token_env: 'X' },
    gitea: { url: giteaUrl, token_env: 'Y' },
    repos: [{ repo: 'home/api', project: 'api', labels: true }],
    poll_seconds: 60,
    state: statePath,
  };
  return new GiteaSync(config, { orco: syncToken, gitea: 'gitea-secret' });
}

const issue = (number: number, title: string, state: 'open' | 'closed' = 'open', labels: string[] = []): Issue => ({
  number,
  title,
  body: `Body of ${title}`,
  state,
  html_url: `https://git.home.lan/home/api/issues/${number}`,
  updated_at: tick(),
  labels: labels.map((name) => ({ name })),
});

describe('Gitea sync', () => {
  it('keeps issues and tickets in step both ways, without echoes', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'orco-gitea-')), 'state.json');
    const sync = newSync(statePath);
    issues.push(issue(1, 'Login fails on Safari', 'open', ['bug']), issue(2, 'Old cleanup', 'closed'));
    await sync.runOnce();
    const [first, second] = store.tickets.list(ana, { project: 'api' }).sort((a, b) => a.number - b.number);
    assert.equal(first!.title, 'Login fails on Safari');
    assert.deepEqual(first!.labels.map((l) => l.name), ['bug']);
    assert.equal(second!.status.category, 'completed');
    assert.match(store.tickets.get(ana, first!.ref).description, /Synced from \[home\/api#1\]\(https:\/\/git\.home\.lan\/home\/api\/issues\/1\)/);

    // A Gitea comment reaches the ticket.
    comments.push({ id: 100, issue_url: `${giteaUrl}/api/v1/repos/home/api/issues/1`, body: 'Also on iOS', user: { login: 'ben' }, updated_at: tick() });
    await sync.runOnce();
    assert.ok(store.tickets.get(ana, first!.ref).activity.some((a) => a.kind === 'comment' && a.body === '**ben** on Gitea:\n\nAlso on iOS'));

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

    // Retitling and reopening in Gitea follow into Orco.
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
});
