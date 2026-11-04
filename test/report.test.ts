import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { dayReport, reportMarkdown, runReports, scheduleReport } from '../src/report.js';
import { Store } from '../src/store.js';

describe('"what got done" reports (#116)', () => {
  it('counts real events only, and lists done, going live, waiting and new requests', () => {
    // Ticket times come from the database's clock, so this one runs on real time.
    const store = new Store(openDatabase(':memory:'));
    const carlos = store.createUser('carlos').participant;
    store.createUser('ana');
    const bot = store.createAgent('carlos', 'carlos-bot').participant;
    store.createProject(carlos, 'shop');
    store.addMember(carlos, 'shop', 'ana');
    store.tickets.createFolder(carlos, 'shop', { name: 'Kiosk' });
    const old = store.tickets.create(carlos, 'shop', { title: 'Old ticket' }).ticket;
    store.db.prepare("UPDATE tickets SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(old.id);
    store.db.prepare("UPDATE ticket_activity SET created_at = '2020-01-01T00:00:00.000Z' WHERE ticket_id = ?").run(old.id);
    const day = { from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 3600_000).toISOString() };
    const fixed = store.tickets.create(carlos, 'shop', { title: 'Printer jams on long receipts', folder: 'Kiosk' }).ticket;
    store.tickets.update(bot, fixed.ref, { status: 'Done' });
    const review = store.tickets.create(carlos, 'shop', { title: 'New price sheet', folder: 'Kiosk' }).ticket;
    store.tickets.update(bot, review.ref, { status: 'In Review' });
    store.approvals.request(bot, { ticket: review.ref, summary: 'Deploy the new price sheet' });
    const ask = store.tickets.create(carlos, 'shop', { title: 'Open port 443', waitingOn: 'ana', waitingAsk: 'Open 443 on the staging firewall' }).ticket;
    const quiet = dayReport(store, carlos, { project: 'shop', ...day });
    // Housekeeping: the old ticket filed into a folder and relabelled is not work.
    store.tickets.update(carlos, old.ref, { folder: 'Kiosk', priority: 'low' });
    const r = dayReport(store, carlos, { project: 'shop', ...day });
    assert.equal(r.counts.events, quiet.counts.events, 'a folder sort does not count');
    assert.deepEqual(r.counts, { done: 1, goingLive: 1, waiting: 1, newRequests: 3, events: r.counts.events });
    assert.equal(r.done[0]!.title, 'Printer jams on long receipts');
    assert.match(r.goingLive[0]!.approval, /^waiting for approval: Deploy the new price sheet/);
    assert.deepEqual([r.waiting[0]!.on, r.waiting[0]!.ask], ['ana', 'Open 443 on the staging firewall']);
    assert.ok(r.timeline.some((e) => e.text === 'Printer jams on long receipts: Done (carlos-bot)'));
    assert.deepEqual(r.openByFolder, [{ folder: 'Kiosk', open: 2 }, { folder: 'No folder', open: 1 }]);
    assert.match(reportMarkdown(r), /Done 1 · Going live next 1 · Waiting on a person 1 · New requests 3/);
    assert.ok(ask);
  });

  it('posts a scheduled report into the project room, naming its people', () => {
    let clock = Date.UTC(2026, 10, 6, 15, 59); // Friday
    const store = new Store(openDatabase(':memory:'), { now: () => clock });
    const carlos = store.createUser('carlos').participant;
    store.createProject(carlos, 'shop');
    scheduleReport(store, carlos, 'shop', { cron: '0 16 * * 5', people: ['carlos'] });
    assert.equal(runReports(store), 0);
    clock += 2 * 60_000;
    assert.equal(runReports(store), 1);
    const posted = store.messagesAfter(carlos, 0, 10).find((m) => m.author === 'orco');
    assert.match(posted?.text ?? '', /^@carlos\n\*\*What got done · shop/);
    assert.equal(runReports(store), 0, 'once per time');
  });
});
