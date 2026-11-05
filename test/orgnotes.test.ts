import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { type OrcoError, Store } from '../src/store.js';

describe('org memory (#144)', () => {
  const setup = () => {
    let clock = Date.parse('2026-11-05T12:00:00Z');
    const store = new Store(openDatabase(':memory:'), { now: () => clock });
    const admin = store.createUser('ana').participant;
    const ben = store.createUser('ben').participant;
    const bot = store.createAgent('ben', 'ben-bot').participant;
    store.createProject(admin, 'api');
    return { store, admin, ben, bot, tick: (days: number) => (clock += days * 86_400_000) };
  };

  it('an agent proposes, an org admin approves, and only then every agent loads it', () => {
    const { store, admin, ben, bot } = setup();
    const n = store.orgNotes.propose(bot, { name: 'Deploy freeze', description: 'No deploys on Fridays', type: 'rule', body: 'No deploys after 12:00 on Fridays. See API-12 and [[on-call]].', source: 'API-12' });
    assert.equal(n.state, 'proposed');
    assert.equal(store.orgNotes.index(), '', 'not loaded until approved');
    assert.throws(() => store.orgNotes.approve(bot, n.id), (e: OrcoError) => e.code === 'forbidden');
    assert.throws(() => store.orgNotes.approve(ben, n.id), (e: OrcoError) => e.code === 'forbidden', 'org admins decide');
    const live = store.orgNotes.approve(admin, n.id);
    assert.equal(live.state, 'live');
    assert.equal(live.approvedBy, 'ana');
    assert.equal(live.author, 'ben-bot');
    assert.deepEqual(live.tickets, ['API-12']);
    assert.deepEqual(live.links, ['on-call']);
    assert.match(store.orgNotes.index(), /- \[\[deploy-freeze\]\] \(rule\) No deploys on Fridays/);
    assert.deepEqual(store.orgNotes.aboutTicket('api-12').map((x) => x.slug), ['deploy-freeze']);
  });

  it('flags expired statuses instead of stating them as current, and needs expiry for a status', () => {
    const { store, admin, tick } = setup();
    assert.throws(() => store.orgNotes.propose(admin, { name: 'Payments down', type: 'status', body: 'Stripe is down' }), /needs expires/);
    store.orgNotes.propose(admin, { name: 'Payments down', type: 'status', description: 'Stripe is down', body: 'Stripe is down', expires: '2026-11-06' });
    assert.match(store.orgNotes.index(), /until 2026-11-06/);
    tick(3);
    assert.match(store.orgNotes.index(), /EXPIRED 2026-11-06: may no longer hold/);
  });

  it('a change to a live note waits for approval while the old one stays; agents only ask to forget', () => {
    const { store, admin, bot } = setup();
    store.orgNotes.propose(admin, { name: 'On call', description: 'Ana this week', type: 'contact', body: 'Ana is on call.' });
    const change = store.orgNotes.propose(bot, { name: 'On call', description: 'Ben this week', type: 'contact', body: 'Ben is on call.' });
    assert.equal(store.orgNotes.read(admin, 'on-call').body, 'Ana is on call.');
    store.orgNotes.approve(admin, change.id);
    assert.equal(store.orgNotes.read(admin, 'on-call').body, 'Ben is on call.');
    assert.deepEqual(store.orgNotes.forget(bot, 'on-call', 'rotation changed'), { removed: false });
    assert.equal(store.orgNotes.read(admin, 'on-call').forgetRequestedBy, 'ben-bot');
    assert.deepEqual(store.orgNotes.forget(admin, 'on-call'), { removed: true });
  });

  it('exports an Obsidian vault and reads edits back', () => {
    const { store, admin } = setup();
    store.orgNotes.propose(admin, { name: 'Deploy freeze', description: 'No deploys on Fridays', type: 'rule', body: 'No deploys after 12:00 on Fridays.', source: 'API-12' });
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    assert.equal(store.orgNotes.exportVault(dir), 1);
    const file = readFileSync(join(dir, 'deploy-freeze.md'), 'utf8');
    assert.match(file, /^---\nname: "Deploy freeze"\ndescription: "No deploys on Fridays"\ntype: rule\nauthor: "ana"\nsource: "API-12"/);
    assert.match(readFileSync(join(dir, 'INDEX.md'), 'utf8'), /\[\[deploy-freeze\]\]/);
    writeFileSync(join(dir, 'deploy-freeze.md'), file.replace('12:00', '14:00'));
    assert.equal(store.orgNotes.importVault(dir, admin), 1);
    assert.match(store.orgNotes.read(admin, 'deploy-freeze').body, /14:00/);
  });
});
