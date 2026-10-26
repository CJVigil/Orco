import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { hashToken, newToken } from './tokens.js';

export type ParticipantKind = 'user' | 'agent';

export interface Participant {
  id: number;
  kind: ParticipantKind;
  name: string;
  ownerId: number | null;
}

export interface Room {
  id: number;
  projectId: number | null;
  project: string | null;
  name: string;
  ref: string;
}

export interface Project {
  id: number;
  name: string;
}

export interface Message {
  id: number;
  room: string;
  projectId: number | null;
  threadId: number | null;
  author: string;
  authorKind: ParticipantKind;
  owner: string | null;
  text: string;
  createdAt: string;
  mentions: string[];
  replyCount: number;
}

export type OrcoErrorCode = 'invalid' | 'not_found' | 'forbidden' | 'conflict';

export class OrcoError extends Error {
  constructor(
    readonly code: OrcoErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MENTION = /(?<![\w@])@([a-z0-9][a-z0-9-]{0,31})\b/g;
const MAX_TEXT = 16_000;

function checkName(kind: string, name: string): void {
  if (!NAME.test(name)) {
    throw new OrcoError('invalid', `${kind} name must be 1-32 lowercase letters, digits or dashes, starting with a letter or digit`);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}

interface ParticipantRow {
  id: number;
  kind: ParticipantKind;
  name: string;
  owner_id: number | null;
}

interface RoomRow {
  id: number;
  project_id: number | null;
  project: string | null;
  name: string;
}

interface MessageRow {
  id: number;
  room_id: number;
  project_id: number | null;
  project: string | null;
  room: string;
  thread_id: number | null;
  author: string;
  author_kind: ParticipantKind;
  owner: string | null;
  text: string;
  created_at: string;
  reply_count: number;
}

const MESSAGE_SELECT = `
  SELECT m.id, m.room_id, r.project_id, p.name AS project, r.name AS room, m.thread_id, a.name AS author,
         a.kind AS author_kind, o.name AS owner, m.text, m.created_at,
         (SELECT count(*) FROM messages t WHERE t.thread_id = m.id) AS reply_count
  FROM messages m
  JOIN rooms r ON r.id = m.room_id
  LEFT JOIN projects p ON p.id = r.project_id
  JOIN participants a ON a.id = m.author_id
  LEFT JOIN participants o ON o.id = a.owner_id
`;

function toParticipant(row: ParticipantRow): Participant {
  return { id: row.id, kind: row.kind, name: row.name, ownerId: row.owner_id };
}

function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    projectId: row.project_id,
    project: row.project,
    name: row.name,
    ref: row.project ? `${row.project}/${row.name}` : row.name,
  };
}

export class Store {
  readonly events = new EventEmitter();

  constructor(private readonly db: DatabaseSync) {
    this.events.setMaxListeners(0);
  }

  createUser(name: string): { participant: Participant; token: string } {
    return this.createParticipant('user', name, null);
  }

  createAgent(ownerName: string, name: string): { participant: Participant; token: string } {
    const owner = this.participantByName(ownerName);
    if (!owner || owner.kind !== 'user') throw new OrcoError('not_found', `No user named ${ownerName}`);
    return this.createParticipant('agent', name, owner.id);
  }

  rotateToken(name: string): string {
    const participant = this.participantByName(name);
    if (!participant) throw new OrcoError('not_found', `No user or agent named ${name}`);
    const token = newToken(participant.kind);
    this.db.prepare('UPDATE participants SET token_hash = ? WHERE id = ?').run(hashToken(token), participant.id);
    return token;
  }

  authenticate(token: string): Participant | null {
    const row = this.db
      .prepare('SELECT id, kind, name, owner_id FROM participants WHERE token_hash = ?')
      .get(hashToken(token)) as ParticipantRow | undefined;
    return row ? toParticipant(row) : null;
  }

  participantByName(name: string): Participant | null {
    const row = this.db
      .prepare('SELECT id, kind, name, owner_id FROM participants WHERE name = ?')
      .get(name) as ParticipantRow | undefined;
    return row ? toParticipant(row) : null;
  }

  ownerName(participant: Participant): string | null {
    if (participant.ownerId === null) return null;
    const row = this.db.prepare('SELECT name FROM participants WHERE id = ?').get(participant.ownerId) as
      | { name: string }
      | undefined;
    return row?.name ?? null;
  }

  listParticipants(): (Participant & { owner: string | null })[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.kind, p.name, p.owner_id, o.name AS owner
         FROM participants p LEFT JOIN participants o ON o.id = p.owner_id ORDER BY p.name`,
      )
      .all() as unknown as (ParticipantRow & { owner: string | null })[];
    return rows.map((row) => ({ ...toParticipant(row), owner: row.owner }));
  }

  members(actor: Participant, projectName?: string): (Participant & { owner: string | null })[] {
    const everyone = this.listParticipants();
    if (projectName === undefined) return everyone;
    const project = this.visibleProject(actor, projectName);
    return everyone.filter((p) => this.canSee(p, project.id));
  }

  createProject(actor: Participant, name: string): Project {
    checkName('Project', name);
    const userId = this.humanOf(actor);
    this.db.exec('BEGIN');
    try {
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO projects (name, created_by) VALUES (?, ?)')
        .run(name, actor.id);
      const projectId = Number(lastInsertRowid);
      this.db.prepare('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)').run(projectId, userId);
      this.db
        .prepare("INSERT INTO rooms (project_id, name, created_by) VALUES (?, 'general', ?)")
        .run(projectId, actor.id);
      this.db.exec('COMMIT');
      this.events.emit('structure');
      return { id: projectId, name };
    } catch (err) {
      this.db.exec('ROLLBACK');
      if (isUniqueViolation(err)) throw new OrcoError('conflict', `Project ${name} already exists`);
      throw err;
    }
  }

  listProjects(actor: Participant): (Project & { members: string[] })[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.name, group_concat(u.name, ',') AS members
         FROM projects p
         JOIN project_members pm ON pm.project_id = p.id
         JOIN participants u ON u.id = pm.user_id
         WHERE p.id IN (SELECT project_id FROM project_members WHERE user_id = ?)
         GROUP BY p.id ORDER BY p.name`,
      )
      .all(this.humanOf(actor)) as unknown as { id: number; name: string; members: string }[];
    return rows.map((row) => ({ id: row.id, name: row.name, members: row.members.split(',').sort() }));
  }

  addMember(actor: Participant, projectName: string, userName: string): void {
    const project = this.visibleProject(actor, projectName);
    const user = this.participantByName(userName);
    if (!user || user.kind !== 'user') throw new OrcoError('not_found', `No user named ${userName}`);
    this.db
      .prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)')
      .run(project.id, user.id);
    this.events.emit('structure');
  }

  createRoom(actor: Participant, projectName: string, name: string): Room {
    checkName('Room', name);
    const project = this.visibleProject(actor, projectName);
    try {
      this.db.prepare('INSERT INTO rooms (project_id, name, created_by) VALUES (?, ?, ?)').run(project.id, name, actor.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new OrcoError('conflict', `Room ${projectName}/${name} already exists`);
      throw err;
    }
    this.events.emit('structure');
    return this.room(actor, `${projectName}/${name}`);
  }

  listRooms(actor: Participant, projectName?: string): Room[] {
    const userId = this.humanOf(actor);
    const rows = this.db
      .prepare(
        `SELECT r.id, r.project_id, p.name AS project, r.name
         FROM rooms r LEFT JOIN projects p ON p.id = r.project_id
         WHERE (r.project_id IS NULL OR r.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?))
         ORDER BY p.name IS NOT NULL, p.name, r.name`,
      )
      .all(userId) as unknown as RoomRow[];
    const rooms = rows.map(toRoom);
    if (projectName === undefined) return rooms;
    this.visibleProject(actor, projectName);
    return rooms.filter((room) => room.project === projectName);
  }

  room(actor: Participant, ref: string): Room {
    const [first, second, ...rest] = ref.replace(/^#/, '').split('/');
    if (!first || rest.length > 0) throw new OrcoError('invalid', `Room must be "room" or "project/room", got ${ref}`);
    const projectName = second === undefined ? null : first;
    const roomName = (second ?? first).replace(/^#/, '');
    const row = this.db
      .prepare(
        `SELECT r.id, r.project_id, p.name AS project, r.name
         FROM rooms r LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.name = ? AND ((? IS NULL AND r.project_id IS NULL) OR p.name = ?)`,
      )
      .get(roomName, projectName, projectName) as RoomRow | undefined;
    if (!row || !this.canSee(actor, row.project_id)) throw new OrcoError('not_found', `No room ${ref}`);
    return toRoom(row);
  }

  post(actor: Participant, roomRef: string, text: string, threadId?: number): Message {
    const trimmed = text.trim();
    if (!trimmed) throw new OrcoError('invalid', 'Message text is empty');
    if (trimmed.length > MAX_TEXT) throw new OrcoError('invalid', `Message is over ${MAX_TEXT} characters`);
    const room = this.room(actor, roomRef);
    let thread: number | null = null;
    if (threadId !== undefined) {
      const parent = this.db.prepare('SELECT room_id, thread_id FROM messages WHERE id = ?').get(threadId) as
        | { room_id: number; thread_id: number | null }
        | undefined;
      if (!parent || parent.room_id !== room.id) throw new OrcoError('not_found', `No message ${threadId} in ${room.ref}`);
      thread = parent.thread_id ?? threadId;
    }

    const mentioned = this.resolveMentions(trimmed, room, actor);
    this.db.exec('BEGIN');
    let messageId: number;
    try {
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO messages (room_id, thread_id, author_id, text) VALUES (?, ?, ?, ?)')
        .run(room.id, thread, actor.id, trimmed);
      messageId = Number(lastInsertRowid);
      const insertMention = this.db.prepare('INSERT INTO mentions (message_id, participant_id) VALUES (?, ?)');
      for (const target of mentioned) insertMention.run(messageId, target.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    const message = this.message(messageId);
    this.events.emit('message', message);
    for (const target of mentioned) this.events.emit(`mention:${target.id}`, message);
    return message;
  }

  read(
    actor: Participant,
    roomRef: string,
    options: { sinceId?: number; beforeId?: number; threadId?: number; limit?: number; topLevel?: boolean } = {},
  ): Message[] {
    const room = this.room(actor, roomRef);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const since = options.sinceId ?? 0;
    const before = options.beforeId ?? Number.MAX_SAFE_INTEGER;
    const rows = (
      options.threadId === undefined
        ? this.db
            .prepare(
              `${MESSAGE_SELECT} WHERE m.room_id = ? AND m.id > ? AND m.id < ? ${options.topLevel ? 'AND m.thread_id IS NULL' : ''}
               ORDER BY m.id DESC LIMIT ?`,
            )
            .all(room.id, since, before, limit)
        : this.db
            .prepare(
              `${MESSAGE_SELECT} WHERE m.room_id = ? AND m.id > ? AND (m.id = ? OR m.thread_id = ?) ORDER BY m.id DESC LIMIT ?`,
            )
            .all(room.id, since, options.threadId, options.threadId, limit)
    ) as unknown as MessageRow[];
    return rows.reverse().map((row) => this.toMessage(row));
  }

  unseenMentions(actor: Participant): Message[] {
    const rows = this.db
      .prepare(
        `${MESSAGE_SELECT}
         JOIN mentions mn ON mn.message_id = m.id AND mn.participant_id = ?
         WHERE m.id > (SELECT seen_mention_id FROM participants WHERE id = ?)
         ORDER BY m.id`,
      )
      .all(actor.id, actor.id) as unknown as MessageRow[];
    return rows.filter((row) => this.canSeeRoomId(actor, row.room_id)).map((row) => this.toMessage(row));
  }

  markMentionsSeen(actor: Participant, upToId: number): void {
    this.db
      .prepare('UPDATE participants SET seen_mention_id = max(seen_mention_id, ?) WHERE id = ?')
      .run(upToId, actor.id);
  }

  async waitForMentions(actor: Participant, timeoutMs: number, signal?: AbortSignal): Promise<Message[]> {
    const ready = this.unseenMentions(actor);
    if (ready.length > 0 || timeoutMs <= 0) return this.deliver(actor, ready);
    await new Promise<void>((resolve) => {
      const event = `mention:${actor.id}`;
      const done = () => {
        clearTimeout(timer);
        this.events.off(event, done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.events.on(event, done);
      signal?.addEventListener('abort', done);
    });
    return this.deliver(actor, this.unseenMentions(actor));
  }

  private deliver(actor: Participant, messages: Message[]): Message[] {
    const last = messages.at(-1);
    if (last) this.markMentionsSeen(actor, last.id);
    return messages;
  }

  private createParticipant(kind: ParticipantKind, name: string, ownerId: number | null) {
    checkName(kind === 'user' ? 'User' : 'Agent', name);
    const token = newToken(kind);
    try {
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO participants (kind, name, owner_id, token_hash) VALUES (?, ?, ?, ?)')
        .run(kind, name, ownerId, hashToken(token));
      return { participant: { id: Number(lastInsertRowid), kind, name, ownerId }, token };
    } catch (err) {
      if (isUniqueViolation(err)) throw new OrcoError('conflict', `The name ${name} is taken`);
      throw err;
    }
  }

  private humanOf(actor: Participant): number {
    return actor.ownerId ?? actor.id;
  }

  canSee(actor: Participant, projectId: number | null): boolean {
    if (projectId === null) return true;
    return (
      this.db
        .prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?')
        .get(projectId, this.humanOf(actor)) !== undefined
    );
  }

  private canSeeRoomId(actor: Participant, roomId: number): boolean {
    const row = this.db.prepare('SELECT project_id FROM rooms WHERE id = ?').get(roomId) as
      | { project_id: number | null }
      | undefined;
    return row !== undefined && this.canSee(actor, row.project_id);
  }

  private visibleProject(actor: Participant, name: string): Project {
    const row = this.db.prepare('SELECT id, name FROM projects WHERE name = ?').get(name) as Project | undefined;
    if (!row || !this.canSee(actor, row.id)) throw new OrcoError('not_found', `No project ${name}`);
    return row;
  }

  private resolveMentions(text: string, room: Room, actor: Participant): Participant[] {
    const names = new Set([...text.matchAll(MENTION)].map((match) => match[1]!));
    const targets: Participant[] = [];
    for (const name of names) {
      const target = this.participantByName(name);
      if (target && target.id !== actor.id && this.canSee(target, room.projectId)) targets.push(target);
    }
    return targets;
  }

  private message(id: number): Message {
    const row = this.db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) as unknown as MessageRow;
    return this.toMessage(row);
  }

  private toMessage(row: MessageRow): Message {
    const mentions = this.db
      .prepare(
        'SELECT p.name FROM mentions mn JOIN participants p ON p.id = mn.participant_id WHERE mn.message_id = ? ORDER BY p.name',
      )
      .all(row.id) as unknown as { name: string }[];
    return {
      id: row.id,
      room: row.project ? `${row.project}/${row.room}` : row.room,
      projectId: row.project_id,
      threadId: row.thread_id,
      author: row.author,
      authorKind: row.author_kind,
      owner: row.owner,
      text: row.text,
      createdAt: row.created_at,
      mentions: mentions.map((m) => m.name),
      replyCount: row.reply_count,
    };
  }
}
