import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { Store } from '../src/store.js';
import { titleIssue } from '../src/titles.js';

describe('plain ticket titles (#139)', () => {
  it('names the rule a title breaks', () => {
    assert.match(titleIssue('fix(race): stockSvc.ts null guard')!, /file paths|plain words/);
    assert.match(titleIssue('Inventory: fix the stockSvc null guard')!, /camelCase/);
    assert.match(titleIssue('Inventory: tidy up load_stock_rows')!, /snake_case/);
    assert.match(titleIssue('refunds post twice')!, /Start with the area/);
    assert.match(titleIssue(`Checkout: ${'very '.repeat(20)}long`)!, /at most 70/);
    assert.equal(titleIssue('Checkout: refunds post twice'), null);
    assert.match(titleIssue('Checkout: move Project Falcon over', { pattern: 'area_outcome', maxLength: 70, avoidPaths: true, avoidIdentifiers: true, codeNames: ['Project Falcon'] })!, /internal name/);
  });

  it('files the ticket anyway, notes it, and the filter lists it', () => {
    const store = new Store(openDatabase(':memory:'));
    const ana = store.createUser('ana').participant;
    store.createProject(ana, 'shop');
    const { ticket } = store.tickets.create(ana, 'shop', { title: 'fix(race): stockSvc.ts null guard' });
    store.tickets.create(ana, 'shop', { title: 'Stock: counts go negative after a race' });
    assert.ok(ticket.ref);
    const flagged = store.tickets.list(ana, { project: 'shop', needsPlainTitle: true });
    assert.deepEqual(flagged.map((t) => t.ref), [ticket.ref]);
    store.titleRules.set(ana, 'shop', { pattern: 'none', avoidPaths: false, avoidIdentifiers: false });
    assert.equal(store.tickets.list(ana, { project: 'shop', needsPlainTitle: true }).length, 0);
    assert.equal(store.tickets.plan(ana, 'shop').titleRules.pattern, 'none');
  });
});

describe('an agent filing a code-style title (#139)', () => {
  it('gets title_note from create_ticket', async () => {
    const { createApp } = await import('../src/http.js');
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    const store = new Store(openDatabase(':memory:'));
    const ana = store.createUser('ana').participant;
    const { token } = store.createAgent('ana', 'ana-bot');
    store.createProject(ana, 'shop');
    const { app, close } = createApp(store);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    const client = new Client({ name: 't', version: '0' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const result = (await client.callTool({ name: 'create_ticket', arguments: { project: 'shop', title: 'fix(race): stockSvc.ts null guard' } })) as { content: { text: string }[] };
    const body = JSON.parse(result.content[0]!.text) as { title_note?: string; ticket: { ref: string } };
    assert.match(body.title_note ?? '', /Title rule: .*file paths/);
    assert.ok(body.ticket.ref);
    await client.close();
    await close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
});
