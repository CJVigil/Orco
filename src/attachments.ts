import { createHash } from 'node:crypto';
import { OrcoError } from './errors.js';
import type { Participant, Room, Store } from './store.js';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
const UNATTACHED_TTL_MS = 3600_000;

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface AttachmentInfo {
  id: number;
  name: string;
  mime: ImageMime;
  size: number;
}

const EXTENSIONS: Record<ImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function sniffImage(data: Buffer): ImageMime | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function cleanName(raw: string | undefined, mime: ImageMime): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]/gu, '').trim().slice(0, 100);
  return cleaned || `image.${EXTENSIONS[mime]}`;
}

export class Attachments {
  constructor(private readonly store: Store) {}

  upload(actor: Participant, roomRef: string, data: Buffer, name?: string): AttachmentInfo {
    const room = this.store.room(actor, roomRef);
    if (data.length === 0) throw new OrcoError('invalid', 'The image is empty');
    if (data.length > MAX_ATTACHMENT_BYTES) throw new OrcoError('invalid', `Images can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
    const mime = sniffImage(data);
    if (!mime) throw new OrcoError('invalid', 'Only PNG, JPEG, GIF and WebP images can be shared');
    this.store.checkRate(actor, 'post');
    const now = this.store.now();
    this.store.db.prepare('DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?').run(now - UNATTACHED_TTL_MS);
    const finalName = cleanName(name, mime);
    const { lastInsertRowid } = this.store.db
      .prepare('INSERT INTO attachments (room_id, uploader_id, name, mime, size, sha256, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(room.id, actor.id, finalName, mime, data.length, createHash('sha256').update(data).digest('hex'), data, now);
    return { id: Number(lastInsertRowid), name: finalName, mime, size: data.length };
  }

  checkAttachable(actor: Participant, room: Room, ids: number[]): void {
    if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new OrcoError('invalid', `Attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} images`);
    if (new Set(ids).size !== ids.length) throw new OrcoError('invalid', 'The same image is attached twice');
    for (const id of ids) {
      const row = this.store.db.prepare('SELECT room_id, uploader_id, message_id FROM attachments WHERE id = ?').get(id) as
        | { room_id: number; uploader_id: number; message_id: number | null }
        | undefined;
      if (!row || row.uploader_id !== actor.id || row.message_id !== null) throw new OrcoError('not_found', `No unused upload ${id} of yours`);
      if (row.room_id !== room.id) throw new OrcoError('invalid', `Upload ${id} was made for a different room`);
    }
  }

  attach(messageId: number, ids: number[]): void {
    const update = this.store.db.prepare('UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL');
    for (const id of ids) update.run(messageId, id);
  }

  forMessage(messageId: number): AttachmentInfo[] {
    const rows = this.store.db
      .prepare('SELECT id, name, mime, size FROM attachments WHERE message_id = ? ORDER BY id')
      .all(messageId) as unknown as AttachmentInfo[];
    return rows.map((row) => ({ id: row.id, name: row.name, mime: row.mime, size: row.size }));
  }

  get(actor: Participant, id: number): AttachmentInfo & { data: Buffer; sha256: string } {
    const row = this.store.db
      .prepare('SELECT id, name, mime, size, data, sha256, room_id, uploader_id, message_id FROM attachments WHERE id = ?')
      .get(id) as
      | (AttachmentInfo & { data: Uint8Array; sha256: string; room_id: number; uploader_id: number; message_id: number | null })
      | undefined;
    const visible =
      row && this.store.canSeeRoomId(actor, row.room_id) && (row.message_id !== null || row.uploader_id === actor.id);
    if (!row || !visible) throw new OrcoError('not_found', `No image ${id}`);
    return { id: row.id, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256, data: Buffer.from(row.data) };
  }

  auditDetail(ids: number[]): { id: number; mime: string; size: number; sha256: string }[] {
    return ids.map((id) => this.store.db.prepare('SELECT id, mime, size, sha256 FROM attachments WHERE id = ?').get(id) as {
      id: number;
      mime: string;
      size: number;
      sha256: string;
    });
  }
}
