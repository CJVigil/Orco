import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { searchAll } from '../src/search.js';
import { type OrcoError, Store } from '../src/store.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as OrcoError).code;
  }
  return 'ok';
};

function setup() {
  const store = new Store(openDatabase(':memory:'));
  const carlos = store.createUser('carlos').participant;
  const ana = store.createUser('ana').participant;
  const lead = store.createUser('lead').participant;
  const bot = store.createAgent('carlos', 'carlos-bot').participant;
  const leadBot = store.createAgent('lead', 'lead-bot').participant;
  store.createProject(carlos, 'mgmt');
  store.createProject(carlos, 'floor');
  store.addMember(carlos, 'mgmt', 'ana');
  store.addMember(carlos, 'mgmt', 'lead');
  store.addMember(carlos, 'floor', 'lead');
  return { store, carlos, ana, lead, bot, leadBot };
}

describe('private tickets (#97)', () => {
  it('hides a private ticket from members who are not on it: board, search, list and a direct ref', () => {
    const { store, carlos, ana, lead, bot, leadBot } = setup();
    const { ticket } = store.tickets.create(ana, 'mgmt', { title: 'Billing analysis for the owner', private: true });
    assert.equal(ticket.private, true);
    assert.equal(code(() => store.tickets.get(lead, ticket.ref)), 'not_found', 'a direct ref is a 404');
    assert.equal(code(() => store.tickets.get(leadBot, ticket.ref)), 'not_found');
    assert.ok(!store.tickets.list(lead, { project: 'mgmt' }).some((t) => t.ref === ticket.ref), 'not on the board');
    assert.ok(!store.tickets.list(lead).some((t) => t.ref === ticket.ref));
    assert.equal(searchAll(store, lead, 'Billing', {}).filter((h) => h.kind === 'ticket').length, 0, 'not in search');
    // The creator, a project admin and the admin's agent see it.
    assert.equal(store.tickets.get(ana, ticket.ref).title, 'Billing analysis for the owner');
    assert.equal(store.tickets.get(carlos, ticket.ref).ref, ticket.ref);
    assert.equal(store.tickets.get(bot, ticket.ref).ref, ticket.ref);
    assert.equal(searchAll(store, carlos, 'Billing', {}).filter((h) => h.kind === 'ticket').length, 1);
    // Assigning it to someone lets them see it.
    store.tickets.update(ana, ticket.ref, { assignee: 'lead' });
    assert.equal(store.tickets.get(lead, ticket.ref).ref, ticket.ref);
    assert.equal(store.tickets.get(leadBot, ticket.ref).ref, ticket.ref, 'and their agents');
  });

  it('is set by the person who opened it or a project admin, never an agent', () => {
    const { store, carlos, ana, lead, bot } = setup();
    const { ticket } = store.tickets.create(ana, 'mgmt', { title: 'Shift swap' });
    assert.equal(code(() => store.tickets.update(lead, ticket.ref, { private: true })), 'forbidden');
    assert.equal(code(() => store.tickets.update(bot, ticket.ref, { private: true })), 'forbidden');
    assert.equal(store.tickets.update(carlos, ticket.ref, { private: true }).ticket.private, true);
    assert.equal(store.tickets.update(ana, ticket.ref, { private: false }).ticket.private, false);
  });
});

describe('moving tickets between projects (#97)', () => {
  it('keeps comments and criteria, takes a new ref, and the old ref opens it', () => {
    const { store, carlos, lead } = setup();
    const { ticket } = store.tickets.create(carlos, 'mgmt', { title: 'Restock the kiosk printer', criteriaAdd: ['Paper in'] });
    store.tickets.comment(carlos, ticket.ref, 'Floor leads own this now');
    const moved = store.tickets.move(carlos, ticket.ref, 'floor').ticket;
    assert.equal(moved.project, 'floor');
    assert.notEqual(moved.ref, ticket.ref);
    assert.equal(store.tickets.get(carlos, ticket.ref).ref, moved.ref, 'the old ref opens the new one');
    assert.ok(moved.activity.some((a) => a.kind === 'comment' && a.body === 'Floor leads own this now'));
    assert.equal(moved.criteriaItems[0]?.text, 'Paper in');
    assert.ok(store.tickets.list(lead, { project: 'floor' }).some((t) => t.ref === moved.ref));
  });

  it('refuses a mover who is not in both projects', () => {
    const { store, carlos, ana } = setup();
    const { ticket } = store.tickets.create(ana, 'mgmt', { title: 'Something' });
    assert.equal(code(() => store.tickets.move(ana, ticket.ref, 'floor')), 'not_found');
    assert.equal(store.tickets.get(carlos, ticket.ref).project, 'mgmt');
  });
});
