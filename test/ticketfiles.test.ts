import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/http.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';
import { extractText, sniffTicketFile } from '../src/ticketfiles.js';

/** A zip of the given files, deflated, the way Office writes them. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const body = deflateRawSync(raw);
    const n = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, n);
    offset += 30 + n.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const xlsx = () =>
  zip({
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': '<workbook><sheets><sheet name="Prices" sheetId="1"/></sheets></workbook>',
    'xl/sharedStrings.xml': '<sst><si><t>SKU</t></si><si><t>Price</t></si><si><t>Kiosk paper &amp; ink</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>12.5</v></c></row></sheetData></worksheet>',
  });
const docx = () =>
  zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Returns policy</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Thirty days, </w:t></w:r><w:r><w:t>with a receipt.</w:t></w:r></w:p></w:body></w:document>',
  });
function pdf(): Buffer {
  const content = deflateSync(Buffer.from('BT /F1 12 Tf 72 720 Td (Liability cap: 2x fees) Tj T* [(Term: 12 ) -300 (months)] TJ ET', 'latin1'));
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + content.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
    content,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ]);
}

describe('reading files on tickets (#98)', () => {
  it('recognises office files by their bytes and reads the text inside', () => {
    assert.equal(sniffTicketFile(xlsx(), 'prices.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(sniffTicketFile(docx(), 'policy.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(sniffTicketFile(pdf(), 'x.pdf'), 'application/pdf');
    assert.equal(sniffTicketFile(Buffer.from('a,b\n1,2\n'), 'rows.csv'), 'text/csv');
    assert.equal(sniffTicketFile(zip({ 'evil.exe': 'MZ' }), 'evil.docx'), null, 'a zip that is not an Office file');
    assert.equal(sniffTicketFile(Buffer.from('<svg onload="x()"/>'), 'a.txt'), null);
    assert.equal(extractText('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx()), '# Sheet Prices\nSKU,Price\nKiosk paper & ink,,12.5');
    assert.equal(extractText('application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx()), 'Returns policy\nThirty days, with a receipt.');
    assert.equal(extractText('application/pdf', pdf()), 'Liability cap: 2x fees\nTerm: 12 months');
  });
});

let store: Store;
let carlos: Participant;
let carlosToken: string;
let ana: Participant;
let botToken: string;
let base: string;
let stop: () => Promise<void>;

before(async () => {
  store = new Store(openDatabase(':memory:'));
  const made = store.createUser('carlos');
  carlos = made.participant;
  carlosToken = made.token;
  ana = store.createUser('ana').participant;
  botToken = store.createAgent('carlos', 'carlos-bot').token;
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

const upload = (token: string, name: string, data: Buffer) =>
  fetch(`${base}/api/ticket-files?project=shop&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body: new Uint8Array(data),
  });

describe('files on tickets (#98)', () => {
  it('attaches a PDF and an xlsx, lists them, previews the PDF and lets an agent read the rows', async () => {
    const a = (await (await upload(carlosToken, 'contract.pdf', pdf())).json()) as { id: number };
    const b = (await (await upload(carlosToken, 'prices.xlsx', xlsx())).json()) as { id: number };
    const { ticket } = store.tickets.create(carlos, 'shop', { title: 'Supplier contract', attachmentIds: [a.id] });
    store.tickets.comment(carlos, ticket.ref, 'Price sheet', [b.id]);
    const files = store.tickets.get(carlos, ticket.ref).files;
    assert.deepEqual(files.map((f) => f.name), ['contract.pdf', 'prices.xlsx']);
    assert.equal(files[0]!.by, 'carlos');
    const served = await fetch(`${base}/api/ticket-files/${a.id}`, { headers: { authorization: `Bearer ${carlosToken}` } });
    assert.equal(served.headers.get('content-type'), 'application/pdf');
    assert.match(served.headers.get('content-disposition') ?? '', /^inline/);
    const sheet = await fetch(`${base}/api/ticket-files/${b.id}`, { headers: { authorization: `Bearer ${carlosToken}` } });
    assert.match(sheet.headers.get('content-disposition') ?? '', /^attachment/, 'office files download');
    assert.equal(store.ticketFiles.read(store.participantByName('carlos-bot')!, b.id).text, '# Sheet Prices\nSKU,Price\nKiosk paper & ink,,12.5');
    assert.equal((await fetch(`${base}/api/ticket-files/${a.id}`, { headers: { authorization: `Bearer ${botToken}` } })).status, 200);
  });

  it('refuses a 30 MB file with a clear message, and files of a private ticket stay private', async () => {
    const big = await upload(carlosToken, 'huge.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(30 * 1024 * 1024)]));
    assert.equal(big.status, 400);
    assert.match(((await big.json()) as { error: string }).error, /at most 25 MB/);
    const up = (await (await upload(carlosToken, 'salary.csv', Buffer.from('name,pay\nana,1\n'))).json()) as { id: number };
    store.tickets.create(carlos, 'shop', { title: 'Pay review', private: true, attachmentIds: [up.id] });
    assert.equal(
      ((): string => {
        try {
          store.ticketFiles.get(ana, up.id);
          return 'ok';
        } catch (err) {
          return (err as OrcoError).code;
        }
      })(),
      'not_found',
    );
  });
});
