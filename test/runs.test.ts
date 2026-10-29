import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, it } from 'node:test';
import { Bridge, type Logger } from '../src/bridge/bridge.js';
import { type BridgeAgentConfig, parseBridgeConfig } from '../src/bridge/config.js';
import { RunOutput, resetTimeOf } from '../src/bridge/output.js';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { maskSecrets } from '../src/mask.js';
import { capLog } from '../src/runs.js';
import { OrcoError, type Participant, Store } from '../src/store.js';
import type { Task } from '../src/tasks.js';

const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

let baseUrl: string;
let store: Store;
let closeServer: () => Promise<void>;
let ana: Participant;
let ben: Participant;
let bot: Participant;
let botToken: string;
let anaToken: string;
let benToken: string;
let clock = Date.parse('2026-10-01T12:00:00Z');
const bridges: Bridge[] = [];

before(async () => {
  store = new Store(openDatabase(':memory:'), { now: () => clock });
  const a = store.createUser('ana');
  ana = a.participant;
  anaToken = a.token;
  const b = store.createUser('ben');
  ben = b.participant;
  benToken = b.token;
  const created = store.createAgent('ana', 'ana-bot');
  bot = created.participant;
  botToken = created.token;
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

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

after(async () => {
  await closeServer();
});

const task = (request: string): Task => store.tasks.create(ana, { agent: 'ana-bot', room: 'api/general', request });

async function waitFor(check: () => boolean, what: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function http(path: string, token: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() };
}

async function startBridge(mode: string, agent: Partial<BridgeAgentConfig>, logs: string[] = []) {
  let connected = false;
  const logger: Logger = {
    info: (message) => {
      logs.push(message);
      if (message.includes('connected, waiting for tasks')) connected = true;
    },
    error: (message) => logs.push(`ERROR ${message}`),
  };
  const bridge = new Bridge(
    {
      server: baseUrl,
      agents: [
        {
          name: 'ana-bot',
          token_env: 'BOT_TOKEN',
          command: [process.execPath, FAKE_AGENT, '{prompt}'],
          timeout_seconds: 30,
          max_concurrent: 2,
          task_tokens: true,
          run_logs: true,
          lifecycle: 'agent',
          ...agent,
        } as BridgeAgentConfig,
      ],
    },
    { env: { ...process.env, BOT_TOKEN: botToken, FAKE_MODE: mode }, logger, echoOutput: false },
  );
  await bridge.start();
  bridges.push(bridge);
  await waitFor(() => connected, 'bridge to connect');
}

describe('task runs', () => {
  it('takes run reports only from the assignee, and shows them to people who can see the task', async () => {
    const t = task('index the docs');
    const input = { mode: 'start' as const, startedAt: new Date(clock).toISOString(), seconds: 42, outcome: 'code 0', inputTokens: 1000, outputTokens: 200, costMicros: 52_300, branch: 'orco/task-1', log: `hello ${anaToken}\nsk-ant-${'x'.repeat(30)}` };
    assert.throws(() => store.runs.record(ana, t.id, input), (e: OrcoError) => e.code === 'forbidden');
    const run = store.runs.record(bot, t.id, input);
    assert.equal(run.costMicros, 52_300);
    assert.equal(run.branch, 'orco/task-1');
    const { log } = store.runs.log(ana, run.id);
    assert.ok(!log.includes(anaToken) && !log.includes('sk-ant-'), 'Orco masks token shapes the bridge missed');
    assert.deepEqual(store.runs.list(ana, t.id).map((r) => r.id), [run.id]);
    assert.throws(() => store.runs.log(ben, run.id), (e: OrcoError) => e.code === 'not_found');
    assert.throws(() => store.runs.list(ben, t.id), (e: OrcoError) => e.code === 'not_found');
    // The run's cost and tokens count toward the task's spend.
    const spent = store.tasks.get(ana, t.id).budget!;
    assert.equal(spent.spentCents, 5);
    assert.equal(spent.tokens, 1200);
  });

  it('serves logs as plain text over REST and accepts large logs', async () => {
    const t = task('long job');
    const big = 'line of output\n'.repeat(40_000);
    const posted = await http(`/tasks/${t.id}/runs`, botToken, { mode: 'start', started_at: new Date(clock).toISOString(), seconds: 5, outcome: 'code 0', log: `<script>alert(1)</script>\n${big}` });
    assert.equal(posted.status, 201);
    const run = JSON.parse(posted.text) as { id: number; logBytes: number; logCut: boolean };
    assert.ok(run.logCut && run.logBytes <= 256 * 1024 + 200);
    const log = await http(`/runs/${run.id}/log`, anaToken);
    assert.equal(log.status, 200);
    assert.match(log.type, /^text\/plain/);
    assert.ok(log.text.startsWith('<script>') && log.text.includes('KB cut'));
    assert.equal((await http(`/runs/${run.id}/log`, benToken)).status, 404);
    const runs = JSON.parse((await http(`/tasks/${t.id}/runs`, anaToken)).text) as unknown[];
    assert.equal(runs.length, 1);
  });

  it('drops old logs but keeps the runs', () => {
    const t = task('old');
    const run = store.runs.record(bot, t.id, { mode: 'start', startedAt: new Date(clock).toISOString(), seconds: 1, outcome: 'code 0', log: 'old log' });
    clock += 31 * 86_400_000;
    assert.ok(store.runs.pruneLogs(30) >= 1);
    assert.equal(store.runs.log(ana, run.id).log, '');
    assert.equal(store.runs.list(ana, t.id)[0]!.logBytes, 0);
  });

  it('builds a scorecard for the agent and its owner only', () => {
    const done = task('a');
    store.tasks.update(bot, done.id, 'accepted');
    clock += 10 * 60_000;
    store.tasks.update(bot, done.id, 'done', 'ok');
    store.tasks.rate(ana, done.id, 'up');
    const failed = task('b');
    store.tasks.update(bot, failed.id, 'accepted');
    store.tasks.update(bot, failed.id, 'failed', 'no');
    store.runs.record(bot, done.id, { mode: 'start', startedAt: new Date(clock).toISOString(), seconds: 600, outcome: 'code 0', inputTokens: 10, outputTokens: 5, costMicros: 2_000_000 });
    const card = store.runs.scorecard(ana, 'ana-bot', 30);
    assert.equal(card.tasks.done, 1);
    assert.equal(card.tasks.failed, 1);
    assert.equal(card.successRate, 0.5);
    assert.equal(card.feedback.up, 1);
    assert.ok(card.costMicros >= 2_000_000 && card.costPerDoneMicros === card.costMicros);
    assert.equal(store.runs.scorecard(bot, undefined).agent, 'ana-bot');
    assert.throws(() => store.runs.scorecard(ben, 'ana-bot'), (e: OrcoError) => e.code === 'not_found');
  });

  it('limits how fast and how much one agent can store', () => {
    clock += 61_000; // past earlier tests' reports
    const t = task('chatty');
    const report = () => store.runs.record(bot, t.id, { mode: 'reminder', startedAt: new Date(clock).toISOString(), seconds: 1, outcome: 'code 0', log: 'x' });
    for (let i = 0; i < 20; i++) report();
    assert.throws(report, (e: OrcoError) => e.code === 'rate_limited');
    clock += 61_000;
    report();
    const runs = store.runs.list(ana, t.id);
    assert.equal(runs.length, 21);
    assert.equal(runs.filter((r) => r.logBytes > 0).length, 20, 'only the newest runs keep their logs');
    assert.equal(runs[0]!.logBytes, 0);
    clock += 61_000; // leave the rate window clear for the bridge tests
  });

  it('caps logs at the head and the tail', () => {
    const { text, cut } = capLog(`START\n${'x'.repeat(600_000)}\nEND`);
    assert.ok(cut && text.startsWith('START') && text.endsWith('END') && Buffer.byteLength(text) < 270_000);
    assert.equal(maskSecrets('api_key=abcdefghijklmnopqrs and myvalue123', ['myvalue123']), 'api_key=[hidden] and [hidden]');
  });
});

describe('bridge run reports', () => {
  it('records each run with usage from the tool and a readable, masked log', async () => {
    await startBridge('stream', {});
    const t = task('stream it');
    await waitFor(() => store.runs.list(ana, t.id).length === 1, 'the run report');
    const [run] = store.runs.list(ana, t.id);
    assert.equal(store.tasks.get(ana, t.id).state, 'done');
    assert.equal(run!.outcome, 'code 0');
    assert.equal(run!.costMicros, 123_400);
    assert.deepEqual([run!.inputTokens, run!.outputTokens], [1000, 40]);
    const { log } = store.runs.log(ana, run!.id);
    assert.match(log, /· session started \(fake-model\)/);
    assert.match(log, /→ mcp__orco__update_task \{"state":"accepted"\}/);
    assert.match(log, /· finished: success, 2 turns, \$0\.1234/);
    assert.ok(!log.includes('orco_t_') && log.includes('Working with [hidden]'), 'the task token is masked');
  });

  it('sends usage without the log when run_logs is off', async () => {
    await startBridge('stream', { run_logs: false });
    const t = task('no logs please');
    await waitFor(() => store.runs.list(ana, t.id).length === 1, 'the run report');
    const [run] = store.runs.list(ana, t.id);
    assert.equal(run!.logBytes, 0);
    assert.equal(run!.costMicros, 123_400);
  });

  it('tells running out of usage apart from work that mentions limits', () => {
    const work = new RunOutput();
    work.feed('stdout', '{"type":"assistant","message":{"content":[{"type":"text","text":"Adding a rate limit exceeded error to the API"}]}}\n');
    assert.equal(work.limit, null, 'what the agent writes does not count');
    const hit = new RunOutput();
    hit.feed('stdout', '{"type":"result","subtype":"error","is_error":true,"result":"Claude AI usage limit reached|1761750000"}\n');
    assert.equal(hit.limit?.resetAt, 1_761_750_000_000);
    const early = new RunOutput();
    early.feed('stderr', 'warning: rate limited, retrying\n');
    for (let i = 0; i < 20; i++) early.feed('stdout', `step ${i}\n`);
    assert.equal(early.limit, null, 'a passing warning long before the end does not count');
    const now = new Date(2026, 9, 29, 10, 0).getTime();
    assert.equal(new Date(resetTimeOf("You've hit your limit · resets 3pm", now)!).getHours(), 15);
    assert.equal(resetTimeOf('try again at 9:30 am', now)! > now, true, 'a time already past means tomorrow');
  });

  it('renders Codex events and model usage', () => {
    const output = new RunOutput();
    output.feed('stdout', '{"type":"item.completed","item":{"type":"agent_message","text":"All set"}}\n{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":10,"output_tokens":5}}\n');
    output.addUsage(10, 2, 30);
    assert.match(output.text, /assistant: All set/);
    assert.deepEqual(output.usage, { inputTokens: 60, outputTokens: 7, costMicros: 30 });
  });
});

describe('worktree per task', () => {
  let repo: string;
  let dir: string;

  before(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'orco-repo-')));
    dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'orco-wt-'))), 'trees');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git('add', 'README.md');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'init');
  });

  const branches = () => execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');

  it('runs each task in its own worktree and branch, and tidies up when the task closes', async () => {
    const logs: string[] = [];
    await startBridge('worktree', { cwd: repo, worktree: { repo, dir, branch_prefix: 'orco/', fetch: false } }, logs);
    const first = task('change something');
    await waitFor(() => store.tasks.get(ana, first.id).state === 'done', 'the first task');
    const seen = JSON.parse(store.tasks.get(ana, first.id).note!) as { cwd: string; branch: string; envBranch: string; told: boolean };
    assert.equal(realpathSync(seen.cwd), join(dir, `task-${first.id}`));
    assert.equal(seen.branch, `orco/task-${first.id}`);
    assert.equal(seen.envBranch, seen.branch);
    assert.ok(seen.told, 'the prompt says where it works');
    await waitFor(() => store.runs.list(ana, first.id)[0]?.branch === seen.branch, 'the run to carry the branch');
    // Closed with a commit: the worktree goes, the branch with the work stays.
    await waitFor(() => !existsSync(join(dir, `task-${first.id}`)), 'the worktree to be removed', 20_000);
    assert.ok(branches().includes(`orco/task-${first.id}`));
    assert.ok(!existsSync(join(repo, 'work.txt')), 'the main checkout is untouched');
    assert.equal(execFileSync('git', ['show', `orco/task-${first.id}:work.txt`], { cwd: repo, encoding: 'utf8' }), `task ${first.id}\n`);
  });

  it('drops the branch of a task that committed nothing', async () => {
    await startBridge('worktree-idle', { cwd: repo, worktree: { repo, dir, branch_prefix: 'orco/', fetch: false } });
    const idle = task('look only');
    await waitFor(() => store.tasks.get(ana, idle.id).state === 'done', 'the idle task');
    await waitFor(() => !branches().includes(`orco/task-${idle.id}`), 'the unused branch to go', 20_000);
    assert.ok(!existsSync(join(dir, `task-${idle.id}`)));
  });

  it('keeps a worktree with uncommitted changes for a person to look at', async () => {
    const logs: string[] = [];
    await startBridge('worktree-dirty', { cwd: repo, worktree: { repo, dir, branch_prefix: 'orco/', fetch: false } }, logs);
    const dirty = task('leave a mess');
    await waitFor(() => logs.some((l) => l.includes(`task #${dirty.id}: kept`)), 'the bridge to decide', 20_000);
    assert.ok(existsSync(join(dir, `task-${dirty.id}`, 'half-done.txt')));
    const records = JSON.parse(readFileSync(join(dir, '.orco-worktrees.json'), 'utf8')) as Record<string, unknown>;
    assert.ok(String(dirty.id) in records, 'still tracked, so a later sweep looks again');
  });

  it('checks the setup', () => {
    assert.throws(
      () => parseBridgeConfig({ server: 'http://x.test', agents: [{ name: 'm', token_env: 'M', model: { base_url: 'http://m.test/v1', name: 'x' }, worktree: true }] }),
      /drop worktree/,
    );
    assert.throws(() => parseBridgeConfig({ server: 'http://x.test', agents: [{ name: 'c', token_env: 'C', preset: 'claude', worktree: true }] }), /needs cwd/);
    const config = parseBridgeConfig({ server: 'http://x.test', agents: [{ name: 'c', token_env: 'C', preset: 'claude', cwd: repo, worktree: true }] });
    assert.deepEqual(config.agents[0]!.worktree, { repo, base: undefined, dir: undefined, branch_prefix: 'orco/', fetch: true });
    assert.ok(config.agents[0]!.command.includes('stream-json'));
  });
});
