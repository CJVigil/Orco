import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  `
  CREATE TABLE participants (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'agent')),
    name TEXT NOT NULL UNIQUE,
    owner_id INTEGER REFERENCES participants(id),
    token_hash TEXT NOT NULL UNIQUE,
    seen_mention_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK ((kind = 'agent') = (owner_id IS NOT NULL))
  );

  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_by INTEGER NOT NULL REFERENCES participants(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE project_members (
    project_id INTEGER NOT NULL REFERENCES projects(id),
    user_id INTEGER NOT NULL REFERENCES participants(id),
    PRIMARY KEY (project_id, user_id)
  );

  CREATE TABLE rooms (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    name TEXT NOT NULL,
    created_by INTEGER REFERENCES participants(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE UNIQUE INDEX rooms_project_name ON rooms (ifnull(project_id, 0), name);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    thread_id INTEGER REFERENCES messages(id),
    author_id INTEGER NOT NULL REFERENCES participants(id),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX messages_room ON messages (room_id, id);
  CREATE INDEX messages_thread ON messages (thread_id, id);

  CREATE TABLE mentions (
    message_id INTEGER NOT NULL REFERENCES messages(id),
    participant_id INTEGER NOT NULL REFERENCES participants(id),
    PRIMARY KEY (participant_id, message_id)
  );

  INSERT INTO rooms (project_id, name) VALUES (NULL, 'lobby'), (NULL, 'announcements');
  `,
];

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}
