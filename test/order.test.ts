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

describe('build order rules (#109)', () => {
  it('keeps ui tickets from starting until the Skeleton milestone is done, then lets them go', () => {
    const store = new Store(openDatabase(':memory:'));
    const carlos = store.createUser('carlos').participant;
    const ana = store.createUser('ana').participant;
    const bot = store.createAgent('carlos', 'carlos-bot').participant;
    store.createProject(carlos, 'kiosk');
    store.addMember(carlos, 'kiosk', 'ana');
    const { rule } = store.order.addSkeleton(carlos, 'kiosk');
    assert.equal(rule?.label, 'ui');
    store.tickets.createLabel(carlos, 'kiosk', 'ui');
    const api = store.tickets.create(carlos, 'kiosk', { title: 'Order API with tests', milestone: 'Skeleton' }).ticket;
    const screen = store.tickets.create(carlos, 'kiosk', { title: 'Order screen', labels: ['ui'] }).ticket;
    assert.deepEqual(store.tickets.get(carlos, screen.ref).waitsOn, ['Skeleton'], 'the card says why it waits');
    assert.match(code(() => store.tickets.update(bot, screen.ref, { status: 'In Progress' })), /^conflict: KIO-2 waits on Skeleton \(build order rule\)/);
    assert.match(code(() => store.tickets.start(bot, screen.ref)), /waits on Skeleton/);
    assert.match(code(() => store.tickets.update(carlos, screen.ref, { assignee: 'carlos-bot' })), /waits on Skeleton/, 'not handed to an agent');
    assert.equal(store.tickets.update(carlos, screen.ref, { assignee: 'ana' }).ticket.assignee?.name, 'ana', 'a person can be assigned to plan it');
    store.tickets.update(carlos, api.ref, { status: 'Done' });
    assert.deepEqual(store.tickets.get(carlos, screen.ref).waitsOn, [], 'unlocks on its own');
    assert.equal(store.tickets.update(bot, screen.ref, { status: 'In Progress' }).ticket.status.name, 'In Progress');
    assert.ok(ana);
  });

  it('lets org admins set rules for every project that a project cannot remove', () => {
    const store = new Store(openDatabase(':memory:'));
    const carlos = store.createUser('carlos').participant; // org admin
    const ana = store.createUser('ana').participant;
    store.createProject(ana, 'shop');
    const orgRule = store.order.add(carlos, { label: 'ui', waitsLabel: 'api' });
    assert.equal(orgRule.project, null);
    assert.deepEqual(store.order.list(ana, 'shop').map((r) => r.id), [orgRule.id]);
    assert.match(code(() => store.order.remove(ana, orgRule.id)), /^forbidden: That rule is the org's/);
    assert.match(code(() => store.order.add(ana, { label: 'ui', waitsLabel: 'api' })), /^forbidden: Only org admins/);
    store.tickets.createLabel(ana, 'shop', 'ui');
    store.tickets.createLabel(ana, 'shop', 'api');
    store.tickets.create(ana, 'shop', { title: 'Endpoint', labels: ['api'] });
    const ui = store.tickets.create(ana, 'shop', { title: 'Screen', labels: ['ui'] }).ticket;
    assert.deepEqual(store.tickets.get(ana, ui.ref).waitsOn, ['the open "api" tickets']);
  });
});
