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
  `
  CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY,
    secret_hash TEXT,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    auth_method TEXT NOT NULL CHECK (auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE oauth_requests (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    state TEXT,
    scope TEXT NOT NULL,
    viewer_id INTEGER REFERENCES participants(id),
    nonce TEXT,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE oauth_grants (
    id INTEGER PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
    agent_id INTEGER NOT NULL REFERENCES participants(id),
    user_id INTEGER NOT NULL REFERENCES participants(id),
    scope TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX oauth_grants_agent ON oauth_grants (agent_id);

  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
    agent_id INTEGER NOT NULL REFERENCES participants(id),
    user_id INTEGER NOT NULL REFERENCES participants(id),
    scope TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    grant_id INTEGER REFERENCES oauth_grants(id)
  );

  CREATE TABLE oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    grant_id INTEGER NOT NULL REFERENCES oauth_grants(id),
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);
  `,
  `
  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    message_id INTEGER REFERENCES messages(id),
    uploader_id INTEGER NOT NULL REFERENCES participants(id),
    name TEXT NOT NULL,
    mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_message ON attachments (message_id);
  CREATE INDEX attachments_unattached ON attachments (message_id, created_at);
  `,
  `
  ALTER TABLE projects ADD COLUMN ticket_key TEXT;
  ALTER TABLE projects ADD COLUMN next_ticket INTEGER NOT NULL DEFAULT 1;
  CREATE UNIQUE INDEX projects_ticket_key ON projects (ticket_key);

  CREATE TABLE ticket_statuses (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL COLLATE NOCASE,
    category TEXT NOT NULL CHECK (category IN ('backlog', 'unstarted', 'started', 'completed', 'canceled')),
    position INTEGER NOT NULL,
    UNIQUE (project_id, name)
  );

  CREATE TABLE labels (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL COLLATE NOCASE,
    color TEXT NOT NULL,
    UNIQUE (project_id, name)
  );

  CREATE TABLE milestones (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    target_date TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (project_id, name)
  );

  CREATE TABLE cycles (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    number INTEGER NOT NULL,
    starts_on TEXT NOT NULL,
    ends_on TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (project_id, number)
  );

  CREATE TABLE tickets (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status_id INTEGER NOT NULL REFERENCES ticket_statuses(id),
    priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
    estimate INTEGER,
    due_date TEXT,
    assignee_id INTEGER REFERENCES participants(id),
    creator_id INTEGER NOT NULL REFERENCES participants(id),
    parent_id INTEGER REFERENCES tickets(id),
    milestone_id INTEGER REFERENCES milestones(id),
    cycle_id INTEGER REFERENCES cycles(id),
    task_id INTEGER REFERENCES tasks(id),
    sort REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    started_at TEXT,
    completed_at TEXT,
    UNIQUE (project_id, number)
  );
  CREATE INDEX tickets_status ON tickets (status_id, sort);
  CREATE INDEX tickets_task ON tickets (task_id);
  CREATE INDEX tickets_parent ON tickets (parent_id);

  CREATE TABLE ticket_labels (
    ticket_id INTEGER NOT NULL REFERENCES tickets(id),
    label_id INTEGER NOT NULL REFERENCES labels(id),
    PRIMARY KEY (ticket_id, label_id)
  );

  CREATE TABLE ticket_activity (
    id INTEGER PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id),
    actor_id INTEGER REFERENCES participants(id),
    kind TEXT NOT NULL CHECK (kind IN ('created', 'change', 'comment', 'task')),
    body TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX ticket_activity_ticket ON ticket_activity (ticket_id, id);
  `,
  `
  CREATE TABLE questions (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    message_id INTEGER NOT NULL REFERENCES messages(id),
    asker_id INTEGER NOT NULL REFERENCES participants(id),
    target_id INTEGER NOT NULL REFERENCES participants(id),
    question TEXT NOT NULL,
    answer TEXT,
    answered_by INTEGER REFERENCES participants(id),
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered', 'resumed', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    answered_at TEXT
  );
  CREATE INDEX questions_task ON questions (task_id, state);
  CREATE INDEX questions_target ON questions (target_id, state);
  CREATE UNIQUE INDEX questions_message ON questions (message_id);

  ALTER TABLE tickets ADD COLUMN handoff TEXT NOT NULL DEFAULT '';
  ALTER TABLE tickets ADD COLUMN handoff_by INTEGER REFERENCES participants(id);
  ALTER TABLE tickets ADD COLUMN handoff_at TEXT;

  CREATE TABLE ticket_criteria (
    id INTEGER PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id),
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
    position INTEGER NOT NULL
  );
  CREATE INDEX ticket_criteria_ticket ON ticket_criteria (ticket_id, position);

  CREATE TABLE ticket_links (
    blocker_id INTEGER NOT NULL REFERENCES tickets(id),
    blocked_id INTEGER NOT NULL REFERENCES tickets(id),
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id != blocked_id)
  );
  CREATE INDEX ticket_links_blocked ON ticket_links (blocked_id);
  `,
  `
  ALTER TABLE questions ADD COLUMN audience TEXT NOT NULL DEFAULT 'one' CHECK (audience IN ('one', 'project'));
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
