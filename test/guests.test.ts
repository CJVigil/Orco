import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { type Participant, Store } from '../src/store.js';

let store: Store;
let carlos: Participant;
let base: string;
let stop: () => Promise<void>;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  store = new Store(openDatabase(':memory:'));
  carlos = store.createUser('carlos').participant;
  store.createAgent('carlos', 'carlos-bot');
  store.createProject(carlos, 'floor');
  const { app, close } = createApp(store);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stop = async () => {
    await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
});

after(async () => {
  await stop();
});

describe('guest links (#117)', () => {
  it('shows one ticket to one browser, and a guest question reaches the agent only after Send', async () => {
    const { ticket } = store.tickets.create(carlos, 'floor', { title: 'Restock aisle 4', assignee: 'carlos-bot' });
    store.tickets.create(carlos, 'floor', { title: 'Secret other ticket' });
    store.tickets.comment(carlos, ticket.ref, 'Truck arrives at 2');
    const link = store.guests.share(carlos, ticket.ref, base);
    const token = new URL(link.url).hash.slice(1);
    const first = await fetch(`${base}/guest-api/${token}`);
    assert.equal(first.status, 200);
    const cookie = first.headers.get('set-cookie')!.split(';')[0]!;
    const view = (await first.json()) as { title: string; comments: { text: string }[] };
    assert.equal(view.title, 'Restock aisle 4');
    assert.deepEqual(view.comments.map((c) => c.text), ['Truck arrives at 2']);
    assert.ok(!JSON.stringify(view).includes('Secret other ticket'), 'nothing else in the project');
    assert.equal((await fetch(`${base}/guest-api/${token}`)).status, 403, 'another browser is refused');
    const asked = await fetch(`${base}/guest-api/${token}/requests`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Which bin is it in?', photo: `data:image/png;base64,${PNG.toString('base64')}` }),
    });
    assert.equal(asked.status, 201);
    const request = (await asked.json()) as { id: number; state: string; hasPhoto: boolean };
    assert.deepEqual([request.state, request.hasPhoto], ['pending', true]);
    const room = store.tickets.workRoom(ticket.projectId);
    const before = store.messagesAfter(carlos, 0, 200).filter((m) => m.text.includes('Which bin')).length;
    assert.equal(before, 0, 'the agent hears nothing yet');
    store.guests.decide(carlos, request.id, true);
    const told = store.messagesAfter(carlos, 0, 200).find((m) => m.room === room && m.text.startsWith('@carlos-bot A guest following FLO-1 asks: Which bin is it in?'));
    assert.ok(told, 'Send tells the agent');
    const t = store.tickets.get(carlos, ticket.ref);
    assert.equal(t.activity.at(-1)?.body, 'Guest asks: Which bin is it in?');
    assert.equal(t.files.length, 1, 'the photo goes on the ticket');
    // Stop sharing ends the link.
    store.guests.stop(carlos, ticket.ref);
    assert.equal((await fetch(`${base}/guest-api/${token}`, { headers: { cookie } })).status, 404);
  });
});
