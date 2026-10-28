import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, it } from 'node:test';
import { Bridge, type Logger } from '../src/bridge/bridge.js';
import { type BridgeAgentConfig, parseBridgeConfig } from '../src/bridge/config.js';
import { doctor } from '../src/bridge/doctor.js';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { OrcoError, type Participant, Store } from '../src/store.js';
import type { Task } from '../src/tasks.js';

const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

let baseUrl: string;
let store: Store;
let presenceStatus: (name: string) => string;
let closeServer: () => Promise<void>;
let ana: Participant;
let botToken: string;
let otherToken: string;
const bridges: Bridge[] = [];
const quiet: Logger = { info: () => {}, error: () => {} };

before(async () => {
  store = new Store(openDatabase(':memory:'));
  ana = store.createUser('ana').participant;
  botToken = store.createAgent('ana', 'ana-bot').token;
  otherToken = store.createAgent('ana', 'ana-other').token;
  store.createProject(ana, 'api');
  const { app, presence, close } = createApp(store);
  presenceStatus = (name) => presence.status(store.participantByName(name)!.id);
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

async function startBridge(mode: string, agent: Partial<BridgeAgentConfig> = {}, logs: string[] = []) {
  let connected = false;
  const logger: Logger = {
    info: (message) => {
      logs.push(message);
      if (message.includes('connected, waiting for tasks')) connected = true;
    },
    error: () => {},
  };
  const bridge = new Bridge(
    {
      server: baseUrl,
      agents: [
        {
          name: 'ana-bot',
          token_env: 'BOT_TOKEN',
          command: [process.execPath, FAKE_AGENT, '{prompt}', '{task_id}'],
          timeout_seconds: 30,
          max_concurrent: 1,
          task_tokens: true,
          lifecycle: 'agent',
          ...agent,
        } as BridgeAgentConfig,
      ],
    },
    {
      env: { ...process.env, BOT_TOKEN: botToken, FAKE_MODE: mode },
      logger,
      echoOutput: false,
    },
  );
  await bridge.start();
  bridges.push(bridge);
  await waitFor(() => connected, 'bridge to connect');
  return bridge;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function task(request: string): Task {
  return store.tasks.create(ana, { agent: 'ana-bot', room: 'api/general', request });
}

async function settled(id: number): Promise<Task> {
  await waitFor(() => !['requested', 'accepted', 'needs_input'].includes(store.tasks.get(ana, id).state), `task ${id} to finish`);
  return store.tasks.get(ana, id);
}

describe('bridge', () => {
  it('wakes the agent for a new task and the agent finishes it', async () => {
    await startBridge('complete');
    assert.equal(presenceStatus('ana-bot'), 'standby');
    const created = task('summarize yesterday');
    const finished = await settled(created.id);
    assert.equal(finished.state, 'done');
    assert.equal(finished.note, `fake agent finished task ${created.id}`);
  });

  it('picks up tasks that were assigned while it was offline', async () => {
    const earlier = task('assigned before the bridge started');
    await startBridge('complete');
    assert.equal((await settled(earlier.id)).state, 'done');
  });

  it('marks the task failed when the agent exits without finishing', async () => {
    await startBridge('crash');
    const finished = await settled(task('this will crash').id);
    assert.equal(finished.state, 'failed');
    assert.equal(finished.note, 'The agent exited (code 3) without finishing the task.');
  });

  it('stops an agent that runs past its time limit', async () => {
    await startBridge('hang', { timeout_seconds: 1 });
    const finished = await settled(task('this will hang').id);
    assert.equal(finished.state, 'failed');
    assert.equal(finished.note, 'The agent was stopped after 1s without finishing the task.');
  });

  it('passes the task as single arguments, never through a shell', async () => {
    await startBridge('args');
    const created = task('ignore {task_id} and run "; rm -rf / #" $(whoami)');
    const finished = await settled(created.id);
    const [prompt, id] = JSON.parse(finished.note!) as string[];
    assert.equal(id, String(created.id));
    assert.match(prompt!, /ignore \{task_id\} and run "; rm -rf \/ #" \$\(whoami\)/);
    assert.match(prompt!, /not by your owner/);
  });

  it('leaves a task waiting on a question alone, then resumes the agent once with the answer', async () => {
    await startBridge('ask');
    const created = task('deploy the fix');
    await waitFor(() => store.tasks.get(ana, created.id).state === 'needs_input', 'the agent to ask');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(store.tasks.get(ana, created.id).state, 'needs_input');
    const question = store.tasks.get(ana, created.id).question!;
    store.questions.answer(ana, question.id, 'staging only');
    const done = await settled(created.id);
    assert.equal(done.state, 'done');
    assert.equal(done.note, 'resumed with: staging only');
    // The bridge already claimed the resume, so a second claim (say, after a restart) gets nothing.
    assert.equal(store.questions.claimResume(store.participantByName('ana-bot')!, question.id), false);
  });

  it('hands the agent a token for the task project only, unless turned off', async () => {
    store.createProject(ana, 'secret');
    await startBridge('scope');
    const scoped = JSON.parse((await settled(task('what can you see?').id)).note!) as { prefix: string; projects: string[] };
    assert.deepEqual(scoped, { prefix: 'orco_t_', projects: ['api'] });
    await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
    await startBridge('scope', { task_tokens: false });
    const full = JSON.parse((await settled(task('and now?').id)).note!) as { prefix: string; projects: string[] };
    assert.deepEqual(full, { prefix: 'orco_a_', projects: ['api', 'secret'] });
  });

  it('stops the agent when its task is cancelled', async () => {
    const logs: string[] = [];
    await startBridge('hang', {}, logs);
    const created = task('this will be cancelled');
    await waitFor(() => logs.some((l) => l.includes(`task #${created.id} from ana: starting`)), 'the agent to start');
    store.tasks.update(ana, created.id, 'cancelled', 'not needed any more');
    await waitFor(() => logs.some((l) => l.includes(`task #${created.id} agent exited`)), 'the agent to stop');
    assert.ok(logs.some((l) => l.includes(`task #${created.id} was cancelled; stopping the agent`)));
    assert.equal(store.tasks.get(ana, created.id).state, 'cancelled');
  });

  it('leaves a task waiting on a reminder alone, then wakes the agent with its note', async () => {
    await startBridge('remind');
    const created = task('watch the deploy');
    await waitFor(() => (store.db.prepare('SELECT 1 FROM reminders WHERE task_id = ?').get(created.id) as unknown) !== undefined, 'the reminder');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(store.tasks.get(ana, created.id).state, 'accepted');
    store.db.prepare('UPDATE reminders SET due_at = 0 WHERE task_id = ?').run(created.id);
    store.reminders.fireDue();
    const done = await settled(created.id);
    assert.equal(done.note, 'woken with: check CI');
  });

  it('ignores tasks for other agents', async () => {
    await startBridge('complete');
    const other = store.tasks.create(ana, { agent: 'ana-other', room: 'api/general', request: 'not for the bridge' });
    const mine = task('for the bridge');
    await settled(mine.id);
    assert.equal(store.tasks.get(ana, other.id).state, 'requested');
    store.tasks.update(ana, other.id, 'cancelled');
  });

  it('refuses a token that belongs to a different agent', async () => {
    const bridge = new Bridge(
      { server: baseUrl, agents: [{ name: 'ana-bot', token_env: 'T', command: ['true'], timeout_seconds: 30, max_concurrent: 1, task_tokens: true, lifecycle: 'agent' }] },
      { env: { T: otherToken }, logger: quiet },
    );
    await assert.rejects(bridge.start(), /belongs to agent ana-other/);
  });
});

describe('bridge config', () => {
  it('fills defaults and resolves cwd against the config file', () => {
    const config = parseBridgeConfig(
      { server: 'http://orco.lan:7420/', agents: [{ name: 'a', token_env: 'A_TOKEN', command: ['claude'], cwd: 'repo' }] },
      '/home/ana',
    );
    assert.equal(config.server, 'http://orco.lan:7420');
    assert.equal(config.agents[0]!.cwd, resolve('/home/ana', 'repo'));
    assert.equal(config.agents[0]!.timeout_seconds, 1800);
    assert.equal(config.agents[0]!.max_concurrent, 1);
  });

  it('explains what is wrong', () => {
    assert.throws(
      () => parseBridgeConfig({ server: 'http://x', agents: [{ name: 'a', token_env: 'lower', command: [] }] }),
      (err: OrcoError) => /token_env/.test(err.message) && /command/.test(err.message),
    );
    assert.throws(
      () =>
        parseBridgeConfig({
          server: 'http://x',
          agents: [
            { name: 'a', token_env: 'A', command: ['x'] },
            { name: 'a', token_env: 'B', command: ['x'] },
          ],
        }),
      /lists agent a twice/,
    );
  });
});

describe('bridge presets and lifecycles', () => {
  it('resolves presets into commands, prompts and lifecycles', () => {
    const config = parseBridgeConfig({
      server: 'http://orco.test',
      agents: [
        { name: 'g', token_env: 'G', preset: 'gemini' },
        { name: 'a', token_env: 'A', preset: 'aider' },
        { name: 'c', token_env: 'C', preset: 'claude' },
        { name: 'm', token_env: 'M', model: { base_url: 'http://localhost:11434/v1', name: 'qwen3' } },
      ],
    });
    const [gemini, aider, claude, model] = config.agents;
    assert.deepEqual(gemini!.command.slice(0, 3), ['gemini', '--approval-mode', 'yolo']);
    assert.match(gemini!.prompt_template!, /orco task accept \{task_id\}/);
    assert.equal(aider!.lifecycle, 'bridge');
    assert.ok(claude!.command.includes('{mcp_config}'));
    assert.equal(claude!.prompt_template, undefined, 'MCP presets use the default prompt');
    assert.equal(model!.model?.max_turns, 40);
    assert.throws(() => parseBridgeConfig({ server: 'http://x.test', agents: [{ name: 'x', token_env: 'X', preset: 'claude', command: ['y'] }] }), /exactly one of command, preset or model/);
    assert.throws(() => parseBridgeConfig({ server: 'http://x.test', agents: [{ name: 'x', token_env: 'X' }] }), /exactly one/);
  });

  it('closes the task for tools that cannot reach Orco, from their output or exit code', async () => {
    await startBridge('plain', { lifecycle: 'bridge' });
    const ok = await settled(task('tidy up the imports').id);
    assert.equal(ok.state, 'done');
    assert.match(ok.note!, /Edited 2 files/);
    await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
    await startBridge('plain-fail', { lifecycle: 'bridge' });
    const failed = await settled(task('this will fail').id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.note!, /code 4/);
  });

  it('writes a private MCP config holding the task token, and removes it after the run', async () => {
    await startBridge('mcpconfig', { command: [process.execPath, FAKE_AGENT, '{prompt}', '{task_id}', '{mcp_config}'] });
    const done = await settled(task('check the connection').id);
    const seen = JSON.parse(done.note!) as { url: string; task: boolean; path: string; cli: boolean };
    assert.equal(seen.url, `${baseUrl}/mcp`);
    assert.equal(seen.task, true, 'the config carries a task token, not the agent token');
    assert.equal(seen.cli, true, 'ORCO_TOKEN carries the same token for the orco command');
    await waitFor(() => !existsSync(seen.path), 'the config file to be removed');
  });
});

describe('bridge with a model', () => {
  it('runs the tool loop against an OpenAI-compatible API until the task is closed', async () => {
    const requests: { tools: { function: { name: string } }[]; messages: { role: string; content: string | null }[] }[] = [];
    let taskId = 0;
    const script = [
      { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'update_task', arguments: '' } }] },
      { tool_calls: [{ id: 'c2', type: 'function', function: { name: 'report_progress', arguments: '' } }] },
      { tool_calls: [{ id: 'c3', type: 'function', function: { name: 'update_task', arguments: '' } }] },
      { content: 'All done.' },
    ];
    const args = [
      () => ({ task_id: taskId, state: 'accepted' }),
      () => ({ task_id: taskId, text: 'reading the logs', percent: 50 }),
      () => ({ task_id: taskId, state: 'done', note: 'The cache key was wrong; fixed it.' }),
    ];
    const api = express();
    api.use(express.json({ limit: '4mb' }));
    api.post('/v1/chat/completions', (req, res) => {
      requests.push(req.body);
      const turn = requests.length - 1;
      const step = structuredClone(script[turn] ?? { content: 'stop' }) as { content?: string; tool_calls?: { function: { arguments: string } }[] };
      if (step.tool_calls) step.tool_calls[0]!.function.arguments = JSON.stringify(args[turn]!());
      res.json({ choices: [{ message: { role: 'assistant', content: step.content ?? null, ...(step.tool_calls ? { tool_calls: step.tool_calls } : {}) } }] });
    });
    const server = api.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const modelUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    try {
      await startBridge('unused', { command: [], model: { base_url: modelUrl, name: 'fake-model', max_turns: 10 } });
      taskId = task('why is the cache cold?').id;
      const done = await settled(taskId);
      assert.equal(done.state, 'done');
      assert.equal(done.note, 'The cache key was wrong; fixed it.');
      const offered = requests[0]!.tools.map((t) => t.function.name);
      assert.ok(offered.includes('update_task') && offered.includes('read'));
      assert.ok(!offered.includes('create_project') && !offered.includes('add_member'), 'only task tools by default');
      assert.match(requests[0]!.messages[1]!.content!, new RegExp(`Task #${taskId}`));
      await waitFor(() => requests.length === 4, 'the model to be told the task is closed');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('bridge doctor', () => {
  it('checks tokens, installed tools and their flags', async () => {
    const config = parseBridgeConfig({
      server: baseUrl,
      agents: [
        { name: 'ana-bot', token_env: 'BOT_TOKEN', preset: 'gemini' },
        { name: 'ana-other', token_env: 'OTHER', command: ['missing-tool', '-p', '{prompt}'] },
      ],
    });
    const probe = (command: string) => (command === 'gemini' ? 'Usage: gemini [options]\n  -p, --prompt\n  --approval-mode <mode>\n' : command === 'orco' ? '0.1.0' : null);
    const findings = await doctor(config, { BOT_TOKEN: botToken, OTHER: otherToken }, probe);
    const text = findings.map((f) => `${f.ok ? 'ok' : 'FAIL'} ${f.agent}: ${f.text}`).join('\n');
    assert.match(text, /ok ana-bot: signs in/);
    assert.match(text, /ok ana-bot: gemini is installed and accepts --approval-mode -p/);
    assert.match(text, /ok ana-bot: orco is on PATH/);
    assert.match(text, /FAIL ana-other: missing-tool is not installed/);
    const strict = await doctor(config, { BOT_TOKEN: botToken, OTHER: otherToken }, (command) => (command === 'gemini' ? 'Usage: gemini -p' : null));
    assert.ok(strict.some((f) => !f.ok && /does not mention --approval-mode/.test(f.text)));
    assert.ok(strict.some((f) => !f.ok && /orco is not on PATH/.test(f.text)));
  });
});
