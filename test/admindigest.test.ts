import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adminDigest } from '../src/admindigest.js';
import { openDatabase } from '../src/db.js';
import { type OrcoError, Store } from '../src/store.js';

process.env.ORCO_TIMEZONE = 'UTC';

describe('the admin digest (#115)', () => {
  it("lists last week's approved deploys with their approvers, overrides with reasons, and is written each Monday", () => {
    let clock = Date.UTC(2026, 10, 4, 10); // Wednesday
    const store = new Store(openDatabase(':memory:'), { now: () => clock });
    const carlos = store.createUser('carlos').participant; // org admin
    const ana = store.createUser('ana').participant;
    const bot = store.createAgent('carlos', 'carlos-bot').participant;
    store.createProject(carlos, 'shop');
    store.addMember(carlos, 'shop', 'ana');
    const deploy = store.approvals.request(bot, { room: 'shop/general', summary: 'Deploy v2.3 to production' });
    store.approvals.decide(carlos, deploy.id, 'approved');
    store.windows.freeze(carlos, { project: 'shop', reason: 'Release weekend', until: '2026-11-08T00:00:00Z' });
    store.approvals.request(carlos, { room: 'shop/general', summary: 'Push the checkout fix', override: 'Checkout is down' });
    const digest = adminDigest(store, carlos, { from: '2026-11-02T00:00:00Z', to: '2026-11-09T00:00:00Z' });
    const section = (title: string) => digest.sections.find((s) => s.title === title)!.lines.map((l) => l.text);
    assert.deepEqual(section('Deploys and pushes approved'), ['carlos approved carlos-bot\'s "Deploy v2.3 to production"']);
    assert.deepEqual(section('Checked rules and overrides'), ['carlos overrode a freeze: Checkout is down']);
    assert.match(digest.markdown, /\(audit #\d+\)/, 'each line names its audit entry');
    assert.throws(() => adminDigest(store, ana, { from: '2026-11-02', to: '2026-11-09' }), (err: OrcoError) => err.code === 'forbidden');
    assert.throws(() => adminDigest(store, bot, { from: '2026-11-02', to: '2026-11-09' }), (err: OrcoError) => err.code === 'forbidden');
    // Monday 9:00 UTC: the weekly digests, and the admin one for the week before.
    clock = Date.UTC(2026, 10, 9, 9, 5);
    store.portfolios.runDue({ cron: '0 9 * * 1', tz: 'UTC' });
    const kept = store.db.prepare('SELECT body FROM admin_digests').all() as { body: string }[];
    assert.equal(kept.length, 1);
    assert.match(kept[0]!.body, /carlos approved carlos-bot's "Deploy v2.3 to production"/);
  });
});
