import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { runClient } from '../src/client.js';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { type Participant, Store } from '../src/store.js';

let baseUrl: string;
let store: Store;
let closeServer: () => Promise<void>;
let ana: Participant;
let anaClaude: Participant;
const tokens = {} as Record<'ana' | 'ana-claude', string>;
const dir = mkdtempSync(join(tmpdir(), 'orco-client-'));

before(async () => {
  store = new Store(openDatabase(':memory:'));
  ({ participant: ana, token: tokens.ana } = store.createUser('ana'));
  ({ participant: anaClaude, token: tokens['ana-claude'] } = store.createAgent('ana', 'ana-claude'));
  store.createProject(ana, 'api');
  const { app, close } = createApp(store);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = async () => {
    await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
});

after(async () => {
  await closeServer();
});

/** Runs a client command as `who` and returns its exit code and output. */
async function orco(who: 'ana' | 'ana-claude' | null, args: string[], stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const env = who ? { ORCO_URL: baseUrl, ORCO_TOKEN: tokens[who], ORCO_CLIENT_CONFIG: join(dir, 'none.json') } : { ORCO_CLIENT_CONFIG: join(dir, 'client.json') };
  const code = await runClient(args, { env, out: (t) => out.push(t), err: (t) => err.push(t), stdin: async () => stdin });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('orco client', () => {
  it('signs in once and keeps the token in a private file', async () => {
    const login = await orco(null, ['login', `${baseUrl}/`], `${tokens.ana}\n`);
    assert.equal(login.code, 0, login.err);
    assert.match(login.out, /Signed in to .* as user ana/);
    const saved = JSON.parse(readFileSync(join(dir, 'client.json'), 'utf8'));
    assert.deepEqual(saved, { server: baseUrl, token: tokens.ana });
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'client.json')).mode & 0o777, 0o600);
    assert.match((await orco(null, ['whoami'])).out, /^ana \(user\)/);
    assert.equal((await orco(null, ['logout'])).code, 0);
    const out = await orco(null, ['whoami']);
    assert.equal(out.code, 1);
    assert.match(out.err, /Not signed in/);
    const bad = await orco(null, ['login', baseUrl, '--token', 'orco_u_wrong']);
    assert.match(bad.err, /token was refused/);
  });

  it('posts (with files and stdin), reads and searches', async () => {
    const file = join(dir, 'run.log');
    writeFileSync(file, 'FAIL api.test.ts\n');
    const posted = await orco('ana-claude', ['post', 'api/general', 'Nightly', 'run', 'failed', '--file', file]);
    assert.equal(posted.code, 0, posted.err);
    assert.equal((await orco('ana', ['post', 'api/general', '-'], 'from a pipe\n')).code, 0);
    const read = await orco('ana', ['read', 'api/general']);
    assert.match(read.out, /ana-claude \(agent of ana\) in #api\/general\n {2}Nightly run failed\n {2}\[file \d+: run\.log, 17 bytes\]/);
    assert.match(read.out, /from a pipe/);
    const json = JSON.parse((await orco('ana', ['read', 'api/general', '--json'])).out);
    assert.equal(json.length, 2);
    assert.match((await orco('ana', ['search', 'nightly'])).out, /^message +ana-claude in #api\/general .*\n {2}Nightly run failed/m);
  });

  it('runs the task loop: create with a budget, accept, progress, finish with a link', async () => {
    const created = await orco('ana', ['task', 'new', '@ana-claude', 'api/general', 'Fix', 'the', 'flaky', 'test', '--minutes', '30', '--cost', '$2.50']);
    assert.equal(created.code, 0, created.err);
    const id = /#(\d+)/.exec(created.out)![1]!;
    assert.deepEqual(store.tasks.get(ana, Number(id)).budget?.cents, 250);
    assert.match((await orco('ana-claude', ['tasks'])).out, new RegExp(`#${id} requested`));
    await orco('ana-claude', ['task', 'accept', id]);
    await orco('ana-claude', ['task', 'progress', id, 'Found it', '--percent', '60']);
    await orco('ana-claude', ['task', 'checkpoint', id, 'Retry added; next: CI run']);
    const done = await orco('ana-claude', ['task', 'done', id, 'Added a retry', '--link', 'https://git.example/pr/3']);
    assert.match(done.out, new RegExp(`Task #${id} is done`));
    const shown = await orco('ana', ['task', id]);
    assert.match(shown.out, /done .*ana → ana-claude/);
    assert.match(shown.out, /link: https:\/\/git\.example\/pr\/3/);
    assert.equal((await orco('ana-claude', ['task', 'done', id])).code, 1, 'a closed task cannot finish twice');
  });

  it('answers questions and shows the inbox and catch-up', async () => {
    const task = store.tasks.create(ana, { agent: 'ana-claude', room: 'api/general', request: 'Rotate the keys' });
    store.tasks.update(anaClaude, task.id, 'accepted');
    const q = store.questions.ask(anaClaude, task.id, 'Staging or prod first?');
    assert.match((await orco('ana', ['inbox'])).out, new RegExp(`question ${q.id} from ana-claude on task #${task.id}: Staging or prod first\\?`));
    assert.match((await orco('ana', ['answer', String(q.id), 'Staging'])).out, /Answered question/);
    assert.equal(store.questions.get(ana, q.id).answer, 'Staging');
    const caught = await orco('ana-claude', ['catch-up']);
    assert.match(caught.out, /#api\/general/);
    assert.equal((await orco('ana-claude', ['catch-up'])).out, 'Nothing new.');
  });

  it('files, moves, comments on and claims tickets', async () => {
    const filed = await orco('ana', ['ticket', 'new', 'api', 'Speed', 'up', 'CI', '--priority', 'high', '--description', 'Cache node_modules']);
    const ref = /Filed (\S+):/.exec(filed.out)![1]!;
    assert.match((await orco('ana-claude', ['ticket', 'claim', ref])).out, /is yours \(In Progress\)/);
    assert.match((await orco('ana-claude', ['ticket', 'move', ref, 'In', 'Review'])).out, /is In Review/);
    await orco('ana-claude', ['ticket', 'comment', ref, 'Cache hit rate is 90%']);
    const detail = await orco('ana', ['ticket', ref]);
    assert.match(detail.out, /In Review +Speed up CI +high @ana-claude/);
    assert.match(detail.out, /Cache node_modules/);
    assert.match(detail.out, /ana-claude .*: Cache hit rate is 90%/);
    assert.match((await orco('ana', ['tickets', 'api', '--assignee', 'ana-claude'])).out, new RegExp(ref));
  });

  it('waits for a mention, and gives up with exit 2', async () => {
    const waiting = orco('ana-claude', ['wait', '--timeout', '10']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    store.post(ana, 'api/general', '@ana-claude are you there?');
    const got = await waiting;
    assert.equal(got.code, 0);
    assert.match(got.out, /are you there\?/);
    const timedOut = await orco('ana-claude', ['wait', '--timeout', '1']);
    assert.equal(timedOut.code, 2);
  });

  it('reaches any endpoint with api', async () => {
    const me = JSON.parse((await orco('ana', ['api', 'GET', '/me'])).out);
    assert.equal(me.name, 'ana');
    const posted = JSON.parse((await orco('ana', ['api', 'POST', '/messages', '-'], JSON.stringify({ room: 'lobby', text: 'via api' }))).out);
    assert.equal(posted.text, 'via api');
    assert.match((await orco('ana', ['api', 'GET', '/nope'])).err, /./);
  });

  it('works as the real orco command', async () => {
    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', 'whoami'], {
      env: { ...process.env, ORCO_URL: baseUrl, ORCO_TOKEN: tokens['ana-claude'], ORCO_CLIENT_CONFIG: join(dir, 'none.json') },
    });
    assert.match(stdout, /^ana-claude \(agent, owned by ana\)/);
  });
});
