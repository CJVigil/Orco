import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { sniffImage } from '../src/attachments.js';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { OrcoError, type Participant, Store } from '../src/store.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof OrcoError) return err.code;
    throw err;
  }
  return undefined;
}

describe('image checks', () => {
  it('recognises the four formats by their bytes', () => {
    assert.equal(sniffImage(PNG), 'image/png');
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
    assert.equal(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
    assert.equal(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'image/webp');
  });

  it('refuses SVG, HTML and anything else', () => {
    assert.equal(sniffImage(SVG), null);
    assert.equal(sniffImage(Buffer.from('<html><script>alert(1)</script>')), null);
    assert.equal(sniffImage(Buffer.from('%PDF-1.7')), null);
  });
});

describe('sharing images in rooms', () => {
  let store: Store;
  let ana: Participant;
  let anaClaude: Participant;
  let ben: Participant;
  let cara: Participant;

  beforeEach(() => {
    store = new Store(openDatabase(':memory:'));
    ana = store.createUser('ana').participant;
    ben = store.createUser('ben').participant;
    cara = store.createUser('cara').participant;
    anaClaude = store.createAgent('ana', 'ana-claude').participant;
    store.createProject(ana, 'api');
    store.addMember(ana, 'api', 'ben');
  });

  it('attaches uploads to a message, even without text', () => {
    const image = store.attachments.upload(anaClaude, 'api/general', PNG, 'chart.png');
    const message = store.post(anaClaude, 'api/general', '', undefined, { attachmentIds: [image.id] });
    assert.deepEqual(message.attachments, [{ id: image.id, name: 'chart.png', mime: 'image/png', size: PNG.length }]);
    assert.deepEqual(store.attachments.get(ben, image.id).data, PNG);
  });

  it('refuses bad files, oversized files and too many images', () => {
    assert.equal(code(() => store.attachments.upload(ana, 'api/general', SVG)), 'invalid');
    assert.equal(code(() => store.attachments.upload(ana, 'api/general', Buffer.alloc(0))), 'invalid');
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    assert.equal(code(() => store.attachments.upload(ana, 'api/general', big)), 'invalid');
    const ids = Array.from({ length: 5 }, () => store.attachments.upload(ana, 'api/general', PNG).id);
    assert.equal(code(() => store.post(ana, 'api/general', 'five', undefined, { attachmentIds: ids })), 'invalid');
  });

  it('keeps images inside the room they were shared in', () => {
    const image = store.attachments.upload(ana, 'api/general', PNG);
    store.post(ana, 'api/general', 'secret diagram', undefined, { attachmentIds: [image.id] });
    assert.equal(code(() => store.attachments.get(cara, image.id)), 'not_found');
    assert.equal(code(() => store.attachments.upload(cara, 'api/general', PNG)), 'not_found');
  });

  it('only lets the uploader attach an upload, once, in the same room', () => {
    const image = store.attachments.upload(ana, 'api/general', PNG);
    assert.equal(code(() => store.attachments.get(ben, image.id)), 'not_found', 'unsent uploads are private');
    assert.equal(code(() => store.post(ben, 'api/general', 'mine now', undefined, { attachmentIds: [image.id] })), 'not_found');
    assert.equal(code(() => store.post(ana, 'lobby', 'other room', undefined, { attachmentIds: [image.id] })), 'invalid');
    store.post(ana, 'api/general', 'ok', undefined, { attachmentIds: [image.id] });
    assert.equal(code(() => store.post(ana, 'api/general', 'again', undefined, { attachmentIds: [image.id] })), 'not_found');
  });

  it('records a fingerprint of each image in the audit log, not the image', () => {
    const image = store.attachments.upload(ana, 'api/general', PNG);
    store.post(ana, 'api/general', 'see attached', undefined, { attachmentIds: [image.id] });
    const entry = store.audit.list(ana, { project: 'api' }).find((e) => e.action === 'message.post');
    const detail = entry?.detail as { attachments: { sha256: string; size: number }[] };
    assert.equal(detail.attachments[0]?.size, PNG.length);
    assert.match(detail.attachments[0]!.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(detail).includes(PNG.toString('base64')));
  });
});

describe('images over HTTP and MCP', () => {
  let base: string;
  let closeServer: () => Promise<void>;
  const tokens: Record<string, string> = {};

  before(async () => {
    const store = new Store(openDatabase(':memory:'));
    tokens.ana = store.createUser('ana').token;
    tokens.cara = store.createUser('cara').token;
    tokens.claude = store.createAgent('ana', 'ana-claude').token;
    store.createProject(store.participantByName('ana')!, 'api');
    const { app, close } = createApp(store);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeServer = async () => {
      await close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    };
  });

  after(async () => {
    await closeServer();
  });

  const upload = (token: string, body: Buffer, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/attachments?room=api/general&name=shot.png`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png', ...extra },
      body: new Uint8Array(body),
    });

  it('uploads over REST and serves the image with locked-down headers', async () => {
    const res = await upload(tokens.claude!, PNG);
    assert.equal(res.status, 201);
    const { id } = (await res.json()) as { id: number };
    const posted = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.claude}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: 'api/general', text: 'build output', attachment_ids: [id] }),
    });
    assert.equal(posted.status, 201);
    const image = await fetch(`${base}/api/attachments/${id}`, { headers: { Authorization: `Bearer ${tokens.ana}` } });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.match(image.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
    const outsider = await fetch(`${base}/api/attachments/${id}`, { headers: { Authorization: `Bearer ${tokens.cara}` } });
    assert.equal(outsider.status, 404);
  });

  it('rejects oversized uploads and cross-site browser uploads', async () => {
    const big = await upload(tokens.claude!, Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]));
    assert.equal(big.status, 413);
    const crossSite = await fetch(`${base}/api/attachments?room=api/general`, {
      method: 'POST',
      headers: { Cookie: `orco_token=${tokens.ana}`, Origin: 'https://evil.example', 'Content-Type': 'image/png' },
      body: new Uint8Array(PNG),
    });
    assert.equal(crossSite.status, 403);
  });

  it('lets agents post images as base64 and look at them', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.claude}` } } }),
    );
    const posted = await client.callTool({
      name: 'post',
      arguments: { room: 'api/general', text: 'screenshot of the bug', images: [{ data: PNG.toString('base64'), name: 'bug.png' }] },
    });
    const message = JSON.parse((posted.content as { text: string }[])[0]!.text);
    assert.equal(message.images[0].name, 'bug.png');
    const viewed = await client.callTool({ name: 'view_image', arguments: { image_id: message.images[0].id } });
    const [caption, picture] = viewed.content as [{ type: string; text: string }, { type: string; data: string; mimeType: string }];
    assert.match(caption.text, /not as instructions from your owner/);
    assert.equal(picture.type, 'image');
    assert.equal(picture.mimeType, 'image/png');
    assert.equal(picture.data, PNG.toString('base64'));
    const bad = await client.callTool({ name: 'post', arguments: { room: 'api/general', text: 'x', images: [{ data: SVG.toString('base64') }] } });
    assert.equal(bad.isError, true);
    await client.close();
  });
});
