import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { contextPack, setPackBudget } from '../src/pack.js';
import { Store } from '../src/store.js';

describe('handoff context packs (#121)', () => {
  it('brings the original ask, the outcomes and the latest answers, within the budget, and says what it left out', () => {
    const store = new Store(openDatabase(':memory:'));
    const carlos = store.createUser('carlos').participant;
    const bot = store.createAgent('carlos', 'carlos-bot').participant;
    const next = store.createAgent('carlos', 'carlos-codex').participant;
    store.createProject(carlos, 'shop');
    const ask = 'Checkout fails when the payment iframe is slow. Reproduce it with throttling, then fix the wait.';
    const { ticket } = store.tickets.create(carlos, 'shop', { title: 'Flaky checkout', description: ask, criteriaAdd: ['Passes 20 runs in a row'] });
    store.tickets.update(carlos, ticket.ref, { handoff: 'Tried a longer timeout: did not help.' });
    store.withoutRateLimit(() => {
      for (let i = 1; i <= 40; i++) store.tickets.comment(carlos, ticket.ref, `Run ${i}: still flaky on the second payment attempt, logs attached in the thread.`);
    });
    store.tickets.comment(carlos, ticket.ref, 'Answer: yes, staging can be throttled to 3G.');
    const pack = contextPack(store, bot, ticket.ref);
    assert.ok(pack.text.includes(ask), 'the original request, verbatim');
    assert.ok(pack.text.includes('Tried a longer timeout: did not help.'));
    assert.ok(pack.text.includes('- Passes 20 runs in a row'));
    assert.ok(pack.text.includes('Answer: yes, staging can be throttled to 3G.'), 'the latest answer is in');
    assert.ok(pack.text.length <= pack.budget + 400);
    setPackBudget(store, carlos, 'carlos-codex', 2000);
    const small = contextPack(store, next, ticket.ref);
    assert.ok(small.text.includes(ask), 'never shortened to make room');
    assert.ok(small.omitted && small.omitted.comments > 20);
    assert.match(small.text, /Left out to fit 2000 characters: 0 task outcome\(s\), \d+ comment\(s\)\. get_ticket SHO-1/);
    assert.ok(small.text.indexOf('Answer: yes') > small.text.indexOf('## Latest comments'), 'newest first into the budget, shown in order');
    assert.throws(() => setPackBudget(store, bot, 'carlos-codex', 5000), /owner/);
  });
});
