import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { forgePoll } from '../src/forgepoll.js';
import { Store } from '../src/store.js';
import { waitFor } from '../src/waits.js';

function setup() {
  const store = new Store(openDatabase(':memory:'));
  const carlos = store.createUser('carlos').participant;
  const bot = store.createAgent('carlos', 'carlos-bot').participant;
  store.createProject(carlos, 'shop');
  const { ticket } = store.tickets.create(carlos, 'shop', { title: 'Fix the payment race' });
  const { token } = store.hooks.create(carlos, { room: 'shop/general', name: 'GitHub' });
  const deliver = (event: string, body: unknown) => store.hooks.deliver(token, Buffer.from(JSON.stringify(body)), { 'x-github-event': event });
  return { store, carlos, bot, ticket, token, deliver };
}

const repository = { full_name: 'acme/shop', default_branch: 'main' };
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('commits on tickets (#107)', () => {
  it('links a pushed commit that names the ticket, then shows its CI result and the deploy', async () => {
    const { store, carlos, bot, ticket, deliver } = setup();
    deliver('push', { ref: 'refs/heads/fix-race', repository, commits: [{ id: SHA, message: `fix(race): ${ticket.ref} wait for the iframe\n\nDetails`, author: { name: 'Carlos', username: 'carlos' }, url: `https://github.com/acme/shop/commit/${SHA}` }] });
    deliver('push', { ref: 'refs/heads/main', repository, commits: [{ id: 'f'.repeat(40), message: 'chore: names no ticket', author: { name: 'x' } }] });
    let commits = store.tickets.get(carlos, ticket.ref).commits;
    assert.equal(commits.length, 1);
    assert.equal(commits[0]!.branch, 'fix-race');
    assert.equal(commits[0]!.ci, null);
    const waiting = waitFor(store, bot, { ci: [{ sha: SHA.slice(0, 7) }] }, 2000);
    deliver('workflow_run', { action: 'completed', repository, workflow_run: { name: 'CI', head_sha: SHA, head_branch: 'fix-race', status: 'completed', conclusion: 'success' } });
    assert.deepEqual((await waiting).fired, ['CI passed for a1b2c3d']);
    commits = store.tickets.get(carlos, ticket.ref).commits;
    assert.equal(commits[0]!.ci, 'success');
    deliver('workflow_run', { action: 'completed', repository, workflow_run: { name: 'Deploy production', head_sha: SHA, head_branch: 'fix-race', status: 'completed', conclusion: 'success' } });
    assert.ok(store.tickets.get(carlos, ticket.ref).commits[0]!.deployedAt, 'deployed');
    deliver('check_run', { action: 'completed', repository, check_run: { name: 'lint', head_sha: SHA, status: 'completed', conclusion: 'failure' } });
    assert.equal(store.tickets.get(carlos, ticket.ref).commits[0]!.ci, 'failure', 'any failed check fails the commit');
  });

  it('forge-poll posts new commits and check runs to the hook, without replaying history', async () => {
    const { store, carlos, ticket, token } = setup();
    let round = 0;
    const commits = () => [
      ...(round > 0 ? [{ sha: SHA, html_url: `https://github.com/acme/shop/commit/${SHA}`, commit: { message: `${ticket.ref}: retry on timeout`, author: { name: 'Ana' } }, author: { login: 'ana' } }] : []),
      { sha: 'e'.repeat(40), commit: { message: `${ticket.ref} old work`, author: { name: 'Old' } } },
    ];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('http://orco/hooks/')) {
        const event = (init!.headers as Record<string, string>)['x-github-event']!;
        store.hooks.deliver(token, Buffer.from(String(init!.body)), { 'x-github-event': event });
        return new Response('{}', { status: 202 });
      }
      if (u.includes('/check-runs')) return Response.json({ check_runs: u.includes(SHA) ? [{ name: 'CI', status: 'completed', conclusion: 'success' }] : [] });
      const list = commits();
      round++;
      return Response.json(list);
    }) as typeof fetch;
    await forgePoll({ forge: 'github', repo: 'acme/shop', branch: 'main', hook: `http://orco/hooks/${token}`, api: 'https://api.github.test', intervalMs: 0, rounds: 2, log: () => {}, fetchFn });
    const linked = store.tickets.get(carlos, ticket.ref).commits;
    assert.deepEqual(linked.map((c) => c.sha), [SHA], 'the new commit only: the first look learns what was there');
    assert.equal(linked[0]!.author, 'ana');
    assert.equal(linked[0]!.ci, 'success');
  });
});
