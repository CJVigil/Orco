import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { oneEditApart, searchAll } from '../src/search.js';
import { Store } from '../src/store.js';

describe('ranked search (#141)', () => {
  const setup = () => {
    const store = new Store(openDatabase(':memory:'));
    const ana = store.createUser('ana').participant;
    const cara = store.createUser('cara').participant;
    store.createProject(ana, 'shop');
    return { store, ana, cara };
  };

  it('knows one-letter typos', () => {
    assert.equal(oneEditApart('kowalski', 'kowalsky'), true);
    assert.equal(oneEditApart('kowalski', 'kowalski'), true);
    assert.equal(oneEditApart('kowalski', 'kowalsk'), true);
    assert.equal(oneEditApart('kowalski', 'kowlaski'), true);
    assert.equal(oneEditApart('kowalski', 'kovalsky'), false);
  });

  it('a typo in a customer name finds its tickets, ranked, and only for those who may see them', () => {
    const { store, ana, cara } = setup();
    const older = store.tickets.create(ana, 'shop', { title: 'Orders: notes from the weekly review', description: 'Mentions Kowalski in passing.' }).ticket;
    const best = store.tickets.create(ana, 'shop', { title: 'Kowalski: refund for the broken chair', description: 'Customer called twice.' }).ticket;
    store.tickets.create(ana, 'shop', { title: 'Stock: recount bay 4', description: 'Nothing to do with customers.' });
    const hits = searchAll(store, ana, 'kowalsky', { kinds: ['ticket'] });
    assert.deepEqual(hits.map((h) => h.ref), [best.ref, older.ref], 'the title match outranks the body match');
    assert.equal(searchAll(store, ana, best.ref)[0]!.ref, best.ref, 'an exact ref comes first');
    assert.equal(searchAll(store, cara, 'kowalsky').length, 0, 'access rules are unchanged');
  });

  it('a phrase from a project file finds the file', () => {
    const { store, ana } = setup();
    store.files.write(ana, 'shop', 'reports/q3-returns.md', '# Q3 returns\n\nMost returns came from the oak bookshelf with a cracked back panel.');
    const hits = searchAll(store, ana, 'cracked back panel');
    assert.equal(hits[0]!.kind, 'file');
    assert.equal(hits[0]!.ref, 'reports/q3-returns.md');
    assert.match(hits[0]!.snippet, /cracked back panel/);
    // A newer version replaces the old text in the index.
    store.files.write(ana, 'shop', 'reports/q3-returns.md', '# Q3 returns\n\nRewritten: mostly the walnut desk.', { baseVersion: 1 });
    assert.equal(searchAll(store, ana, 'cracked back panel').length, 0);
    assert.equal(searchAll(store, ana, 'walnut desk')[0]!.kind, 'file');
  });

  it('every word has to match somehow', () => {
    const { store, ana } = setup();
    store.tickets.create(ana, 'shop', { title: 'Checkout: refunds post twice' });
    assert.equal(searchAll(store, ana, 'refunds twice').length, 1);
    assert.equal(searchAll(store, ana, 'refunds zebra').length, 0);
  });
});
