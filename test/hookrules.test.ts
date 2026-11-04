import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { checkRules, failingRule, parseRuleLine, valuesAt } from '../src/hookrules.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';

describe('webhook filters (#132)', () => {
  const body = { action: 'completed', workflow_run: { conclusion: 'failure', head_branch: 'main', head_sha: 'abc' }, pull_request: { labels: [{ name: 'bug' }, { name: 'ci' }] } };
  const headers = { 'x-github-event': 'workflow_run' };

  it('reads paths, with [] over arrays', () => {
    assert.deepEqual(valuesAt('body.pull_request.labels[].name', headers, body), ['bug', 'ci']);
    assert.deepEqual(valuesAt('header.x-github-event', headers, body), ['workflow_run']);
    assert.deepEqual(valuesAt('body.nope.deeper', headers, body), []);
  });

  it('checks equals, not equals, one of, starts with and exists', () => {
    const rules = checkRules([
      { path: 'header.X-GitHub-Event', op: 'equals', value: 'workflow_run' },
      { path: 'body.workflow_run.conclusion', op: 'equals', value: 'failure' },
      { path: 'body.workflow_run.head_branch', op: 'one_of', value: 'dev, main' },
      { path: 'body.pull_request.labels[].name', op: 'not_equals', value: 'wip' },
      { path: 'body.action', op: 'starts_with', value: 'comp' },
      { path: 'body.workflow_run.head_sha', op: 'exists' },
    ]);
    assert.equal(failingRule(rules, headers, body), null);
    const passing = { ...body, workflow_run: { ...body.workflow_run, conclusion: 'success' } };
    assert.equal(failingRule(rules, headers, passing)?.path, 'body.workflow_run.conclusion');
    assert.deepEqual(parseRuleLine('body.workflow_run.head_branch is one of dev, main'.replace('is one of', 'one_of')), { path: 'body.workflow_run.head_branch', op: 'one_of', value: ['dev', 'main'] });
    assert.throws(() => checkRules([{ path: 'body.x', op: 'matches', value: '.*' }]));
    assert.throws(() => checkRules([{ path: 'process.env', op: 'exists' }]));
  });
});

describe('webhook deliveries (#132)', () => {
  let store: Store;
  let clock: number;
  let ana: Participant;
  beforeEach(() => {
    clock = Date.parse('2026-11-04T12:00:00Z');
    store = new Store(openDatabase(':memory:'), { now: () => clock });
    ana = store.createUser('ana').participant;
    store.createAgent('ana', 'ana-claude');
    store.createProject(ana, 'api');
  });

  const run = (conclusion: string, status: string, delivery: string) =>
    Buffer.from(JSON.stringify({ action: status, workflow_run: { name: 'CI', status, conclusion, head_branch: 'main', head_sha: 'abc123' }, repository: { full_name: 'o/api', default_branch: 'main' } }));
  const gh = (delivery: string) => ({ 'x-github-event': 'workflow_run', 'x-github-delivery': delivery });

  it('a passing run posts and starts nothing; a failing burst starts one task; every delivery is logged', () => {
    const { hook, token } = store.hooks.create(ana, {
      room: 'api/general',
      name: 'CI',
      wakeAgent: 'ana-claude',
      confirmTasks: false,
      filters: [{ path: 'body.workflow_run.conclusion', op: 'equals', value: 'failure' }],
      postOnlyMatching: true,
    });
    const passed = store.hooks.deliver(token, run('success', 'completed', 'd1'), gh('d1'))!;
    assert.deepEqual([passed.outcome, passed.messageId, passed.taskId], ['filtered', null, null]);
    const first = store.hooks.deliver(token, run('failure', 'completed', 'd2'), gh('d2'))!;
    assert.equal(first.outcome, 'task_started');
    clock += 30_000;
    const second = store.hooks.deliver(token, run('failure', 'completed', 'd3'), gh('d3'))!;
    clock += 30_000;
    const third = store.hooks.deliver(token, run('failure', 'completed', 'd4'), gh('d4'))!;
    assert.deepEqual([second.outcome, third.outcome], ['coalesced', 'coalesced']);
    assert.equal(second.taskId, first.taskId);
    const again = store.hooks.deliver(token, run('failure', 'completed', 'd2'), gh('d2'))!;
    assert.equal(again.outcome, 'duplicate');
    const log = store.hooks.deliveriesOf(ana, hook.id);
    assert.deepEqual(log.map((d) => d.outcome), ['duplicate', 'coalesced', 'coalesced', 'task_started', 'filtered']);
    assert.match(log.at(-1)!.detail!, /conclusion equals failure/);
    assert.equal(store.tasks.list(ana, {}).filter((t) => t.assignee === 'ana-claude').length, 1);
    // After the window, a new failure is its own task.
    clock += 10 * 60_000;
    assert.equal(store.hooks.deliver(token, run('failure', 'completed', 'd5'), gh('d5'))!.outcome, 'task_started');
  });

  it('only people who manage the hook change its settings', () => {
    const { hook } = store.hooks.create(ana, { room: 'api/general', name: 'CI' });
    const agent = store.participantByName('ana-claude')!;
    assert.throws(() => store.hooks.update(agent, hook.id, { postOnlyMatching: true }), (e: OrcoError) => e.code === 'forbidden');
    assert.throws(() => store.hooks.update(ana, hook.id, { coalesceSeconds: 5 }), (e: OrcoError) => e.code === 'invalid');
    assert.equal(store.hooks.update(ana, hook.id, { coalesceSeconds: 300, dedupeHeader: 'X-Request-Id' }).dedupeHeader, 'x-request-id');
  });
});
