import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { fieldsOf, fill } from '../src/actions.js';
import { openDatabase } from '../src/db.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';

describe('project actions (#133)', () => {
  let store: Store;
  let ana: Participant;
  let ben: Participant;
  let bot: Participant;
  beforeEach(() => {
    store = new Store(openDatabase(':memory:'));
    ana = store.createUser('ana').participant;
    ben = store.createUser('ben').participant;
    bot = store.createAgent('ana', 'numbers-bot').participant;
    store.createProject(ana, 'shop');
    store.addMember(ana, 'shop', 'ben');
    // Ben's requests normally wait for Ana: the default policy asks the owner.
  });

  it('reads and fills {{fields}} on one line, without mentions', () => {
    assert.deepEqual(fieldsOf('Report for {{client}} on {{ Day }} and {{client}}'), ['client', 'day']);
    assert.equal(fill('Report for {{client}}', { client: 'Acme\n@ana' }), 'Report for Acme ＠ana');
    assert.throws(() => fill('Report for {{client}}', {}), (e: OrcoError) => e.code === 'invalid');
  });

  it('a member taps an approved action and the agent starts; editing the text makes the next tap wait', () => {
    const action = store.actions.create(ana, 'shop', { label: 'Daily numbers', agent: 'numbers-bot', request: 'Post the daily numbers for {{store}}' });
    assert.equal(action.approved, true, 'the owner made it, so it is approved');
    const first = store.actions.run(ben, action.id, { store: 'Main St' });
    assert.equal(first.state, 'requested');
    assert.match(first.request, /Main St/);
    assert.equal(first.requester, 'ben');

    const edited = store.actions.update(ana, action.id, { request: 'Post the daily numbers and refunds for {{store}}' });
    assert.equal(edited.approved, true, 'the owner editing it re-approves it');
    // Another admin edits the text: the owner must approve again before taps skip the prompt.
    store.createUser('cara');
    store.addMember(ana, 'shop', 'cara', 'admin');
    const cara = store.participantByName('cara')!;
    const changed = store.actions.update(cara, action.id, { request: 'Post the numbers for {{store}}' });
    assert.equal(changed.approved, false);
    assert.equal(store.actions.run(ben, action.id, { store: 'Main St' }).state, 'awaiting_approval');
    assert.equal(store.actions.approve(ana, action.id).approved, true);
    assert.equal(store.actions.run(ben, action.id, { store: 'Main St' }).state, 'requested');
  });

  it('an unapproved action follows the usual policy, and only the owner approves', () => {
    const benBot = store.createAgent('ben', 'ben-bot').participant;
    void benBot;
    const action = store.actions.create(ana, 'shop', { label: 'Check', agent: 'ben-bot', request: 'Check the stock' });
    assert.equal(action.approved, false);
    const cara = store.createUser('cara').participant;
    store.addMember(ana, 'shop', 'cara');
    assert.equal(store.actions.run(cara, action.id).state, 'awaiting_approval');
    assert.throws(() => store.actions.approve(ana, action.id), (e: OrcoError) => e.code === 'forbidden');
    assert.equal(store.actions.approve(ben, action.id).approved, true);
    assert.equal(store.actions.run(cara, action.id).state, 'requested');
    assert.throws(() => store.actions.run(bot, action.id), (e: OrcoError) => e.code === 'forbidden');
    assert.throws(() => store.actions.create(ben, 'shop', { label: 'x', agent: 'ben-bot', request: 'y' }), (e: OrcoError) => e.code === 'forbidden');
  });
});
