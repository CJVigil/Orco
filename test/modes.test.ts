import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { type OrcoError, Store } from '../src/store.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return `${(err as OrcoError).code}: ${(err as OrcoError).message}`;
  }
  return 'ok';
};

describe('permission modes (#119)', () => {
  it('Supervised asks before any change, broader modes let routine work through, deploys always ask, and caps hold', () => {
    const store = new Store(openDatabase(':memory:'));
    const carlos = store.createUser('carlos').participant; // org admin
    const ana = store.createUser('ana').participant;
    const bot = store.createAgent('carlos', 'carlos-bot').participant;
    store.createProject(carlos, 'shop');
    store.addMember(carlos, 'shop', 'ana');
    const { ticket } = store.tickets.create(carlos, 'shop', { title: 'Tidy the docs' });
    assert.equal(store.tickets.get(carlos, ticket.ref).mode.mode, 'supervised', 'the default asks');
    assert.equal(store.approvals.request(bot, { ticket: ticket.ref, summary: 'Edit the README' }).state, 'pending');
    store.modes.setTicket(carlos, ticket.ref, 'auto_edits');
    assert.equal(store.approvals.request(bot, { ticket: ticket.ref, summary: 'Edit the README wording' }).state, 'approved', 'an edit goes ahead');
    assert.equal(store.approvals.request(bot, { ticket: ticket.ref, summary: 'Send the newsletter email' }).state, 'pending', 'outward-facing asks');
    store.modes.setTicket(carlos, ticket.ref, 'full');
    assert.equal(store.approvals.request(bot, { ticket: ticket.ref, summary: 'Deploy the docs site' }).state, 'pending', 'deploys always ask');
    // Caps: the project caps at Auto, so Full narrows and cannot be chosen.
    store.modes.setProject(carlos, 'shop', { cap: 'auto' });
    const capped = store.tickets.get(carlos, ticket.ref).mode;
    assert.deepEqual([capped.mode, capped.cappedBy], ['auto', 'carlos (project)']);
    assert.match(code(() => store.modes.setTicket(ana, ticket.ref, 'full')), /^forbidden: This project caps the mode at Auto/);
    store.modes.setOrgCap(carlos, 'supervised');
    assert.equal(store.tickets.get(carlos, ticket.ref).mode.cappedBy, 'carlos (org)');
    assert.match(code(() => store.modes.setOrgCap(ana, null)), /^forbidden/);
    assert.match(code(() => store.modes.setTicket(bot, ticket.ref, 'supervised')), /^forbidden/, 'agents do not set their own mode');
  });
});
