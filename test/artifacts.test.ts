import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';

let store: Store;
let carlos: Participant;
let carlosToken: string;
let ana: Participant;
let bot: Participant;
let base: string;
let stop: () => Promise<void>;

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as OrcoError).code;
  }
  return 'ok';
};

before(async () => {
  store = new Store(openDatabase(':memory:'));
  const made = store.createUser('carlos');
  carlos = made.participant;
  carlosToken = made.token;
  ana = store.createUser('ana').participant;
  bot = store.createAgent('carlos', 'carlos-bot').participant;
  store.createProject(carlos, 'shop');
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

describe('shared artifacts (#99)', () => {
  it('publishes onto a ticket, keeps old versions, and renders sandboxed without network', async () => {
    const { ticket } = store.tickets.create(carlos, 'shop', { title: 'Kiosk uptime' });
    const a = store.artifacts.publish(bot, { ticket: ticket.ref, title: 'Uptime', content: '<h1>v1</h1><script>fetch("/api/me")</script>' });
    const b = store.artifacts.publish(bot, { id: a.id, content: '<h1>v2</h1>' });
    assert.equal(b.version, 2);
    assert.equal(store.artifacts.content(carlos, a.id, 1).content.includes('v1'), true, 'the old version stays');
    assert.deepEqual(store.tickets.get(carlos, ticket.ref).artifacts.map((x) => x.title), ['Uptime']);
    assert.deepEqual(store.artifacts.list(carlos, { project: 'shop' }).map((x) => x.id), [a.id]);
    const res = await fetch(`${base}/api/artifacts/${a.id}/render?v=1`, { headers: { authorization: `Bearer ${carlosToken}` } });
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /^sandbox allow-scripts/);
    assert.ok(!csp.includes('allow-same-origin'), 'never the same origin as Orco');
    assert.match(csp, /connect-src 'none'/);
    assert.match(await res.text(), /color-scheme/, 'follows the light or dark theme');
  });

  it('draws charts, checks their shape, and follows private tickets', () => {
    const chart = store.artifacts.publish(bot, { project: 'shop', title: 'Sales', kind: 'chart', content: JSON.stringify({ type: 'bar', labels: ['Mon', 'Tue'], series: [{ name: 'Units', values: [3, 5] }] }) });
    assert.equal(chart.kind, 'chart');
    assert.equal(code(() => store.artifacts.publish(bot, { project: 'shop', title: 'Bad', kind: 'chart', content: '{"type":"pie"}' })), 'invalid');
    store.addMember(carlos, 'shop', 'ana');
    const { ticket } = store.tickets.create(carlos, 'shop', { title: 'Pay review', private: true });
    const hidden = store.artifacts.publish(carlos, { ticket: ticket.ref, title: 'Pay table', kind: 'markdown', content: '| a | b |' });
    assert.equal(code(() => store.artifacts.get(ana, hidden.id)), 'not_found');
    assert.ok(!store.artifacts.list(ana, { project: 'shop' }).some((x) => x.id === hidden.id));
    assert.equal(code(() => store.artifacts.remove(bot, hidden.id)), 'forbidden', 'agents do not delete');
    store.artifacts.remove(carlos, hidden.id);
    assert.equal(code(() => store.artifacts.get(carlos, hidden.id)), 'not_found');
  });
});
