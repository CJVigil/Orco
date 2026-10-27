import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, it } from 'node:test';
import { Bridge, type Logger } from '../src/bridge/bridge.js';
import { type BridgeAgentConfig, parseBridgeConfig } from '../src/bridge/config.js';
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

async function startBridge(mode: string, agent: Partial<BridgeAgentConfig> = {}) {
  let connected = false;
  const logger: Logger = {
    info: (message) => {
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
          ...agent,
        },
      ],
    },
    {
      env: { ...process.env, BOT_TOKEN: botToken, FAKE_TOKEN: botToken, FAKE_MODE: mode },
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
      { server: baseUrl, agents: [{ name: 'ana-bot', token_env: 'T', command: ['true'], timeout_seconds: 30, max_concurrent: 1 }] },
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
