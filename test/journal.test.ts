import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { normalizeSymptom, similarity } from '../src/journal.js';
import { type OrcoError, Store } from '../src/store.js';
import { TOOLS } from '../src/tooltable.js';

describe('agent journal and papercuts (#146)', () => {
  const setup = () => {
    const store = new Store(openDatabase(':memory:'), { now: () => Date.parse('2026-11-05T03:00:00Z') });
    const admin = store.createUser('ana').participant;
    const ben = store.createUser('ben').participant;
    const bot = store.createAgent('ana', 'ana-bot').participant;
    const other = store.createAgent('ben', 'ben-bot').participant;
    store.createProject(admin, 'api');
    return { store, admin, ben, bot, other };
  };

  it('records decisions with a why, searchable by ticket, resource and window, and digests a day', () => {
    const { store, admin, bot } = setup();
    store.journal.record(bot, { kind: 'action', tool: 'create_ticket', summary: 'create ticket api: Checkout: refunds post twice', project: 'api' });
    store.journal.record(bot, { kind: 'action', tool: 'create_ticket', summary: 'create ticket api: Search: slow', project: 'api' });
    const d = store.journal.record(bot, { kind: 'decision', summary: 'Rolled back prod deploy for API-3', why: 'error rate doubled', resource: 'prod', project: 'api' });
    assert.equal(d?.ticket, 'API-3');
    assert.equal(d?.project, 'api');
    assert.equal(store.journal.record(admin, { kind: 'decision', summary: 'x' }), null, 'people use the audit log');
    assert.equal(store.journal.search(admin, { resource: 'prod', from: '2026-11-05T02:00', to: '2026-11-05T04:00Z' }).length, 1);
    assert.equal(store.journal.search(admin, { resource: 'prod', to: '2026-11-04' }).length, 0);
    assert.equal(store.journal.search(admin, { ticket: 'api-3' })[0]?.why, 'error rate doubled');
    const digest = store.journal.digest(admin, { agent: 'ana-bot', date: '2026-11-05' });
    assert.deepEqual(digest.lines, ['2 tickets filed', '1 decision']);
    assert.throws(() => store.journal.search(admin, { from: 'nope' }), (e: OrcoError) => e.code === 'invalid');
  });

  it('hides entries from projects the reader cannot see', () => {
    const { store, ben, bot, other } = setup();
    store.journal.record(bot, { kind: 'decision', summary: 'chose sqlite', project: 'api' });
    store.journal.record(bot, { kind: 'lesson', summary: 'no project here' });
    assert.equal(store.journal.search(ben).length, 0);
    assert.equal(store.journal.search(other).length, 0);
    assert.equal(store.journal.search(bot).length, 2);
  });

  it('keeps papercuts in four lines, refuses duplicate symptoms, and corrects without deleting', () => {
    const { store, admin, bot, other } = setup();
    const p = store.journal.addPapercut(bot, { symptom: 'EADDRINUSE: address already in use :::4440', cause: 'An old server was still running', fix: 'Stop it with orco service stop' });
    assert.equal(p.text, 'Symptom: EADDRINUSE: address already in use :::4440\nCause: An old server was still running\nFix: Stop it with orco service stop\n(ana-bot, 2026-11-05)');
    assert.throws(() => store.journal.addPapercut(other, { symptom: 'EADDRINUSE: address already in use :::8080', cause: 'x', fix: 'y' }), (e: OrcoError) => e.code === 'conflict' && /Papercut 1/.test(e.message));
    assert.throws(() => store.journal.addPapercut(other, { symptom: 'only this', cause: '', fix: 'y' }), (e: OrcoError) => e.code === 'invalid');
    assert.equal(store.journal.searchPapercuts(other, 'Error: listen EADDRINUSE: address already in use 0.0.0.0:3000')[0]?.id, p.id);
    const c = store.journal.correctPapercut(other, p.id, 'Also happens when the proxy holds the port');
    assert.match(c.text, /\nCORRECTED 2026-11-05: Also happens when the proxy holds the port \(ben-bot\)$/);
    assert.match(c.text, /^Symptom: EADDRINUSE/);
    const note = store.journal.promotePapercut(bot, p.id);
    assert.equal(note.state, 'proposed');
    assert.equal(store.orgNotes.list(admin, { state: 'proposed' }).length, 1);
  });

  it('matches symptoms with numbers and paths blurred, and lists every new tool', () => {
    assert.equal(normalizeSymptom('ENOENT /home/a/x.json line 12'), normalizeSymptom('ENOENT /tmp/y.json line 99'));
    assert.ok(similarity('cannot find module zod', 'Error: Cannot find module zod') > 0.5);
    for (const t of ['journal', 'journal_search', 'journal_digest', 'papercuts_search', 'papercut_add', 'papercut_correct', 'promote_papercut']) assert.ok(TOOLS[t], t);
  });
});
