import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { importTickets, parseCsv, parseImport } from '../src/import.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';

let store: Store;
let ana: Participant;
let anaClaude: Participant;

beforeEach(() => {
  store = new Store(openDatabase(':memory:'), { limits: { agentPostsPerMinute: 30 } });
  ana = store.createUser('ana').participant;
  anaClaude = store.createAgent('ana', 'ana-claude').participant;
  store.createProject(ana, 'api');
});

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Item ${i + 1}` }));

describe('ticket import', () => {
  it('files many tickets for a person without the agent rate limit', () => {
    const result = importTickets(store, ana, 'api', rows(45));
    assert.equal(result.created.length, 45);
    assert.equal(result.created[44]!.ref, 'API-45');
  });

  it('lets agents file up to 50 at once, counted once against their rate limit', () => {
    assert.throws(() => importTickets(store, anaClaude, 'api', rows(51)), (e: OrcoError) => e.code === 'invalid');
    assert.equal(importTickets(store, anaClaude, 'api', rows(50)).created.length, 50);
    assert.equal(importTickets(store, anaClaude, 'api', rows(50)).created.length, 50);
  });

  it('links parents and blockers by key, in any order, and creates labels and milestones when asked', () => {
    const result = importTickets(
      store,
      ana,
      'api',
      [
        { key: 'child', title: 'Child', parent: 'epic', blockedBy: ['infra'], labels: ['bug'] },
        { key: 'epic', title: 'Epic', milestone: 'Beta', criteria: ['Docs updated'] },
        { key: 'infra', title: 'Infra', blockedReason: 'waiting on the vendor', assignee: 'ana-claude', priority: 'high' },
      ],
      { createLabels: true, createMilestones: true },
    );
    assert.deepEqual(result.labelsCreated, ['bug']);
    assert.deepEqual(result.milestonesCreated, ['Beta']);
    const ref = (key: string) => result.created.find((c) => c.key === key)!.ref!;
    const child = store.tickets.get(ana, ref('child'));
    assert.equal(child.parent, ref('epic'));
    assert.deepEqual(child.blockedBy, [ref('infra')]);
    assert.deepEqual(child.labels.map((l) => l.name), ['bug']);
    const infra = store.tickets.get(ana, ref('infra'));
    assert.equal(infra.assignee?.name, 'ana-claude');
    assert.equal(infra.task, null, 'importing never starts tasks');
    assert.equal(infra.blockedReason, 'waiting on the vendor');
    assert.equal(store.tickets.get(ana, ref('epic')).criteriaItems[0]!.text, 'Docs updated');
  });

  it('checks every row first and writes nothing on any problem', () => {
    const bad = [...rows(5), { title: 'late', dueDate: '2026-02-30' }];
    assert.throws(() => importTickets(store, ana, 'api', bad), /Row 6: due date/);
    assert.throws(() => importTickets(store, ana, 'api', [{ title: 'x', labels: ['nope'] }]), /no label nope/);
    assert.throws(() => importTickets(store, ana, 'api', [{ title: 'x', parent: 'missing' }]), /neither a key/);
    assert.throws(() => importTickets(store, ana, 'api', [{ key: 'a', title: 'a', parent: 'b' }, { key: 'b', title: 'b', parent: 'a' }]), /loop/);
    assert.equal(store.tickets.list(ana, { project: 'api' }).length, 0);
  });

  it('can check a file without importing it', () => {
    const result = importTickets(store, ana, 'api', [{ title: 'x', labels: ['new'] }], { dryRun: true, createLabels: true });
    assert.deepEqual([result.dryRun, result.created.length, result.labelsCreated], [true, 1, ['new']]);
    assert.equal(store.tickets.list(ana, { project: 'api' }).length, 0);
    assert.equal(store.tickets.plan(ana, 'api').labels.length, 0);
  });
});

describe('import files', () => {
  it('parses CSV with quotes, commas, newlines and list columns', () => {
    assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi""\nthere"\n'), [
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere'],
    ]);
    const parsed = parseImport('Key,Title,Labels,Estimate,Blocked By\nk1,"Fix, now",bug;ui,3,\nk2,Next,,,k1\n', 'csv');
    assert.deepEqual(parsed.map((r) => [r.key, r.title, r.labels, r.estimate, r.blockedBy]), [
      ['k1', 'Fix, now', ['bug', 'ui'], 3, []],
      ['k2', 'Next', [], undefined, ['k1']],
    ]);
  });

  it('accepts a JSON array or { tickets }', () => {
    assert.equal(parseImport('[{"title":"a"}]', 'json').length, 1);
    const camel = parseImport('title,dueDate,blockedBy,blockedReason\nx,2026-11-02,API-1,vendor key\n', 'csv')[0]!;
    assert.deepEqual([camel.dueDate, camel.blockedBy, camel.blockedReason], ['2026-11-02', ['API-1'], 'vendor key']);
    assert.equal(parseImport('{"tickets":[{"title":"a"},{"title":"b"}]}', 'json').length, 2);
    assert.throws(() => parseImport('{', 'json'), /Not valid JSON/);
  });

  it('runs from the CLI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orco-import-'));
    const db = join(dir, 'orco.db');
    const seed = new Store(openDatabase(db));
    seed.createProject(seed.createUser('ana').participant, 'api');
    seed.db.close();
    const file = join(dir, 'tickets.csv');
    writeFileSync(file, 'title,labels\nOne,bug\nTwo,\n');
    const cli = (...args: string[]) =>
      execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', ...args, '--db', db], { encoding: 'utf8' });
    assert.match(cli('import', 'api', file, '--as', 'ana', '--create-labels', '--dry-run'), /Checked 2 tickets; nothing was written/);
    const out = cli('import', 'api', file, '--as', 'ana', '--create-labels');
    assert.match(out, /Created labels: bug/);
    assert.match(out, /API-1\tOne/);
    assert.match(out, /Imported 2 tickets into api\./);
  });
});
