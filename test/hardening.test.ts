import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';

// Regression tests for issues #16-#22: who may administer, what spend counts, what people see.
let store: Store;
let cto: Participant;
let ana: Participant;
let ben: Participant;
let anaBot: Participant;
let anaHelper: Participant;

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as OrcoError).code;
  }
  return 'ok';
};

beforeEach(() => {
  store = new Store(openDatabase(':memory:'));
  cto = store.createUser('cto').participant;
  ana = store.createUser('ana').participant;
  ben = store.createUser('ben').participant;
  anaBot = store.createAgent('ana', 'ana-bot').participant;
  anaHelper = store.createAgent('ana', 'ana-helper').participant;
  store.createProject(ana, 'api');
  store.createProject(ben, 'web');
});

describe('agents never administer (#16)', () => {
  it('refuses an admin owner’s agent on groups, members, budgets and pauses', () => {
    store.groups.create(cto, 'backend', ['ben']);
    assert.equal(code(() => store.groups.setProjectRole(anaBot, 'api', 'backend', 'admin')), 'forbidden');
    assert.equal(code(() => store.addMember(anaBot, 'api', 'ben')), 'forbidden');
    assert.equal(code(() => store.adminProject(anaBot, 'api')), 'forbidden');
    assert.equal(store.adminProject(ana, 'api').name, 'api', 'its owner still can');
  });
});

describe('spend (#17)', () => {
  it('never lets an agent lower what the bridge measured', () => {
    const task = store.tasks.create(ana, { agent: 'ana-bot', room: 'api/general', request: 'Do the thing' });
    store.tasks.update(anaBot, task.id, 'accepted');
    store.tasks.addUsage(task.id, 500, 1000);
    let t = store.tasks.reportProgress(anaBot, task.id, 'cheap so far', null, { costCents: 0, tokens: 0 });
    assert.equal(t.budget?.spentCents, 500, 'reporting 0 does not erase measured cost');
    t = store.tasks.reportProgress(anaBot, task.id, 'more', null, { costCents: 900 });
    assert.equal(t.budget?.spentCents, 900, 'a higher reported total counts');
    store.tasks.addUsage(task.id, 100, 0);
    assert.equal(store.tasks.get(ana, task.id).budget?.spentCents, 900, 'the larger of measured (600) and reported (900)');
    store.tasks.addUsage(task.id, 400, 0);
    assert.equal(store.tasks.get(ana, task.id).budget?.spentCents, 1000);
  });
});

describe('decisions (#18)', () => {
  it('are superseded only where they were made', () => {
    const org = store.decisions.record(cto, { project: null, title: 'Licenses', decision: 'Apache-2.0' });
    assert.equal(code(() => store.decisions.record(ana, { project: 'api', title: 'Licenses', decision: 'MIT' }, org.id)), 'forbidden');
    const local = store.decisions.record(ana, { project: 'api', title: 'DB', decision: 'SQLite' });
    store.addMember(ana, 'api', 'ben');
    assert.equal(code(() => store.decisions.record(ben, { project: 'web', title: 'DB', decision: 'Postgres' }, local.id)), 'forbidden', 'not from another project');
    assert.equal(store.decisions.record(cto, { project: null, title: 'Licenses', decision: 'Apache-2.0 or MIT' }, org.id).title, 'Licenses');
  });
});

describe('groups (#19)', () => {
  it('are for people, and show only projects they can see', () => {
    store.groups.create(cto, 'design', ['ben']);
    store.groups.setProjectRole(ben, 'web', 'design', 'member');
    assert.equal(code(() => store.groups.list(anaBot)), 'forbidden');
    assert.deepEqual(store.groups.list(ana).map((g) => [g.name, g.projects]), [['design', []]]);
    assert.deepEqual(store.groups.list(cto)[0]!.projects.map((p) => p.project), ['web']);
  });
});

describe('hand-overs (#21)', () => {
  it('cannot loop back to an agent that already had the work', () => {
    const task = store.tasks.create(ana, { agent: 'ana-bot', room: 'api/general', request: 'Do the thing' });
    store.tasks.update(anaBot, task.id, 'accepted');
    const { to } = store.tasks.reassign(anaBot, task.id, 'ana-helper', 'out of usage');
    store.tasks.update(anaHelper, to.id, 'accepted');
    assert.equal(code(() => store.tasks.reassign(anaHelper, to.id, 'ana-bot')), 'conflict');
    assert.deepEqual(store.tasks.get(ana, to.id).chain[0], 'ana', 'the person who asked stays at the head of the chain');
  });
});

describe('cross-project blockers (#22)', () => {
  it('stay anonymous to people who cannot see the other project', () => {
    store.addMember(ben, 'web', 'ana');
    const dan = store.createUser('dan').participant;
    store.addMember(ana, 'api', 'dan');
    store.tickets.createMilestone(ana, 'api', { name: 'v2', targetDate: '2099-10-20' });
    store.tickets.createMilestone(ben, 'web', { name: 'launch', targetDate: '2099-11-30' });
    const apiTicket = store.tickets.create(ana, 'api', { title: 'Endpoint', milestone: 'v2' }).ticket;
    const webTicket = store.tickets.create(ben, 'web', { title: 'Secret redesign', milestone: 'launch' }).ticket;
    store.tickets.update(ana, apiTicket.ref, { blockedByAdd: [webTicket.ref] });

    const forAna = store.portfolios.roadmap(ana).find((m) => m.name === 'v2')!;
    assert.equal(forAna.waitsOn[0]!.blockerTitle, 'Secret redesign', 'members of both see it');
    const forDan = store.portfolios.roadmap(dan).find((m) => m.name === 'v2')!;
    assert.equal(forDan.status, 'at_risk', 'it still counts');
    assert.ok(!JSON.stringify(forDan).includes('Secret redesign') && !JSON.stringify(forDan).includes('WEB-') && !JSON.stringify(forDan).includes('launch'), JSON.stringify(forDan));
    const digest = store.portfolios.projectDigest(store.visibleProject(ana, 'api').id);
    assert.ok(!digest.includes('WEB-'), digest);
  });
});

describe('ORCO_TRUST_PROXY (#24)', () => {
  it('takes hop counts and proxy addresses, never "true"', async () => {
    const { trustProxySetting } = await import('../src/commands.js');
    assert.equal(trustProxySetting(undefined), undefined);
    assert.equal(trustProxySetting('1'), 1);
    assert.equal(trustProxySetting('loopback'), 'loopback');
    assert.throws(() => trustProxySetting('true'), /any client's X-Forwarded-For/);
    assert.throws(() => trustProxySetting('*'));
  });
});
