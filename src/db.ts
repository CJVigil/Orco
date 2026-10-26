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
  `
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    requester_id INTEGER NOT NULL REFERENCES participants(id),
    assignee_id INTEGER NOT NULL REFERENCES participants(id),
    parent_id INTEGER REFERENCES tasks(id),
    depth INTEGER NOT NULL DEFAULT 0,
    request TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'requested'
      CHECK (state IN ('requested', 'accepted', 'done', 'failed', 'declined', 'cancelled')),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX tasks_assignee ON tasks (assignee_id, state);
  CREATE INDEX tasks_requester ON tasks (requester_id, state);
  CREATE INDEX tasks_room ON tasks (room_id, id);

  CREATE TABLE locks (
    project_id INTEGER NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    holder_id INTEGER REFERENCES participants(id),
    fence INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    acquired_at INTEGER,
    expires_at INTEGER,
    PRIMARY KEY (project_id, name)
  );
  `,
  `
  ALTER TABLE participants ADD COLUMN task_policy TEXT NOT NULL DEFAULT 'ask'
    CHECK (task_policy IN ('open', 'ask', 'owner_only'));

  CREATE TABLE agent_trust (
    agent_id INTEGER NOT NULL REFERENCES participants(id),
    user_id INTEGER NOT NULL REFERENCES participants(id),
    PRIMARY KEY (agent_id, user_id)
  );

  CREATE TABLE approvals (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('action', 'task')),
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    message_id INTEGER NOT NULL REFERENCES messages(id),
    requester_id INTEGER NOT NULL REFERENCES participants(id),
    approver_id INTEGER REFERENCES participants(id),
    summary TEXT NOT NULL,
    details TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'denied', 'expired')),
    decided_by INTEGER REFERENCES participants(id),
    note TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX approvals_pending ON approvals (state, approver_id);
  CREATE INDEX approvals_message ON approvals (message_id);

  ALTER TABLE tasks ADD COLUMN approval_id INTEGER REFERENCES approvals(id);

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor_id INTEGER REFERENCES participants(id),
    action TEXT NOT NULL,
    project_id INTEGER REFERENCES projects(id),
    subject TEXT,
    detail TEXT
  );
  CREATE INDEX audit_project ON audit (project_id, id);
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
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
