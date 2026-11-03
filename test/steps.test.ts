import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';
import type { Task } from '../src/tasks.js';

let store: Store;
let carlos: Participant;
let bot: Participant;
let botToken: string;
let base: string;
let stop: () => Promise<void>;

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as OrcoError).code;
  }
  return 'ok';
};

before(async () => {
  store = new Store(openDatabase(':memory:'));
  carlos = store.createUser('carlos').participant;
  const made = store.createAgent('carlos', 'carlos-claude');
  bot = made.participant;
  botToken = made.token;
  store.createProject(carlos, 'web');
  const { app, close } = createApp(store);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stop = async () => {
    await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
});

after(async () => {
  await stop();
});

const steps = (states: string[]) => ['Read the failing test', 'Fix the race', 'Run the suite', 'Open a PR'].map((text, i) => ({ text, state: states[i] as 'pending' }));

describe('a live checklist for agent work (#94)', () => {
  it('keeps the steps on the task, says which one is on, and ticks the ticket card', () => {
    const { ticket } = store.tickets.create(carlos, 'web', { title: 'Flaky checkout test', assignee: 'carlos-claude' });
    const task = store.tickets.taskFor(bot, ticket.ref);
    store.tasks.update(bot, task.id, 'accepted');
    const seen: Task[] = [];
    store.events.on('task', (t: Task) => seen.push(t));
    const reported = store.tasks.reportProgress(bot, task.id, '', null, {}, steps(['done', 'in_progress', 'pending', 'pending']));
    assert.deepEqual(reported.steps.map((s) => s.state), ['done', 'in_progress', 'pending', 'pending']);
    assert.equal(reported.progress?.text, 'step 2/4: Fix the race', 'the step in progress is the progress line');
    assert.equal(seen.at(-1)?.steps.length, 4, 'the event carries the checklist, so cards tick live');
    assert.deepEqual(store.tickets.get(carlos, ticket.ref).task?.steps, { done: 1, total: 4 });

    assert.equal(code(() => store.tasks.reportProgress(bot, task.id, '', null, {}, [{ text: 'x', state: 'started' as 'pending' }])), 'invalid');
    assert.equal(code(() => store.tasks.reportProgress(bot, task.id, '', null, {}, Array.from({ length: 21 }, () => ({ text: 'x', state: 'pending' as const })))), 'invalid');
    assert.equal(code(() => store.tasks.reportProgress(carlos, task.id, 'me too', null, {}, steps(['done']))), 'forbidden');

    const done = store.tasks.update(bot, task.id, 'done', 'Fixed: the iframe loads after the assertion', { steps: steps(['done', 'done', 'done', 'done']) });
    assert.ok(done.steps.every((s) => s.state === 'done'));
    assert.deepEqual(store.tickets.get(carlos, ticket.ref).task?.steps, { done: 4, total: 4 });
  });

  it('takes steps over MCP, with the text left out', async () => {
    const task = store.tasks.create(carlos, { agent: 'carlos-claude', room: 'web/general', request: 'Bump the SDK' });
    store.tasks.update(bot, task.id, 'accepted');
    const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${botToken}` } } }));
    const result = await client.callTool({ name: 'report_progress', arguments: { task_id: task.id, steps: [{ text: 'Bump the version', state: 'done' }, { text: 'Fix the types', state: 'in_progress' }] } });
    const text = (result.content as { text: string }[])[0]!.text;
    assert.equal(result.isError ?? false, false, text);
    assert.match(text, /step 2\/2: Fix the types/);
    const got = await client.callTool({ name: 'get_task', arguments: { task_id: task.id } });
    assert.equal(JSON.parse((got.content as { text: string }[])[0]!.text).task.steps.length, 2);
    await client.close();
  });
});
