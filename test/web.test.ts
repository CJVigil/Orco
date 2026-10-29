import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { Presence } from '../src/presence.js';
import { Store } from '../src/store.js';

let baseUrl: string;
let closeServer: () => Promise<void>;
let store: Store;
const tokens: Record<string, string> = {};

before(async () => {
  store = new Store(openDatabase(':memory:'));
  tokens.ana = store.createUser('ana').token;
  tokens.ben = store.createUser('ben').token;
  tokens['ana-claude'] = store.createAgent('ana', 'ana-claude').token;
  const { app, close } = createApp(store);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = async () => {
    await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
});

after(async () => {
  await closeServer();
});

async function login(name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tokens[name] }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie') ?? '';
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  return cookie.split(';')[0]!;
}

async function readEvents(cookie: string, until: (event: string) => boolean, during: () => Promise<void>) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: any }[] = [];
  let buffer = '';
  let started = false;
  while (!events.some((e) => until(e.event))) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (event && data) events.push({ event, data: JSON.parse(data) });
    }
    if (!started && events.some((e) => e.event === 'ready')) {
      started = true;
      await during();
    }
  }
  controller.abort();
  return events;
}

describe('web session', () => {
  it('rejects agent tokens and bad tokens at login', async () => {
    for (const token of [tokens['ana-claude'], 'orco_u_wrong']) {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      assert.equal(res.status, 401);
    }
  });

  it('authenticates later requests with the session cookie', async () => {
    const cookie = await login('ana');
    const res = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } });
    assert.deepEqual(await res.json(), { name: 'ana', kind: 'user', owner: null });
  });

  it('refuses cookie-authenticated writes that are not same-origin JSON', async () => {
    const cookie = await login('ana');
    const form = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'room=lobby&text=hi',
    });
    assert.equal(form.status, 403);
    const crossSite = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ room: 'lobby', text: 'hi' }),
    });
    assert.equal(crossSite.status, 403);
  });

  it('serves the web app with a strict content security policy', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.match(await res.text(), /<title>Orco<\/title>/);
  });
});

describe('live events', () => {
  it('streams only messages from rooms the user can see', async () => {
    const anaClaude = store.authenticate(tokens['ana-claude']!)!;
    store.createProject(store.authenticate(tokens.ana!)!, 'private');
    const cookie = await login('ben');
    const events = await readEvents(cookie, (event) => event === 'message', async () => {
      store.post(anaClaude, 'private/general', 'secret plans');
      store.post(anaClaude, 'lobby', 'hello @ben');
    });
    const messages = events.filter((e) => e.event === 'message').map((e) => e.data.text);
    assert.deepEqual(messages, ['hello @ben']);
  });
});

describe('rooms over REST', () => {
  it('lists top-level messages with reply counts', async () => {
    const ana = store.authenticate(tokens.ana!)!;
    const root = store.post(ana, 'announcements', 'root');
    store.post(ana, 'announcements', 'reply', root.id);
    const res = await fetch(`${baseUrl}/api/messages?room=announcements&top_level=1`, {
      headers: { Authorization: `Bearer ${tokens.ana}` },
    });
    const messages = (await res.json()) as { text: string; replyCount: number }[];
    assert.deepEqual(
      messages.map((m) => [m.text, m.replyCount]),
      [['root', 1]],
    );
  });

  it('reports member status per project', async () => {
    const res = await fetch(`${baseUrl}/api/participants?project=private`, {
      headers: { Authorization: `Bearer ${tokens.ana}` },
    });
    const people = (await res.json()) as { name: string; status: string }[];
    assert.deepEqual(people.map((p) => p.name).sort(), ['ana', 'ana-claude']);
    assert.equal(people.find((p) => p.name === 'ana')?.status, 'online');
  });
});

describe('presence', () => {
  it('moves between offline, online and listening', () => {
    let now = 1_000_000;
    const presence = new Presence(() => now);
    const changes: number[] = [];
    presence.events.on('change', (id) => changes.push(id));
    assert.equal(presence.status(7), 'offline');
    presence.touch(7);
    assert.equal(presence.status(7), 'online');
    const release = presence.hold(7, 'waiting');
    assert.equal(presence.status(7), 'listening');
    release();
    release();
    assert.equal(presence.status(7), 'online');
    now += 10 * 60_000;
    assert.equal(presence.status(7), 'offline');
    assert.deepEqual(changes, [7, 7, 7]);
  });

  it('keeps a user online while a stream is open', () => {
    let now = 0;
    const presence = new Presence(() => now);
    const release = presence.hold(3, 'streams');
    now += 60 * 60_000;
    assert.equal(presence.status(3), 'online');
    release();
    assert.equal(presence.status(3), 'online');
  });
});
