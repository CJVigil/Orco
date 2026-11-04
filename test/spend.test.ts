import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { Store } from '../src/store.js';

describe('spend per ticket (#106)', () => {
  it('books session usage on the ticket, only the growth, and totals it by ticket, folder, person and agent', () => {
    let clock = Date.UTC(2026, 10, 4, 12);
    const store = new Store(openDatabase(':memory:'), { now: () => clock });
    const carlos = store.createUser('carlos').participant;
    const bot = store.createAgent('carlos', 'carlos-bot').participant;
    store.createProject(carlos, 'shop');
    store.tickets.createFolder(carlos, 'shop', { name: 'Kiosk' });
    const { ticket } = store.tickets.create(carlos, 'shop', { title: 'Fix the printer', folder: 'Kiosk' });
    store.tickets.start(bot, ticket.ref);
    assert.deepEqual(store.controls.reportUsage(bot, { session: 's1', tokens: 120_000, costUsd: 1.5 }), { ticket: ticket.ref, tokens: 120_000, cents: 150 }, 'on its one ticket in progress');
    assert.deepEqual(store.controls.reportUsage(bot, { session: 's1', tokens: 200_000, costUsd: 2.25 }), { ticket: ticket.ref, tokens: 80_000, cents: 75 }, 'only the growth');
    assert.deepEqual(store.tickets.get(carlos, ticket.ref).spend, { tokens: 200_000, cents: 225 });
    const spend = store.controls.projectSpend(carlos, 'shop', 7);
    assert.equal(spend.tickets[0]!.ref, ticket.ref);
    assert.deepEqual(spend.folders.map((f) => f.name), ['Kiosk']);
    assert.deepEqual(spend.people.map((p) => [p.name, p.cents]), [['carlos', 225]]);
    assert.deepEqual(spend.agents.map((a) => a.name), ['carlos-bot']);
    assert.throws(() => store.controls.reportUsage(carlos, { session: 'x', tokens: 1 }), /Agents report/);
  });

  it('shows the pace of a budget, and warns once when it would run out before the month ends', () => {
    let clock = Date.UTC(2026, 10, 3, 12);
    const store = new Store(openDatabase(':memory:'), { now: () => clock });
    const carlos = store.createUser('carlos').participant;
    const bot = store.createAgent('carlos', 'carlos-bot').participant;
    store.createProject(carlos, 'shop');
    store.controls.setBudget(carlos, 'agent', 'carlos-bot', 10_000);
    store.controls.recordSpend(bot.id, 2_000);
    const b = store.controls.budgets(carlos)[0]!;
    assert.equal(b.remainingCents, 8_000);
    assert.ok(b.evenCents < 1_000, 'a tenth of the month has not passed');
    assert.equal(b.runsOutOn, '2026-11-13', '$20 in 2.5 days runs a $100 cap out on the 13th');
    clock += 1;
  });
});
