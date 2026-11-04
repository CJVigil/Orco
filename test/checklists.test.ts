import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { newPlan } from '../src/plans.js';
import { type OrcoError, Store } from '../src/store.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return `${(err as OrcoError).code}: ${(err as OrcoError).message}`;
  }
  return 'ok';
};

describe('Definition of Done templates (#110)', () => {
  it('adds the service checklist with the label, refuses Done until required items are checked, and records an override', () => {
    const store = new Store(openDatabase(':memory:'));
    const carlos = store.createUser('carlos').participant;
    const bot = store.createAgent('carlos', 'carlos-bot').participant;
    store.createProject(carlos, 'shop');
    store.tickets.createLabel(carlos, 'shop', 'service');
    store.tickets.createLabel(carlos, 'shop', 'ui');
    const { ticket } = store.tickets.create(carlos, 'shop', { title: 'Payments worker' });
    const labelled = store.tickets.update(bot, ticket.ref, { labels: ['service'] }).ticket;
    assert.equal(labelled.criteriaItems.length, 7);
    assert.ok(labelled.criteriaItems.every((c) => c.required && c.template === 'service'));
    assert.match(code(() => store.tickets.update(bot, ticket.ref, { status: 'Done' })), /^conflict: SHO-1 has required items unchecked: Names follow the platform naming rules; No host ports/);
    assert.match(code(() => store.tickets.update(bot, ticket.ref, { status: 'Done', doneOverride: 'shipping anyway' })), /^forbidden/, 'agents do not override');
    const closed = store.tickets.update(carlos, ticket.ref, { status: 'Done', doneOverride: 'Hotfix: the checklist follows in SHO-9' }).ticket;
    assert.equal(closed.status.name, 'Done');
    const override = closed.activity.flatMap((a) => (a.kind === 'change' ? (a.detail as { changes: { field: string; to: unknown }[] }).changes : [])).find((c) => c.field === 'override');
    assert.equal(override?.to, 'Hotfix: the checklist follows in SHO-9', 'shown on the ticket');
    assert.ok(store.audit.list(carlos, { limit: 20 }).some((e) => e.action === 'ticket.done_override'));
    // ui at creation; checking every required item lets it close.
    const screen = store.tickets.create(carlos, 'shop', { title: 'Checkout screen', labels: ['ui'], criteriaAdd: ['Copy reviewed'] }).ticket;
    assert.deepEqual(screen.criteriaItems.map((c) => [c.text, c.required]), [['Copy reviewed', false], ['Works at phone width (390 px)', true]]);
    const phone = screen.criteriaItems.find((c) => c.required)!;
    assert.equal(store.tickets.update(bot, screen.ref, { status: 'Done', criteriaDone: [phone.id] }).ticket.status.name, 'Done');
  });

  it('writes a numbered plan from the template and indexes it', () => {
    const store = new Store(openDatabase(':memory:'));
    const carlos = store.createUser('carlos').participant;
    store.createProject(carlos, 'shop');
    assert.deepEqual(newPlan(store, carlos, 'shop', 'Refund flow v2'), { path: 'plans/001-refund-flow-v2.md', number: '001' });
    assert.equal(newPlan(store, carlos, 'shop', 'Kiosk printer').path, 'plans/002-kiosk-printer.md');
    const plan = store.files.read(carlos, 'shop', 'plans/001-refund-flow-v2.md').content;
    assert.match(plan, /## Done criteria[\s\S]*## STOP conditions/);
    const index = store.files.read(carlos, 'shop', 'plans/README.md').content;
    assert.match(index, /\| \[002\]\(002-kiosk-printer.md\) \| Kiosk printer \| \| \| \| PROPOSED \|/);
  });
});
