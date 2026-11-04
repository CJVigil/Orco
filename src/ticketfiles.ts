import { textPreview } from './preview.js';
import { createHash } from 'node:crypto';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { isText, sniffImage } from './attachments.js';
import { OrcoError } from './errors.js';
import type { Participant, Store } from './store.js';

/*
 * Files on tickets (#98): PDFs, Word, Excel, PowerPoint, CSV, images and text, up to 25 MB each,
 * attached to a ticket or one of its comments. Types are recognised by their bytes (a zip that holds
 * word/, xl/ or ppt/ is an Office file), never by the name alone, and never SVG or HTML. Images and
 * PDFs preview inline; everything else downloads. Agents read the text inside (read_ticket_file).
 */

export const MAX_TICKET_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_WRITE = 10;
const UNATTACHED_TTL_MS = 3600_000;
/** How much text read_ticket_file hands back, and how much a zip may inflate to while reading it. */
const MAX_TEXT = 200_000;
const MAX_INFLATE = 40 * 1024 * 1024;

export const TICKET_FILE_TYPES = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
} as const;
export type TicketFileMime = keyof typeof TICKET_FILE_TYPES;

export interface TicketFile {
  id: number;
  name: string;
  mime: TicketFileMime;
  size: number;
  by: string;
  at: string;
  /** The comment it came with, or null when it was attached to the ticket itself. */
  activityId: number | null;
  /** Text and CSV files: their first lines, so an agent reads the rest only when it needs it (#126). */
  preview?: string;
}

/* A small zip reader: the central directory, then stored or deflated entries, with a size cap. */
export function unzip(data: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return out;
  const count = data.readUInt16LE(eocd + 10);
  let p = data.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < count && p + 46 <= data.length; n++) {
    if (data.readUInt32LE(p) !== 0x02014b50) break;
    const method = data.readUInt16LE(p + 10);
    const compressed = data.readUInt32LE(p + 20);
    const nameLen = data.readUInt16LE(p + 28);
    const extraLen = data.readUInt16LE(p + 30);
    const commentLen = data.readUInt16LE(p + 32);
    const local = data.readUInt32LE(p + 42);
    const name = data.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name) || local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const raw = data.subarray(start, start + compressed);
    let body: Buffer;
    try {
      body = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_INFLATE - total }) : Buffer.alloc(0);
    } catch {
      continue;
    }
    total += body.length;
    out.set(name, body);
    if (total >= MAX_INFLATE) break;
  }
  return out;
}

function listZip(data: Buffer): string[] {
  const names: string[] = [];
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return names;
  let p = data.readUInt32LE(eocd + 16);
  const count = data.readUInt16LE(eocd + 10);
  for (let n = 0; n < count && p + 46 <= data.length && data.readUInt32LE(p) === 0x02014b50; n++) {
    const nameLen = data.readUInt16LE(p + 28);
    names.push(data.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + data.readUInt16LE(p + 30) + data.readUInt16LE(p + 32);
  }
  return names;
}

/** What a file is, from its bytes (and, for CSV versus text, its name). Null when it is not accepted. */
export function sniffTicketFile(data: Buffer, name: string): TicketFileMime | null {
  const image = sniffImage(data);
  if (image) return image;
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (data.length > 4 && data.readUInt32LE(0) === 0x04034b50) {
    const names = listZip(data);
    if (!names.includes('[Content_Types].xml')) return null;
    if (names.some((n) => n.startsWith('word/'))) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (names.some((n) => n.startsWith('xl/'))) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (names.some((n) => n.startsWith('ppt/'))) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    return null;
  }
  if (isText(data)) return /\.csv$/i.test(name) ? 'text/csv' : 'text/plain';
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()]!,
  );

function docxText(data: Buffer): string {
  const xml = unzip(data, (n) => n === 'word/document.xml').get('word/document.xml')?.toString('utf8') ?? '';
  return xml
    .split(/<\/w:p>/)
    .map((p) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)].map((m) => (m[1] === undefined ? '\t' : unescapeXml(m[1]))).join(''))
    .filter((line) => line.trim())
    .join('\n');
}

/** Column letters of a cell ref (B12 → 1). */
const columnOf = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? 'A')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function xlsxText(data: Buffer): string {
  const files = unzip(data, (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1]!.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => unescapeXml(t[1]!)).join(''),
  );
  const sheetNames = [...(files.get('xl/workbook.xml')?.toString('utf8') ?? '').matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map((m) => unescapeXml(m[1]!));
  const sheets = [...files.keys()].filter((n) => n.startsWith('xl/worksheets/')).sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
  const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const parts: string[] = [];
  sheets.forEach((sheet, i) => {
    const xml = files.get(sheet)!.toString('utf8');
    const lines: string[] = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]!;
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
        const type = /\bt="(\w+)"/.exec(attrs)?.[1];
        const inner = c[2] ?? '';
        const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        let value = '';
        if (type === 's' && v !== undefined) value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => unescapeXml(t[1]!)).join('');
        else if (v !== undefined) value = unescapeXml(v);
        const col = ref ? columnOf(ref) : cells.length;
        while (cells.length < col) cells.push('');
        cells[col] = csvCell(value);
      }
      lines.push(cells.join(','));
    }
    parts.push(`# Sheet ${sheetNames[i] ?? i + 1}\n${lines.join('\n')}`);
  });
  return parts.join('\n\n');
}

function pptxText(data: Buffer): string {
  const files = unzip(data, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  return [...files.entries()]
    .sort(([a], [b]) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(b)![1]))
    .map(([, xml], i) => `# Slide ${i + 1}\n${[...xml.toString('utf8').matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => unescapeXml(m[1]!)).join('\n')}`)
    .join('\n\n');
}

/** PDF text, where it can be had: strings shown by Tj and TJ in plain or Flate streams. Scans have none. */
function pdfText(data: Buffer): string {
  const raw = data.toString('latin1');
  const chunks: string[] = [];
  let total = 0;
  for (const m of raw.matchAll(/<<([\s\S]*?)>>\s*stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let body = data.subarray(start, end);
    if (/\/FlateDecode/.test(m[1]!)) {
      try {
        body = inflateSync(body, { maxOutputLength: MAX_INFLATE - total });
      } catch {
        continue;
      }
    } else if (/\/Filter/.test(m[1]!)) continue;
    total += body.length;
    if (total > MAX_INFLATE) break;
    const content = body.toString('latin1');
    if (!/T[jJ]/.test(content)) continue;
    const lines: string[] = [];
    let line = '';
    for (const op of content.matchAll(/\[((?:\((?:\\.|[^\\)])*\)|[^\]])*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")|(T\*|Td|TD|ET)(?![A-Za-z])/g)) {
      if (op[3]) {
        if (line.trim()) lines.push(line.replace(/\s{2,}/g, ' ').trim());
        line = '';
      } else if (op[2] !== undefined) line += pdfString(op[2]);
      else for (const s of op[1]!.matchAll(/\(((?:\\.|[^\\)])*)\)|(-?\d+(?:\.\d+)?)/g)) line += s[1] !== undefined ? pdfString(s[1]) : Number(s[2]) < -200 ? ' ' : '';
    }
    if (line.trim()) lines.push(line.replace(/\s{2,}/g, ' ').trim());
    chunks.push(lines.join('\n'));
  }
  return chunks.filter(Boolean).join('\n');
}

function pdfString(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) =>
    /^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: '\n', r: '', t: '\t', b: '', f: '' } as Record<string, string>)[e] ?? e,
  );
}

/** The text inside a file, for agents: CSV rows for a spreadsheet, paragraphs for Word, slides, PDF text. */
export function extractText(mime: TicketFileMime, data: Buffer): string | null {
  let text: string;
  if (mime === 'text/plain' || mime === 'text/csv') text = data.toString('utf8');
  else if (mime === 'application/pdf') text = pdfText(data);
  else if (mime.endsWith('wordprocessingml.document')) text = docxText(data);
  else if (mime.endsWith('spreadsheetml.sheet')) text = xlsxText(data);
  else if (mime.endsWith('presentationml.presentation')) text = pptxText(data);
  else return null;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT} characters)` : text;
}

/** Names keep letters, digits and a few marks, and the extension that matches what the bytes are. */
function cleanName(raw: string | undefined, mime: TicketFileMime): string {
  const ext = TICKET_FILE_TYPES[mime];
  const base = ((raw ?? '').split(/[\\/]/).pop() ?? '').replace(/[^\p{L}\p{N}._ ()-]/gu, '').trim().slice(0, 120);
  const stem = base.replace(/\.[^.]*$/, '') || 'file';
  const given = /\.([^.]+)$/.exec(base)?.[1]?.toLowerCase();
  const fits = given === ext || (ext === 'jpg' && given === 'jpeg') || (ext === 'txt' && given !== undefined && /^(txt|log|md|json|diff|patch|ya?ml|ts|py|go|rs|sql|ini|toml|conf)$/.test(given));
  return fits ? base : `${stem}.${ext}`;
}

interface FileRow {
  id: number;
  ticket_id: number | null;
  project_id: number;
  activity_id: number | null;
  uploader_id: number;
  name: string;
  mime: TicketFileMime;
  size: number;
  sha256: string;
  created_at: string;
  by: string;
}

export class TicketFiles {
  constructor(private readonly store: Store) {}

  /** An upload for a ticket in a project, waiting (an hour at most) to be attached with attachment_ids. */
  upload(actor: Participant, projectName: string, data: Buffer, name?: string): TicketFile {
    const project = this.store.visibleProject(actor, projectName);
    this.store.assertWrite(actor, project.id);
    if (data.length === 0) throw new OrcoError('invalid', 'The file is empty');
    if (data.length > MAX_TICKET_FILE_BYTES) throw new OrcoError('invalid', `Files on tickets can be at most ${MAX_TICKET_FILE_BYTES / 1024 / 1024} MB`);
    const finalName0 = name === undefined ? undefined : this.store.maskInput(actor, name);
    const mime = sniffTicketFile(data, finalName0 ?? '');
    if (!mime) throw new OrcoError('invalid', 'Tickets take PDF, Word, Excel, PowerPoint, CSV, text and PNG, JPEG, GIF or WebP images');
    this.store.checkRate(actor, 'post');
    const now = new Date(this.store.now());
    this.store.db.prepare('DELETE FROM ticket_files WHERE ticket_id IS NULL AND created_at < ?').run(new Date(now.getTime() - UNATTACHED_TTL_MS).toISOString());
    const finalName = cleanName(finalName0, mime);
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO ticket_files (project_id, uploader_id, name, mime, size, sha256, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(project.id, actor.id, finalName, mime, data.length, createHash('sha256').update(data).digest('hex'), data, now.toISOString());
    return { id: Number(lastInsertRowid), name: finalName, mime, size: data.length, by: actor.name, at: now.toISOString(), activityId: null };
  }

  /** Checks uploads can go on this ticket: the actor's own, unused, made for its project. */
  check(actor: Participant, projectId: number, ids: number[]): void {
    if (ids.length > MAX_FILES_PER_WRITE) throw new OrcoError('invalid', `Attach at most ${MAX_FILES_PER_WRITE} files at once`);
    if (new Set(ids).size !== ids.length) throw new OrcoError('invalid', 'The same file is attached twice');
    for (const id of ids) {
      const row = this.store.db.prepare('SELECT project_id, uploader_id, ticket_id FROM ticket_files WHERE id = ?').get(id) as
        | { project_id: number; uploader_id: number; ticket_id: number | null }
        | undefined;
      if (!row || row.uploader_id !== actor.id || row.ticket_id !== null) throw new OrcoError('not_found', `No unused upload ${id} of yours`);
      if (row.project_id !== projectId) throw new OrcoError('invalid', `Upload ${id} was made for a different project`);
    }
  }

  attach(ticketId: number, activityId: number | null, ids: number[]): void {
    const update = this.store.db.prepare('UPDATE ticket_files SET ticket_id = ?, activity_id = ? WHERE id = ? AND ticket_id IS NULL');
    for (const id of ids) update.run(ticketId, activityId, id);
  }

  /** Every file on a ticket and its comments, oldest first. */
  forTicket(ticketId: number): TicketFile[] {
    const rows = this.store.db
      .prepare(`SELECT f.*, p.name AS by FROM ticket_files f JOIN participants p ON p.id = f.uploader_id WHERE f.ticket_id = ? ORDER BY f.id`)
      .all(ticketId) as unknown as FileRow[];
    return rows.map(toFile);
  }

  list(actor: Participant, ref: string): TicketFile[] {
    return this.forTicket(this.store.tickets.idOf(actor, ref));
  }

  /** A file the actor can see: on a ticket they can see, or their own upload not yet attached. */
  get(actor: Participant, id: number): TicketFile & { data: Buffer; sha256: string } {
    const row = this.store.db.prepare('SELECT f.*, f.data AS data, p.name AS by FROM ticket_files f JOIN participants p ON p.id = f.uploader_id WHERE f.id = ?').get(id) as
      | (FileRow & { data: Uint8Array })
      | undefined;
    if (!row) throw new OrcoError('not_found', `No file ${id}`);
    const visible =
      row.ticket_id === null
        ? row.uploader_id === actor.id
        : this.store.canSee(actor, row.project_id) && this.store.tickets.sees(actor, row.ticket_id);
    if (!visible) throw new OrcoError('not_found', `No file ${id}`);
    return { ...toFile(row), sha256: row.sha256, data: Buffer.from(row.data) };
  }

  /** The file and the text inside it, for an agent to work from. */
  read(actor: Participant, id: number): TicketFile & { text: string | null; note?: string } {
    const { data, sha256: _sha, ...file } = this.get(actor, id);
    const text = extractText(file.mime, data);
    if (text === null) return { ...file, text: null, note: 'An image: open it in the web app, or ask a person what it shows.' };
    return { ...file, text, ...(text.trim() ? {} : { note: 'No text found: it may be a scan or a picture of a page.' }) };
  }
}

function toFile(row: FileRow): TicketFile {
  const data = (row as { data?: Uint8Array }).data;
  const text = (row.mime === 'text/plain' || row.mime === 'text/csv') && data;
  return { id: row.id, name: row.name, mime: row.mime, size: row.size, by: row.by, at: row.created_at, activityId: row.activity_id, ...(text ? { preview: textPreview(data) } : {}) };
}
