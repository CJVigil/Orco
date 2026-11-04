import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { at, basePath, normalizeBase } from '../src/basepath.js';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { validPublicUrl } from '../src/oauth.js';
import { Store } from '../src/store.js';

let base: string;
let token: string;
let stop: () => Promise<void>;

before(async () => {
  process.env.ORCO_BASE_PATH = '/orco/';
  const store = new Store(openDatabase(':memory:'));
  token = store.createUser('carlos').token;
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
  delete process.env.ORCO_BASE_PATH;
  await stop();
});

describe('serving under a sub-path (#142)', () => {
  it('normalizes the prefix and builds paths under it', () => {
    assert.equal(normalizeBase(undefined), '/');
    assert.equal(normalizeBase('orco'), '/orco/');
    assert.equal(normalizeBase('/apps/orco//'), '/apps/orco/');
    assert.throws(() => normalizeBase('/a b/'));
    assert.equal(basePath(), '/orco/');
    assert.equal(at('oauth/consent'), '/orco/oauth/consent');
    assert.equal(validPublicUrl('https://inventory.bful.net/orco'), 'https://inventory.bful.net/orco');
    assert.throws(() => validPublicUrl('https://inventory.bful.net/other'), /ORCO_BASE_PATH/);
  });

  it('writes the prefix into redirects and cookie paths, while routes stay at the root', async () => {
    const link = await fetch(`${base}/new?project=shop&title=x`, { redirect: 'manual' });
    assert.equal(link.headers.get('location'), '/orco/#!new?project=shop&title=x');
    const signin = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token }) });
    assert.equal(signin.status, 200);
    assert.match(signin.headers.get('set-cookie') ?? '', /Path=\/orco\//);
    assert.equal((await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  });
});
