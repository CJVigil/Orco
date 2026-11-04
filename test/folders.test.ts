import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';

let store: Store;
let carlos: Participant;
let ana: Participant;
let bot: Participant;
let botToken: string;
let carlosToken: string;
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
  const agent = store.createAgent('carlos', 'carlos-bot');
  bot = agent.participant;
  botToken = agent.token;
  store.createProject(carlos, 'ops');
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

describe('folders for tickets (#91)', () => {
  it('groups tickets by folder with open counts, filters by folder, and moves tickets between folders', () => {
    const names = ['Kiosk', 'Floor TV', 'Cloud costs', 'Compliance', 'Role duties', 'Hiring'];
    for (const name of names) store.tickets.createFolder(bot, 'ops', { name, emoji: name === 'Compliance' ? '📋' : null });
    assert.deepEqual(store.tickets.folders(carlos, 'ops').map((f) => f.name), names, 'in the order they were made');
    assert.equal(code(() => store.tickets.createFolder(carlos, 'ops', { name: 'kiosk' })), 'conflict', 'names are unique, any case');
    assert.equal(code(() => store.tickets.createFolder(carlos, 'ops', { name: 'None' })), 'invalid', '"none" means no folder');
    assert.equal(code(() => store.tickets.createFolder(carlos, 'ops', { name: 'x'.repeat(41) })), 'invalid');

    const refs = names.map((folder, i) => store.tickets.create(bot, 'ops', { title: `Ticket ${i}`, folder }).ticket.ref);
    const loose = store.tickets.create(carlos, 'ops', { title: 'No folder yet' }).ticket.ref;
    store.tickets.update(carlos, refs[3]!, { status: 'Done' });
    const extra = store.tickets.create(carlos, 'ops', { title: 'Retention policy', folder: 'compliance' }).ticket;
    assert.deepEqual(extra.folder && { name: extra.folder.name, emoji: extra.folder.emoji }, { name: 'Compliance', emoji: '📋' }, 'matched by name, any case');

    const compliance = store.tickets.folders(carlos, 'ops').find((f) => f.name === 'Compliance')!;
    assert.deepEqual([compliance.open, compliance.total], [1, 2], 'open and total counts');
    assert.deepEqual(store.tickets.list(carlos, { project: 'ops', folder: 'Compliance' }).map((t) => t.ref).sort(), [refs[3], extra.ref].sort());
    assert.deepEqual(store.tickets.list(carlos, { project: 'ops', folder: 'none' }).map((t) => t.ref), [loose]);
    assert.equal(code(() => store.tickets.list(carlos, { project: 'ops', folder: 'Nope' })), 'not_found', 'a folder that does not exist is named');
    assert.equal(code(() => store.tickets.create(bot, 'ops', { title: 'Lost', folder: 'Nope' })), 'not_found');

    const moved = store.tickets.update(bot, refs[0]!, { folder: 'Hiring' }).ticket;
    assert.equal(moved.folder?.name, 'Hiring');
    assert.ok(moved.activity.some((a) => a.kind === 'change' && JSON.stringify(a.detail).includes('"field":"folder","from":"Kiosk","to":"Hiring"')));
    assert.equal(store.tickets.update(bot, refs[0]!, { folder: '' }).ticket.folder, null, 'empty takes it out');
  });

  it('lets agents create folders but only people rename, reorder or remove them', () => {
    const [first] = store.tickets.folders(carlos, 'ops');
    assert.equal(code(() => store.tickets.updateFolder(bot, 'ops', first!.id, { name: 'Kiosks' })), 'forbidden');
    assert.equal(code(() => store.tickets.deleteFolder(bot, 'ops', first!.id)), 'forbidden');
    const renamed = store.tickets.updateFolder(carlos, 'ops', first!.id, { name: 'Kiosks', emoji: '🖥️', position: 2 });
    assert.deepEqual([renamed.name, renamed.emoji, renamed.position], ['Kiosks', '🖥️', 2]);
    const inHiring = store.tickets.list(carlos, { project: 'ops', folder: 'Hiring' }).map((t) => t.ref);
    const hiring = store.tickets.folders(carlos, 'ops').find((f) => f.name === 'Hiring')!;
    store.tickets.deleteFolder(carlos, 'ops', hiring.id);
    assert.ok(!store.tickets.folders(carlos, 'ops').some((f) => f.name === 'Hiring'));
    for (const ref of inHiring) assert.equal(store.tickets.get(carlos, ref).folder, null, 'its tickets stay, in no folder');
    const actions = store.audit.list(carlos, { limit: 500 }).map((e) => e.action);
    for (const action of ['folder.create', 'folder.update', 'folder.delete']) assert.ok(actions.includes(action), action);
    assert.equal(code(() => store.tickets.folders(ana, 'ops')), 'not_found', 'only people who can see the project');
    assert.ok(store.tickets.plan(carlos, 'ops').folders.length > 0, 'the plan carries folders');
  });

  it('works over MCP and REST', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${botToken}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { text: string }[])[0]!.text;
      assert.equal(result.isError ?? false, false, text);
      return text;
    };
    assert.match(await call('create_folder', { project: 'ops', name: 'Vendors', emoji: '🚚' }), /Folder Vendors is ready/);
    const folders = JSON.parse(await call('list_folders', { project: 'ops' })).folders as { name: string; open: number }[];
    assert.ok(folders.some((f) => f.name === 'Vendors'));
    const created = await call('create_ticket', { project: 'ops', title: 'Renew the SOC 2 report', folder: 'Compliance' });
    const ref = /OPS-\d+/.exec(created)![0];
    const listed = JSON.parse(await call('list_tickets', { project: 'ops', folder: 'Compliance', include_closed: true, fields: 'ref,folder' })).tickets as { ref: string; folder: string }[];
    assert.ok(listed.length >= 2 && listed.every((t) => t.folder === 'Compliance'), 'only that folder');
    assert.ok(listed.some((t) => t.ref === ref));
    await call('update_ticket', { ticket: ref, folder: 'Vendors' });
    assert.equal(store.tickets.get(carlos, ref).folder?.name, 'Vendors', 'moved through MCP');
    await client.close();

    const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
    const list = await fetch(`${base}/api/projects/ops/folders`, { headers: headers(carlosToken) });
    assert.equal(list.status, 200);
    const vendors = ((await list.json()) as { id: number; name: string }[]).find((f) => f.name === 'Vendors')!;
    const denied = await fetch(`${base}/api/projects/ops/folders/${vendors.id}`, { method: 'DELETE', headers: headers(botToken) });
    assert.equal(denied.status, 403, 'agents do not remove folders');
    const made = await fetch(`${base}/api/projects/ops/folders`, { method: 'POST', headers: headers(carlosToken), body: JSON.stringify({ name: 'Budget', color: '#0090ff' }) });
    assert.equal(made.status, 201);
    const byQuery = await fetch(`${base}/api/tickets?project=ops&folder=Vendors`, { headers: headers(carlosToken) });
    assert.deepEqual(((await byQuery.json()) as { ref: string }[]).map((t) => t.ref), [ref]);
  });
});
