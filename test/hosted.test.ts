import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { HostedRunner } from '../src/hosted-runner.js';
import { createApp } from '../src/http.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';

// No-code agents (#42): made in the browser, run by the server on a model an org admin configured.
let store: Store;
let base: string;
let closeAll: () => Promise<void>;
let runner: HostedRunner;
let modelUrl: string;
let carlos: Participant;
let ana: Participant;
const seen: { auth: string | undefined; tools: string[]; withTools: boolean }[] = [];

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as OrcoError).code;
  }
  return 'ok';
};

/** A tiny OpenAI-compatible model: accepts the task, closes it, then stops. */
function fakeModel(): Server {
  return createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: { role: string; content: string | null }[]; tools?: { function: { name: string } }[] };
      seen.push({ auth: req.headers.authorization, tools: (body.tools ?? []).map((t) => t.function.name), withTools: Boolean(body.tools) });
      res.setHeader('Content-Type', 'application/json');
      const usage = { prompt_tokens: 100, completion_tokens: 20 };
      if (!body.tools) return res.end(JSON.stringify({ choices: [{ message: { content: 'Hello from the fake model' } }], usage }));
      const taskId = Number(/Task #(\d+)/.exec(body.messages.find((m) => m.role === 'user')!.content!)![1]);
      const toolTurns = body.messages.filter((m) => m.role === 'tool').length;
      const call = (name: string, args: unknown) => ({ id: `c${toolTurns}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      const message =
        toolTurns === 0
          ? { content: null, tool_calls: [call('update_task', { task_id: taskId, state: 'accepted' })] }
          : toolTurns === 1
            ? { content: null, tool_calls: [call('update_task', { task_id: taskId, state: 'done', note: 'Answered: the API runs on port 7420.' })] }
            : { content: 'Done.' };
      res.end(JSON.stringify({ choices: [{ message }], usage }));
    });
  });
}

before(async () => {
  const model = fakeModel().listen(0, '127.0.0.1');
  await new Promise((resolve) => model.once('listening', resolve));
  modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
  store = new Store(openDatabase(':memory:'), { secretsKey: randomBytes(32) });
  carlos = store.createUser('carlos').participant;
  ana = store.createUser('ana').participant;
  store.createProject(carlos, 'api');
  store.addMember(carlos, 'api', 'ana');
  store.createProject(ana, 'ops');
  const { app, close } = createApp(store);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  runner = new HostedRunner(store, base, { info: () => {}, error: (m) => console.error(m) });
  await runner.start();
  closeAll = async () => {
    await runner.stop();
    await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
  };
});

after(async () => {
  await closeAll();
});

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(check(), `timed out waiting for ${what}`);
};

describe('hosted agents', () => {
  it('lets org admins set up a model, keeping the key encrypted and out of every listing', () => {
    assert.equal(code(() => store.hosted.saveProvider(ana, { name: 'fake', baseUrl: modelUrl, model: 'tiny' })), 'forbidden');
    const provider = store.hosted.saveProvider(carlos, { name: 'fake', baseUrl: modelUrl, model: 'tiny', apiKey: 'sk-test-0123456789abcdef', priceIn: 1, priceOut: 2, shared: true });
    assert.equal(provider.hasKey, true);
    assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM model_providers').all()).includes('sk-test'), 'stored encrypted');
    assert.ok(!JSON.stringify(store.hosted.providers(ana)).includes('sk-test'));
    store.hosted.saveProvider(carlos, { name: 'private', baseUrl: modelUrl, model: 'big' });
    assert.deepEqual(store.hosted.providers(ana).map((p) => p.name), ['fake'], 'only shared ones for people');
  });

  it('makes an agent from a template, with safe defaults, limited to its projects', () => {
    assert.equal(code(() => store.hosted.create(ana, { name: 'ana-big', provider: 'private', template: 'questions' })), 'forbidden');
    assert.equal(code(() => store.hosted.create(ana, { name: 'ana-free', provider: 'fake', template: 'questions', budgetCents: null })), 'invalid', 'the org pays: a budget is required');
    assert.equal(store.participantByName('ana-free'), null, 'nothing half made');
    store.hosted.create(ana, { name: 'ana-capped', provider: 'fake', template: 'replies' });
    assert.equal(code(() => store.controls.setBudget(ana, 'agent', 'ana-capped', null)), 'invalid', 'nor removed later');
    assert.equal(code(() => store.controls.setBudget(carlos, 'agent', 'ana-capped', 20_000)), 'ok', 'org admins may raise it');
    store.hosted.remove(ana, 'ana-capped');
    const helper = store.hosted.create(ana, { name: 'ana-helper', provider: 'fake', template: 'questions', projects: ['api'], instructions: 'Be brief.' });
    assert.deepEqual(helper.projects, ['api']);
    const agent = store.participantByName('ana-helper')!;
    assert.equal(store.taskPolicyFor(agent), 'ask', 'tasks from others ask ana first');
    assert.equal(store.controls.budgets(ana).find((b) => b.target === 'ana-helper')?.monthlyCents, 500, 'a low budget');
    assert.equal(store.canSee(agent, store.visibleProject(ana, 'ops').id), false, 'not in ops, though ana is');
    assert.deepEqual(store.listProjects(agent).map((p) => p.name), ['api']);
    assert.equal(code(() => store.adminProject(agent, 'api')), 'forbidden', 'never administers anything');
  });

  it('runs on the server: takes a task, works it with Orco tools only, and closes it', async () => {
    await until(() => runner.running.includes('ana-helper'), 'the runner to start ana-helper');
    const task = store.tasks.create(ana, { agent: 'ana-helper', room: 'api/general', request: 'Which port does the API use?' });
    await until(() => store.tasks.get(ana, task.id).state === 'done', 'the task to be done');
    assert.equal(store.tasks.get(ana, task.id).note, 'Answered: the API runs on port 7420.');
    const call = seen.find((s) => s.withTools)!;
    assert.equal(call.auth, 'Bearer sk-test-0123456789abcdef', 'the key goes to the model, and only there');
    assert.ok(call.tools.includes('update_task') && !call.tools.includes('write_project_file') && !call.tools.includes('acquire_lock'), call.tools.join(','));
    await until(() => store.db.prepare('SELECT count(*) AS n FROM task_runs WHERE task_id = ?').get(task.id) !== undefined && (store.db.prepare('SELECT count(*) AS n FROM task_runs WHERE task_id = ?').get(task.id) as { n: number }).n > 0, 'the run report');
    assert.ok(store.tasks.get(ana, task.id).budget!.spentCents >= 0);
  });

  it('answers a quick test message from its owner', async () => {
    assert.deepEqual(await store.hosted.tryIt(ana, 'ana-helper', 'hi'), { reply: 'Hello from the fake model' });
    await assert.rejects(store.hosted.tryIt(carlos.id === ana.id ? carlos : store.createUser('stranger').participant, 'ana-helper', 'hi'), /No agent/);
  });

  it('stops running it here when removed, keeping the agent', async () => {
    store.hosted.remove(ana, 'ana-helper');
    await until(() => !runner.running.includes('ana-helper'), 'the runner to stop it');
    assert.ok(store.participantByName('ana-helper'), 'the agent and its history stay');
    assert.equal(code(() => store.hosted.removeProvider(carlos, 'fake')), 'ok', 'nothing runs on it now');
  });
});
