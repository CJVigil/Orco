import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';

let store: Store;
let ana: Participant;
let bea: Participant;
let clock: number;
let modelUrl: string;
let model: Server;

const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (err) {
    return (err as OrcoError).code;
  }
  return 'ok';
};

before(async () => {
  // A model API that leaves out usage, and answers 401 with the key echoed back.
  model = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/denied')) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: 'bad key sk-live-0123456789abcdef at internal-gw.corp:8443' } }));
    }
    res.end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(400) } }] }));
  });
  model.listen(0, '127.0.0.1');
  await new Promise((resolve) => model.once('listening', resolve));
  modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
});

after(async () => {
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
});

beforeEach(() => {
  clock = Date.parse('2026-10-31T12:00:00Z');
  store = new Store(openDatabase(':memory:'), { now: () => clock, secretsKey: randomBytes(32) });
  ana = store.createUser('ana').participant; // the first person is an org admin
  bea = store.createUser('bea').participant;
  store.createAgent('ana', 'ana-claude');
  store.createProject(ana, 'api');
  store.addMember(ana, 'api', 'bea');
});

describe('spend ledger', () => {
  it('books spend to the month it happened in, not the month its task was made (#50)', () => {
    const agent = store.participantByName('ana-claude')!;
    const project = store.db.prepare("SELECT id FROM projects WHERE name = 'api'").get() as { id: number };
    const task = store.tasks.create(ana, { agent: 'ana-claude', room: 'api/general', request: 'long job' });
    store.tasks.addUsage(task.id, 100, 0);
    clock = Date.parse('2026-11-01T09:00:00Z');
    store.tasks.addUsage(task.id, 300, 0);
    assert.equal(store.controls.spentThisMonth('agent', agent.id), 300);
    assert.equal(store.controls.spentThisMonth('project', project.id), 300);
    // An agent's own total only adds what it raises the spend by.
    store.tasks.update(agent, task.id, 'accepted');
    store.tasks.reportProgress(agent, task.id, 'half way', 50, { costCents: 1000 });
    assert.equal(store.controls.spentThisMonth('agent', agent.id), 900);
  });

  it('caps a member by what their agents spent, so lowering or removing frees nothing (#49)', () => {
    store.hosted.saveProvider(ana, { name: 'org', baseUrl: `${modelUrl}/v1`, model: 'm', shared: true });
    store.hosted.create(bea, { name: 'bea-one', provider: 'org', template: 'replies', budgetCents: 4800 });
    const one = store.participantByName('bea-one')!;
    store.controls.recordSpend(one.id, 4800);
    assert.equal(store.controls.setBudget(bea, 'agent', 'bea-one', 100)?.monthlyCents, 100, 'lowering is allowed');
    assert.throws(() => store.hosted.create(bea, { name: 'bea-two', provider: 'org', template: 'replies', budgetCents: 500 }), /at most \$50/, 'but frees nothing');
    store.hosted.remove(bea, 'bea-one');
    assert.throws(() => store.hosted.create(bea, { name: 'bea-two', provider: 'org', template: 'replies', budgetCents: 500 }), /at most \$50/, 'removing frees nothing');
    store.hosted.create(bea, { name: 'bea-two', provider: 'org', template: 'replies', budgetCents: 200 });
    const two = store.participantByName('bea-two')!;
    store.controls.recordSpend(two.id, 150);
    assert.equal(store.hosted.budgetLeft(two.id), 50);
    clock = Date.parse('2026-11-01T00:00:01Z');
    assert.equal(store.hosted.budgetLeft(two.id), 200, 'a new month starts fresh');
    store.hosted.create(ana, { name: 'ana-big', provider: 'org', template: 'replies', budgetCents: 20_000 });
    assert.equal(store.hosted.budgetLeft(store.participantByName('ana-big')!.id), 20_000, 'org admins are not capped');
  });

  it('charges a model that reports no usage, and never shows its error text (#52)', async () => {
    store.hosted.saveProvider(ana, { name: 'paid', baseUrl: `${modelUrl}/v1`, model: 'm', apiKey: 'sk-live-0123456789abcdef', priceIn: 10, priceOut: 30, shared: true });
    store.hosted.saveProvider(ana, { name: 'denied', baseUrl: `${modelUrl}/denied/v1`, model: 'm', apiKey: 'sk-live-0123456789abcdef', priceIn: 10, priceOut: 30, shared: true });
    store.hosted.create(bea, { name: 'bea-try', provider: 'paid', template: 'replies' });
    await store.hosted.tryIt(bea, 'bea-try', 'hello');
    assert.ok(store.controls.spentThisMonth('agent', store.participantByName('bea-try')!.id) > 0, 'an estimate, not free');
    store.hosted.update(bea, 'bea-try', { provider: 'denied' });
    await assert.rejects(store.hosted.tryIt(bea, 'bea-try', 'hello'), (err: OrcoError) => /refused its API key/.test(err.message) && !/sk-live|internal-gw/.test(err.message));
  });
});

describe('tickets without tasks', () => {
  it('starts an accepted task for a question on a ticket filed with create_tickets (#53)', async () => {
    const agent = store.participantByName('ana-claude')!;
    const { ticket } = store.tickets.create(agent, 'api', { title: 'Pick a cache', assignee: 'ana-claude' }, { dispatch: false });
    assert.equal(store.tickets.get(ana, ticket.ref).task, null);
    const task = store.tickets.taskFor(agent, ticket.ref);
    assert.equal(task.state, 'accepted');
    assert.equal(task.requester, 'ana', 'on its owner’s behalf');
    const q = store.questions.ask(agent, task.id, 'Redis or in-process?');
    assert.equal(q.target, 'ana');
    assert.equal(store.tickets.taskFor(agent, ticket.ref).id, task.id, 'the same task after');
    const other = store.createAgent('bea', 'bea-codex').participant;
    assert.equal(await code(() => store.tickets.taskFor(other, ticket.ref)), 'forbidden', 'only its assignee');
  });

  it('says a handoff note changed instead of null → null (#54)', () => {
    const { ticket } = store.tickets.create(ana, 'api', { title: 'Handoff' });
    store.tickets.update(ana, ticket.ref, { handoff: 'Next: run the migration' });
    store.tickets.update(ana, ticket.ref, { handoff: '' });
    const changes = store.tickets
      .get(ana, ticket.ref)
      .activity.filter((a) => a.kind === 'change')
      .flatMap((a) => (a.detail as { changes: { field: string; from: unknown; to: unknown }[] }).changes)
      .filter((c) => c.field === 'handoff');
    assert.deepEqual(changes.map((c) => [c.from, c.to]), [
      [null, '(updated: see handoff)'],
      ['(earlier note)', '(cleared)'],
    ]);
  });
});
