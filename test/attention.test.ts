import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { openDatabase } from '../src/db.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';

let store: Store;
let clock: number;
let ana: Participant;
let bot: Participant;

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as OrcoError).code;
  }
  return 'ok';
};

beforeEach(() => {
  clock = Date.parse('2026-11-04T08:00:00Z'); // a Wednesday
  store = new Store(openDatabase(':memory:'), { now: () => clock });
  ana = store.createUser('ana').participant;
  bot = store.createAgent('ana', 'ana-bot').participant;
  store.createProject(ana, 'ops');
});

describe('daily digest (#88)', () => {
  it('sends three bullets and "+N more" at the chosen time on weekdays, and nothing when nothing waits', () => {
    store.attention.update(ana, { digestTime: '09:00', tz: 'Europe/Berlin' });
    assert.equal(store.attention.sendDue(), 0, 'nothing waits: nothing sent');
    store.db.prepare('UPDATE participants SET digest_last = NULL WHERE id = ?').run(ana.id);
    for (let i = 0; i < 7; i++) store.approvals.request(bot, { room: 'ops/general', summary: `Deploy ${i}` });
    // The approvals reach my_work through questions and asks; use asks on tickets for seven waiting items.
    for (let i = 0; i < 7; i++) store.tickets.create(ana, 'ops', { title: `Ask ${i}`, waitingOn: 'ana', waitingAsk: `Check thing ${i}` });
    const digest = store.attention.digest(ana);
    assert.equal(digest.bullets.length, 3);
    assert.ok(digest.more >= 4);
    clock = Date.parse('2026-11-04T07:30:00Z'); // 08:30 in Berlin: too early
    assert.equal(store.attention.sendDue(), 0);
    clock = Date.parse('2026-11-04T08:05:00Z'); // 09:05 in Berlin
    const events: unknown[] = [];
    store.events.on('digest', (e) => events.push(e));
    assert.equal(store.attention.sendDue(), 1);
    assert.equal(store.attention.sendDue(), 0, 'once a day');
    assert.equal(events.length, 1);
    assert.equal(store.attention.latest(ana)?.bullets.length, 3);
    clock = Date.parse('2026-11-07T08:05:00Z'); // Saturday
    assert.equal(store.attention.sendDue(), 0, 'weekdays only');
  });
});

describe('calmer attention (#89)', () => {
  it('validates settings, snoozes items and marks mentions read one by one', () => {
    assert.equal(code(() => store.attention.update(ana, { quietStart: '22:00' })), 'invalid', 'a start needs an end');
    assert.equal(code(() => store.attention.update(ana, { tz: 'Mars/Base' })), 'invalid');
    assert.equal(code(() => store.attention.update(bot, { notifyLevel: 'all' })), 'forbidden');
    assert.equal(store.attention.update(ana, { notifyLevel: 'all', quietStart: '22:00', quietEnd: '07:00' }).quietEnd, '07:00');
    store.attention.snooze(ana, 'approval-3', new Date(clock + 3600_000).toISOString());
    assert.deepEqual(Object.keys(store.attention.snoozes(ana)), ['approval-3']);
    clock += 2 * 3600_000;
    assert.deepEqual(store.attention.snoozes(ana), {}, 'over after its time');
    const [a, b] = [store.post(bot, 'ops/general', '@ana one'), store.post(bot, 'ops/general', '@ana two')];
    store.attention.markSeen(ana, a.id);
    const seen = Object.fromEntries(store.recentMentions(ana).map((m) => [m.id, m.seen]));
    assert.deepEqual([seen[a.id], seen[b.id]], [true, false], 'only the opened one is read');
  });

  it('batches agent updates into one notification, and shows approvals at once', async () => {
    const shown: string[] = [];
    const globals = globalThis as unknown as Record<string, unknown>;
    class FakeNotification {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string) {
        shown.push(title);
      }
    }
    globals.window = { Notification: FakeNotification };
    globals.Notification = FakeNotification;
    globals.localStorage = { getItem: () => 'on', setItem: () => {} };
    globals.document = { visibilityState: 'hidden', hasFocus: () => false };
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const notify = await import('../web/notify.js');
      notify.configure({ notifyLevel: 'needs_me', quietStart: null, quietEnd: null, tz: 'UTC' }, () => {});
      for (let i = 0; i < 10; i++) notify.offer('agent', { title: `Update ${i}`, body: 'x', tag: `m${i}`, hash: '' }, () => {});
      notify.offer('mention', { title: 'Plain mention from a person', body: 'x', tag: 'p', hash: '' }, () => {});
      notify.offer('needs', { title: 'Approve the deploy', body: 'x', tag: 'a', hash: '' }, () => {});
      await Promise.resolve();
      assert.deepEqual(shown, ['Approve the deploy'], 'approvals at once; plain mentions not on "Only what needs me"');
      mock.timers.tick(10 * 60_000);
      await Promise.resolve();
      assert.deepEqual(shown, ['Approve the deploy', '10 updates from agents'], 'ten agent posts: one notification');
    } finally {
      mock.timers.reset();
      for (const key of ['window', 'Notification', 'localStorage', 'document']) delete globals[key];
    }
  });
});
