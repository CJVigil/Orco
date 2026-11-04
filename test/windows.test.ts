import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { myWork } from '../src/work.js';
import { type OrcoError, Store } from '../src/store.js';
import { localTime, parseWindow } from '../src/windows.js';

process.env.ORCO_TIMEZONE = 'UTC';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return `${(err as OrcoError).code}: ${(err as OrcoError).message}`;
  }
  return 'ok';
};

function setup(at: number) {
  let clock = at;
  const store = new Store(openDatabase(':memory:'), { now: () => clock });
  const carlos = store.createUser('carlos').participant;
  const bot = store.createAgent('carlos', 'carlos-bot').participant;
  store.createProject(carlos, 'shop');
  return { store, carlos, bot, tick: (ms: number) => (clock += ms) };
}

// Wednesday 2026-11-04, 10:00 UTC.
const WED_10 = Date.UTC(2026, 10, 4, 10);

describe('deploy windows and freezes (#112)', () => {
  it('reads windows like "Mon-Fri 06:00-17:00"', () => {
    const w = parseWindow('Mon-Fri 06:00-17:00');
    assert.deepEqual([...w.days].sort(), [1, 2, 3, 4, 5]);
    assert.deepEqual([w.from, w.to], [360, 1020]);
    assert.deepEqual(localTime(WED_10, 'UTC'), { day: 3, minute: 600 });
    assert.throws(() => parseWindow('whenever'), /Wed 13:00-17:00/);
  });

  it('refuses a push during a freeze with its reason, and shows it in my_work', () => {
    const { store, carlos, bot } = setup(WED_10);
    store.windows.freeze(carlos, { project: 'shop', reason: 'Release weekend', until: '2026-11-09T08:00:00Z' });
    assert.match(code(() => store.approvals.request(bot, { room: 'shop/general', summary: 'Push the hotfix to main' })), /^conflict: Deploys and pushes are frozen until 2026-11-09T08:00:00.000Z \(carlos: Release weekend\)/);
    assert.ok(store.approvals.request(bot, { room: 'shop/general', summary: 'Rotate the log files' }), 'other approvals are fine');
    assert.equal(myWork(store, bot).freezes[0]!.reason, 'Release weekend');
    const overridden = store.approvals.request(carlos, { room: 'shop/general', summary: 'Deploy the fix', override: 'Checkout is down' });
    assert.match(overridden.warning ?? '', /override by carlos: Checkout is down/);
  });

  it('flags a deploy outside the window for the approver, or refuses it when the window says so', () => {
    const { store, carlos, bot, tick } = setup(WED_10);
    store.windows.addWindow(carlos, { project: 'shop', spec: 'Wed 13:00-17:00', mode: 'allow' });
    const flagged = store.approvals.request(bot, { room: 'shop/general', summary: 'Deploy v2.3 to production' });
    assert.equal(flagged.warning, 'Outside the deploy window (Wed 13:00-17:00)');
    tick(4 * 3600_000); // 14:00
    assert.equal(store.approvals.request(bot, { room: 'shop/general', summary: 'Deploy v2.4 to production' }).warning, null);
    store.windows.addWindow(carlos, { project: 'shop', spec: 'Mon-Fri 14:00-15:00', mode: 'deny', refuse: true });
    assert.match(code(() => store.approvals.request(bot, { room: 'shop/general', summary: 'Deploy v2.5' })), /^conflict: Not now: this is inside the no-deploy window Mon-Fri 14:00-15:00/);
  });
});
