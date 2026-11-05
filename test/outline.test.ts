import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';

// A fake Outline: the API methods Orco uses, with an API key it checks.
const docs = new Map<string, { id: string; title: string; text: string; collectionId: string; url: string }>([
  ['AbC123xyz9', { id: 'AbC123xyz9', title: 'Returns SOP', text: '# Returns\n\nRefunds over $200 need a manager.', collectionId: 'col-ops', url: '/doc/returns-sop-AbC123xyz9' }],
]);
let server: Server;
let base = '';
let calls: string[] = [];

describe('Outline, the company wiki (#145)', () => {
  let store: Store;
  let ana: Participant;
  let bot: Participant;
  before(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const json = (data: unknown, status = 200) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data }));
        };
        if (req.headers.authorization !== 'Bearer ol_key') return json(null, 401);
        const body = JSON.parse(raw || '{}');
        const method = req.url!.replace('/api/', '');
        calls.push(method);
        if (method === 'documents.search') return json([...docs.values()].filter((d) => d.text.toLowerCase().includes(String(body.query).toLowerCase())).map((d) => ({ context: `…<b>${body.query}</b>…`, document: d })));
        if (method === 'documents.info') return docs.has(body.id) ? json(docs.get(body.id)) : json(null, 404);
        if (method === 'collections.list') return json([{ id: 'col-ops', name: 'Operations' }]);
        if (method === 'documents.create') {
          const id = `New${docs.size}abcdef`;
          const doc = { id, title: body.title, text: body.text, collectionId: body.collectionId, url: `/doc/${id}` };
          docs.set(id, doc);
          return json(doc);
        }
        json(null, 404);
      });
    });
    server.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    store = new Store(openDatabase(':memory:'), { secretsKey: randomBytes(32) });
    ana = store.createUser('ana').participant;
    bot = store.createAgent('ana', 'ana-bot').participant;
    store.createProject(ana, 'shop');
  });
  after(() => new Promise((r) => server.close(r)));

  it('only org admins connect it, and the key is never shown back', () => {
    assert.throws(() => store.outline.save(bot, { baseUrl: base, apiKey: 'x' }), (e: OrcoError) => e.code === 'forbidden');
    const s = store.outline.save(ana, { baseUrl: `${base}/api`, apiKey: 'ol_key' });
    assert.equal(s.baseUrl, base);
    assert.equal(JSON.stringify(s).includes('ol_key'), false);
    assert.equal(store.outline.enabled, true);
  });

  it('searches, reads and previews with the server key', async () => {
    const hits = await store.outline.search(bot, 'refunds');
    assert.equal(hits[0]!.title, 'Returns SOP');
    assert.equal(hits[0]!.url, `${base}/doc/returns-sop-AbC123xyz9`);
    const doc = await store.outline.read(bot, `${base}/doc/returns-sop-AbC123xyz9`);
    assert.match(doc.text, /manager/);
    const p = await store.outline.preview(ana, `${base}/doc/returns-sop-AbC123xyz9`);
    assert.equal(p?.title, 'Returns SOP');
    assert.match(p!.summary, /Refunds over \$200/);
    assert.equal(await store.outline.preview(ana, 'https://elsewhere.example/doc/x-AbC123xyz9'), null, 'links to other sites are not fetched');
  });

  it('a person publishes a ticket at once, linked back', async () => {
    const { ticket } = store.tickets.create(ana, 'shop', { title: 'Returns: new refund rule', description: 'Refunds over $200 need a manager from now on.' });
    const r = await store.outline.publish(ana, { ticket: ticket.ref, collection: 'col-ops' });
    assert.match(r.url!, /\/doc\/New/);
    assert.ok(store.tickets.get(ana, ticket.ref).activity.some((a) => a.kind === 'comment' && /Published to Outline/.test(a.body ?? '')));
  });

  it("an agent's publish waits for a person, even under Full access, then publishes", async () => {
    const { ticket } = store.tickets.create(ana, 'shop', { title: 'Ops: weekly report', description: 'All good this week.' });
    store.modes.setTicket(ana, ticket.ref, 'full');
    calls = [];
    const r = await store.outline.publish(bot, { ticket: ticket.ref, collection: 'col-ops' });
    assert.ok(r.pending);
    assert.equal(calls.includes('documents.create'), false, 'nothing published yet');
    store.approvals.decide(ana, r.pending!.approvalId, 'approved');
    for (let i = 0; i < 50 && !calls.includes('documents.create'); i++) await new Promise((res) => setTimeout(res, 20));
    assert.ok(calls.includes('documents.create'));
  });
});
