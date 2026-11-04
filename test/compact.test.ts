import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { Store } from '../src/store.js';

let store: Store;
let client: Client;
let stop: () => Promise<void>;

before(async () => {
  store = new Store(openDatabase(':memory:'));
  const carlos = store.createUser('carlos').participant;
  const { token } = store.createAgent('carlos', 'carlos-bot');
  store.createProject(carlos, 'shop');
  store.withoutRateLimit(() => {
    for (let i = 1; i <= 90; i++) {
      store.tickets.create(carlos, 'shop', {
        title: `Restock shelf ${i} with the spring display and the price labels`,
        description: 'A longer description that the list should not carry. '.repeat(8),
        nextStep: i % 3 ? 'Count what is left on the shelf' : undefined,
        priority: 'high',
      });
    }
    for (let i = 0; i < 30; i++) store.tickets.comment(carlos, 'SHO-1', `Update ${i}`);
  });
  const { app, close } = createApp(store);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  stop = async () => {
    await client.close();
    await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
});

after(async () => {
  await stop();
});

const text = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text;

describe('compact MCP replies (#103)', () => {
  it('lists 90 open tickets in under 10 KB, and gives other fields when asked', async () => {
    const compact = await text('list_tickets', { project: 'shop' });
    assert.ok(compact.length < 10_000, `compact list is ${compact.length} bytes`);
    const rows = compact.split('\n').filter((l) => /^SHO-\d+ /.test(l));
    assert.equal(rows.length, 90);
    assert.equal(rows[1], 'SHO-89 [Backlog] Restock shelf 89 with the spring display and the price labels | next: Count what is left on the shelf');
    const asked = JSON.parse(await text('list_tickets', { project: 'shop', fields: 'ref,priority' })).tickets[0];
    assert.deepEqual(asked, { ref: 'SHO-90', priority: 'high' });
  });

  it('get_ticket returns the last 10 activity entries unless asked for more', async () => {
    const t = JSON.parse(await text('get_ticket', { ticket: 'SHO-1' })).ticket;
    assert.equal(t.activity.length, 10);
    assert.equal(t.activity.at(-1).text, 'Update 29');
    const all = JSON.parse(await text('get_ticket', { ticket: 'SHO-1', activity_limit: 100 })).ticket.activity.length;
    assert.ok(all > 30);
    assert.match(t.earlier_activity, new RegExp(`^${all - 10} earlier entries`));
    assert.deepEqual(Object.keys(JSON.parse(await text('get_ticket', { ticket: 'SHO-1', fields: 'ref,handoff' })).ticket), ['ref', 'handoff']);
  });

  it('counts tool use per tool locally, for org admins', async () => {
    await text('get_ticket', { ticket: 'NOPE-1' });
    const carlos = store.participantByName('carlos')!;
    const rows = store.toolUsage.summary(carlos, 7);
    const get = rows.find((r) => r.tool === 'get_ticket')!;
    assert.ok(get.calls >= 4);
    assert.equal(get.errorCodes.not_found, 1);
    assert.ok(rows.find((r) => r.tool === 'list_tickets')!.maxBytes > 1000);
    const bot = store.participantByName('carlos-bot')!;
    assert.throws(() => store.toolUsage.summary(bot), /org admins/);
  });
});
