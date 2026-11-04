import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { OrcoError, Store } from '../src/store.js';
import { READ_ONLY_TOOLS, restArea, TOOLS } from '../src/tooltable.js';

describe('what agents may do (#131)', () => {
  it('every tool in src/mcp.ts has an entry in the table, and nothing extra', () => {
    const source = readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8');
    const registered = [...source.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]!);
    assert.ok(registered.length > 70);
    assert.deepEqual(registered.filter((n) => !TOOLS[n]), []);
    assert.deepEqual(Object.keys(TOOLS).filter((n) => !registered.includes(n)), []);
    assert.ok(READ_ONLY_TOOLS.has('get_ticket') && !READ_ONLY_TOOLS.has('post'));
  });

  it('sorts REST writes into areas, and closes unknown writes', () => {
    assert.equal(restArea('GET', '/tickets/API-1'), 'read');
    assert.equal(restArea('POST', '/messages'), 'post');
    assert.equal(restArea('PATCH', '/tickets/API-1'), 'tickets');
    assert.equal(restArea('POST', '/tasks'), 'tasks');
    assert.equal(restArea('POST', '/tasks/4/progress'), 'self');
    assert.equal(restArea('POST', '/something-new'), 'all');
  });

  describe('a Read-only agent', () => {
    let store: Store;
    let baseUrl = '';
    let close = async () => {};
    const tokens: Record<string, string> = {};
    before(async () => {
      store = new Store(openDatabase(':memory:'));
      const ana = store.createUser('ana');
      tokens.ana = ana.token;
      tokens.watcher = store.createAgent('ana', 'watcher').token;
      tokens.worker = store.createAgent('ana', 'worker').token;
      store.createProject(ana.participant, 'api');
      store.toolLevels.set(ana.participant, 'watcher', 'read_only');
      const { app, close: closeApp } = createApp(store);
      const server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      close = async () => {
        await closeApp();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      };
    });
    after(() => close());

    const tools = async (name: string) => {
      const client = new Client({ name: `t-${name}`, version: '0' }, { versionNegotiation: { mode: 'legacy' } });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens[name]}` } } }));
      const list = (await client.listTools()).tools.map((t) => t.name);
      await client.close();
      return list;
    };

    it('gets no write tools', async () => {
      const list = await tools('watcher');
      assert.ok(list.includes('get_ticket') && list.includes('read'));
      assert.deepEqual(list.filter((n) => !READ_ONLY_TOOLS.has(n)), []);
      assert.ok((await tools('worker')).includes('post'));
    });

    it('is refused a REST write with its token, and may still read', async () => {
      const post = await fetch(`${baseUrl}/api/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.watcher}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: 'api/general', text: 'hello' }),
      });
      assert.equal(post.status, 403);
      assert.match(((await post.json()) as { error: string }).error, /Read only/);
      const read = await fetch(`${baseUrl}/api/messages?room=api%2Fgeneral`, { headers: { Authorization: `Bearer ${tokens.watcher}` } });
      assert.equal(read.status, 200);
    });

    it('only people set levels, and the org cap narrows everyone', () => {
      const worker = store.participantByName('worker')!;
      assert.throws(() => store.toolLevels.set(worker, 'watcher', 'full'), (e: OrcoError) => e.code === 'forbidden');
      const ana = store.participantByName('ana')!;
      store.toolLevels.setCap(ana, 'comment');
      assert.deepEqual(store.toolLevels.access(worker).areas, ['read', 'self', 'post']);
      store.toolLevels.setCap(ana, null);
      assert.equal(store.toolLevels.access(worker).areas.length, 8);
      assert.equal(store.capabilities(store.participantByName('watcher')!).toolAccess?.level, 'read_only');
    });
  });
});
