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

describe('area owners (#111)', () => {
  it('holds Done and deploy approvals in an owned folder until the owner approves, asking the owner', () => {
    let clock = Date.UTC(2026, 10, 4, 12);
    const store = new Store(openDatabase(':memory:'), { now: () => clock });
    const carlos = store.createUser('carlos').participant;
    const ana = store.createUser('ana').participant;
    const ben = store.createUser('ben').participant;
    const bot = store.createAgent('carlos', 'carlos-bot').participant;
    store.createProject(carlos, 'ops');
    store.addMember(carlos, 'ops', 'ana');
    store.addMember(carlos, 'ops', 'ben');
    store.tickets.createFolder(carlos, 'ops', { name: 'Infrastructure' });
    store.owners.add(carlos, 'ops', 'folder', 'Infrastructure', 'ana');
    const { ticket } = store.tickets.create(carlos, 'ops', { title: 'Move the proxy to the new host', folder: 'Infrastructure', assignee: 'carlos-bot' });
    assert.deepEqual(store.tickets.get(carlos, ticket.ref).needsReviewFrom, ['ana (Infrastructure)'], 'the card says whose review it needs');
    assert.match(code(() => store.tickets.update(bot, ticket.ref, { status: 'Done' })), /^conflict: OPS-1 needs an approving review from ana \(owner of Infrastructure\) before Done/);
    const asked = store.reviews.pendingFor(ana);
    assert.equal(asked.length, 1, 'it lands in the owner\'s Needs you');
    const deploy = store.approvals.request(bot, { ticket: ticket.ref, summary: 'Deploy the proxy to production' });
    assert.match(code(() => store.approvals.decide(carlos, deploy.id, 'approved')), /^conflict: Not yet: OPS-1 needs ana's review/);
    store.reviews.submit(ana, asked[0]!.id, 'approved');
    assert.deepEqual(store.tickets.get(carlos, ticket.ref).needsReviewFrom, []);
    assert.equal(store.approvals.decide(carlos, deploy.id, 'approved').state, 'approved');
    // Delegation: ben stands in for ana this week.
    store.owners.delegate(ana, 'ben', '2026-11-01', '2026-11-07');
    const second = store.tickets.create(carlos, 'ops', { title: 'Rotate the TLS cert', folder: 'Infrastructure' }).ticket;
    const review = store.reviews.request(bot, { ticket: second.ref, reviewer: 'ben', summary: 'Cert rotated' });
    store.reviews.submit(ben, review.id, 'approved');
    assert.deepEqual(store.tickets.get(carlos, second.ref).needsReviewFrom, [], "a delegate's review counts");
  });

  it('guided reviews approve only once each look-closely item is ticked', () => {
    const store = new Store(openDatabase(':memory:'));
    const carlos = store.createUser('carlos').participant;
    const bot = store.createAgent('carlos', 'carlos-bot').participant;
    store.createProject(carlos, 'ops');
    const { ticket } = store.tickets.create(carlos, 'ops', { title: 'Change the firewall' });
    const review = store.reviews.request(bot, {
      ticket: ticket.ref,
      reviewer: 'carlos',
      summary: 'Opened 443 on staging',
      guide: { stops: [{ title: 'The rule', detail: '+ allow 443/tcp from 10.0.0.0/8', path: 'infra/firewall.yml' }], lookClosely: ['Is 10.0.0.0/8 too wide?', 'Does prod need it too?'] },
    });
    assert.equal(review.guide?.lookClosely.length, 2);
    assert.match(code(() => store.reviews.submit(carlos, review.id, 'approved', undefined, [0])), /Still open: Does prod need it too\?/);
    assert.equal(store.reviews.submit(carlos, review.id, 'approved', undefined, [0, 1]).state, 'approved');
  });
});
