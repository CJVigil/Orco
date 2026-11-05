import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { fillForm } from '../src/forms.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';
import { restArea } from '../src/tooltable.js';

describe('intake forms (#134)', () => {
  let store: Store;
  let ana: Participant;
  let ben: Participant;
  let bot: Participant;
  beforeEach(() => {
    store = new Store(openDatabase(':memory:'));
    ana = store.createUser('ana').participant;
    ben = store.createUser('ben').participant;
    bot = store.createAgent('ana', 'floor-bot').participant;
    store.createProject(ana, 'shop');
    store.addMember(ana, 'shop', 'ben');
    store.tickets.createFolder(ana, 'shop', { name: 'Warehouse' });
    store.forms.create(ana, 'shop', {
      name: 'Damaged pallet',
      hint: 'Something arrived broken',
      fields: [
        { label: 'Location', type: 'location', required: true },
        { label: 'Item code', type: 'item', required: true },
        { label: 'Severity', type: 'choice', options: 'minor, major', required: false },
      ],
      labels: ['damage'],
      folder: 'Warehouse',
      priority: 'high',
    });
  });

  it('refuses missing required fields by name, all at once', () => {
    assert.throws(
      () => store.tickets.create(ben, 'shop', store.forms.ticketInput(ben, 'shop', 'Damaged pallet', { 'Item code': 'SKU-1' }, {})),
      (e: OrcoError) => e.code === 'invalid' && /needs Location$/.test(e.message),
    );
    assert.throws(() => fillForm({ name: 'X', fields: [{ label: 'A', type: 'text', required: true }, { label: 'B', type: 'text', required: true }] }, {}, {}), /needs A, B/);
    assert.throws(() => store.forms.ticketInput(ben, 'shop', 'Damaged pallet', { Location: 'Bay 4', 'Item code': 'S', Severity: 'awful' }, {}), /one of minor, major/);
  });

  it('a filled form lands with its labels, folder and priority, and a parseable description', () => {
    const { ticket } = store.tickets.create(ben, 'shop', store.forms.ticketInput(ben, 'shop', 'damaged PALLET', { location: 'Bay 4', 'Item code': 'SKU-1', severity: 'MAJOR' }, {}));
    assert.equal(ticket.title, 'Damaged pallet: Bay 4');
    assert.deepEqual(ticket.labels.map((l) => (typeof l === 'string' ? l : l.name)), ['damage']);
    assert.equal(ticket.priority, 'high');
    assert.equal(ticket.folder?.name ?? ticket.folder, 'Warehouse');
    assert.equal(ticket.description, 'Form: Damaged pallet\nLocation: Bay 4\nItem code: SKU-1\nSeverity: major');
    assert.equal(store.tickets.plan(ana, 'shop').forms[0]!.name, 'Damaged pallet');
  });

  it('only project admins set up forms; agents file with them; REST ticket writes are a tickets action', () => {
    assert.throws(() => store.forms.create(ben, 'shop', { name: 'X', fields: [{ label: 'A' }] }), (e: OrcoError) => e.code === 'forbidden');
    assert.throws(() => store.forms.create(bot, 'shop', { name: 'X', fields: [{ label: 'A' }] }), (e: OrcoError) => e.code === 'forbidden');
    const { ticket } = store.tickets.create(bot, 'shop', store.forms.ticketInput(bot, 'shop', 'Damaged pallet', { Location: 'Dock 2', 'Item code': 'SKU-9' }, {}));
    assert.equal(ticket.creator, 'floor-bot');
    assert.equal(restArea('POST', '/projects/shop/tickets'), 'tickets');
  });
});
