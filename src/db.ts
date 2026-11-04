import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS = [
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
  `
  CREATE TABLE notes (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL COLLATE NOCASE,
    body TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES participants(id),
    updated_by INTEGER NOT NULL REFERENCES participants(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (project_id, title)
  );

  ALTER TABLE tasks ADD COLUMN progress TEXT;
  ALTER TABLE tasks ADD COLUMN progress_pct INTEGER CHECK (progress_pct BETWEEN 0 AND 100);
  ALTER TABLE tasks ADD COLUMN progress_at TEXT;
  ALTER TABLE tasks ADD COLUMN heartbeat_at INTEGER;
  ALTER TABLE tasks ADD COLUMN stall_notified INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE flags (
    id INTEGER PRIMARY KEY,
    flagger_id INTEGER NOT NULL REFERENCES participants(id),
    message_id INTEGER REFERENCES messages(id),
    ticket_id INTEGER REFERENCES tickets(id),
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    reviewed_by INTEGER REFERENCES participants(id),
    reviewed_at TEXT,
    CHECK ((message_id IS NULL) != (ticket_id IS NULL))
  );
  CREATE INDEX flags_flagger ON flags (flagger_id, reviewed_at);

  ALTER TABLE questions ADD COLUMN kind TEXT NOT NULL DEFAULT 'question' CHECK (kind IN ('question', 'plan'));
  ALTER TABLE questions ADD COLUMN verdict TEXT CHECK (verdict IN ('approved', 'rejected'));

  CREATE TABLE idempotency (
    actor_id INTEGER NOT NULL REFERENCES participants(id),
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    result_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, key)
  );

  ALTER TABLE participants ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE participants ADD COLUMN environment TEXT NOT NULL DEFAULT '';

  CREATE TABLE thread_summaries (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id),
    summary TEXT NOT NULL,
    updated_by INTEGER NOT NULL REFERENCES participants(id),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  `,
  `
  ALTER TABLE tickets ADD COLUMN blocked_reason TEXT NOT NULL DEFAULT '';
  `,
  `
  CREATE TABLE attachments_v2 (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    message_id INTEGER REFERENCES messages(id),
    uploader_id INTEGER NOT NULL REFERENCES participants(id),
    name TEXT NOT NULL,
    mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain')),
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  INSERT INTO attachments_v2 (id, room_id, message_id, uploader_id, name, mime, size, sha256, data, created_at)
    SELECT id, room_id, message_id, uploader_id, name, mime, size, sha256, data, created_at FROM attachments;
  DROP TABLE attachments;
  ALTER TABLE attachments_v2 RENAME TO attachments;
  CREATE INDEX attachments_message ON attachments (message_id);
  CREATE INDEX attachments_unattached ON attachments (message_id, created_at);

  CREATE TABLE agent_memory (
    id INTEGER PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES participants(id),
    title TEXT NOT NULL COLLATE NOCASE,
    body TEXT NOT NULL,
    updated_by INTEGER NOT NULL REFERENCES participants(id),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (agent_id, title)
  );

  ALTER TABLE messages ADD COLUMN external_source TEXT;
  ALTER TABLE messages ADD COLUMN external_text TEXT;

  ALTER TABLE tasks ADD COLUMN cancel_unseen INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN seen_at TEXT;
  ALTER TABLE tasks ADD COLUMN accepted_at INTEGER;
  ALTER TABLE tasks ADD COLUMN budget_minutes INTEGER;
  ALTER TABLE tasks ADD COLUMN budget_cents INTEGER;
  ALTER TABLE tasks ADD COLUMN spent_cents INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN spent_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN over_budget_notified INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN links TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE tasks ADD COLUMN schedule_id INTEGER;
  ALTER TABLE questions ADD COLUMN seen_at TEXT;

  CREATE TABLE task_tokens (
    token_hash TEXT PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    agent_id INTEGER NOT NULL REFERENCES participants(id),
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX task_tokens_task ON task_tokens (task_id);

  CREATE TABLE suggestions (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    project_id INTEGER NOT NULL REFERENCES projects(id),
    author_id INTEGER NOT NULL REFERENCES participants(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'accepted', 'dismissed')),
    ticket_id INTEGER REFERENCES tickets(id),
    decided_by INTEGER REFERENCES participants(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    decided_at TEXT
  );
  CREATE INDEX suggestions_project ON suggestions (project_id, state);

  CREATE TABLE reviews (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
    ticket_id INTEGER REFERENCES tickets(id),
    task_id INTEGER REFERENCES tasks(id),
    requester_id INTEGER NOT NULL REFERENCES participants(id),
    reviewer_id INTEGER NOT NULL REFERENCES participants(id),
    summary TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'changes_requested', 'withdrawn')),
    note TEXT,
    review_task_id INTEGER REFERENCES tasks(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    decided_at TEXT
  );
  CREATE INDEX reviews_reviewer ON reviews (reviewer_id, state);

  CREATE TABLE schedules (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    creator_id INTEGER NOT NULL REFERENCES participants(id),
    agent_id INTEGER NOT NULL REFERENCES participants(id),
    request TEXT NOT NULL,
    cron TEXT NOT NULL,
    tz TEXT NOT NULL DEFAULT 'UTC',
    budget_minutes INTEGER,
    budget_cents INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    next_run INTEGER NOT NULL,
    last_run INTEGER,
    last_task_id INTEGER REFERENCES tasks(id),
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX schedules_due ON schedules (enabled, next_run);
  `,
  `
  ALTER TABLE schedules ADD COLUMN approval_id INTEGER REFERENCES approvals(id);
  ALTER TABLE schedules ADD COLUMN run_as_id INTEGER REFERENCES participants(id);
  UPDATE schedules SET run_as_id = creator_id;
  ALTER TABLE participants ADD COLUMN auto_file_followups INTEGER NOT NULL DEFAULT 0 CHECK (auto_file_followups IN (0, 1));
  `,
  `
  CREATE TABLE hooks (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by INTEGER NOT NULL REFERENCES participants(id),
    wake_agent_id INTEGER REFERENCES participants(id),
    wake_match TEXT NOT NULL DEFAULT '',
    last_at TEXT,
    deliveries INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    agent_id INTEGER NOT NULL REFERENCES participants(id),
    due_at INTEGER NOT NULL,
    note TEXT NOT NULL,
    fired_at INTEGER
  );
  CREATE INDEX reminders_due ON reminders (fired_at, due_at);

  CREATE TABLE read_cursors (
    participant_id INTEGER NOT NULL REFERENCES participants(id),
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    last_id INTEGER NOT NULL,
    PRIMARY KEY (participant_id, room_id)
  );
  ALTER TABLE participants ADD COLUMN caught_up_at TEXT;

  ALTER TABLE tasks ADD COLUMN checkpoint TEXT;
  ALTER TABLE tasks ADD COLUMN checkpoint_at TEXT;

  CREATE TABLE task_feedback (
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    author_id INTEGER NOT NULL REFERENCES participants(id),
    rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (task_id, author_id)
  );

  ALTER TABLE questions ADD COLUMN escalated_at TEXT;
  ALTER TABLE approvals ADD COLUMN reminded_at INTEGER;

  CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    path TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES participants(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (project_id, path)
  );
  CREATE TABLE file_versions (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id),
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    size INTEGER NOT NULL,
    author_id INTEGER NOT NULL REFERENCES participants(id),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (file_id, version)
  );

  CREATE TABLE secrets (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    ciphertext BLOB NOT NULL,
    iv BLOB NOT NULL,
    tag BLOB NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES participants(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (project_id, name)
  );
  CREATE TABLE secret_leases (
    id INTEGER PRIMARY KEY,
    secret_id INTEGER NOT NULL REFERENCES secrets(id),
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    agent_id INTEGER NOT NULL REFERENCES participants(id),
    approval_id INTEGER NOT NULL REFERENCES approvals(id),
    reason TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'granted', 'denied', 'revoked')),
    expires_at INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  `,
  // 14: agent runs the bridge reports, with usage and a masked log of what the agent did.
  `
  CREATE TABLE task_runs (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    agent_id INTEGER NOT NULL REFERENCES participants(id),
    mode TEXT NOT NULL CHECK (mode IN ('start', 'resume', 'reminder')),
    started_at TEXT NOT NULL,
    seconds INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_micros INTEGER,
    branch TEXT,
    workspace TEXT,
    log TEXT,
    log_bytes INTEGER NOT NULL DEFAULT 0,
    log_cut INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX task_runs_task ON task_runs (task_id);
  CREATE INDEX task_runs_agent ON task_runs (agent_id, created_at);
  `,
  // 15: webhooks ask their creator before an agent starts on what they relay (new hooks default to asking).
  `
  ALTER TABLE hooks ADD COLUMN confirm_tasks INTEGER NOT NULL DEFAULT 0;
  `,
  // 16: running many projects: roles and groups, budgets and pauses, policies, decisions, CI status, digests.
  `
  ALTER TABLE participants ADD COLUMN org_admin INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE participants ADD COLUMN system INTEGER NOT NULL DEFAULT 0;
  UPDATE participants SET org_admin = 1 WHERE id = (SELECT min(id) FROM participants WHERE kind = 'user');
  ALTER TABLE project_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer'));
  UPDATE project_members SET role = 'admin' WHERE user_id = (
    SELECT coalesce(c.owner_id, c.id) FROM projects p JOIN participants c ON c.id = p.created_by WHERE p.id = project_members.project_id
  );

  CREATE TABLE groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE group_members (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES participants(id),
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE project_groups (
    project_id INTEGER NOT NULL REFERENCES projects(id),
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),
    PRIMARY KEY (project_id, group_id)
  );
  CREATE VIEW project_access AS
    SELECT project_id, user_id, role FROM project_members
    UNION ALL
    SELECT pg.project_id, gm.user_id, pg.role FROM project_groups pg JOIN group_members gm ON gm.group_id = pg.group_id;

  CREATE TABLE budgets (
    id INTEGER PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('project', 'agent')),
    target_id INTEGER NOT NULL,
    monthly_cents INTEGER NOT NULL,
    set_by INTEGER NOT NULL REFERENCES participants(id),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (scope, target_id)
  );
  CREATE TABLE budget_alerts (
    budget_id INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    level INTEGER NOT NULL,
    PRIMARY KEY (budget_id, month, level)
  );
  CREATE TABLE pauses (
    scope TEXT NOT NULL CHECK (scope IN ('all', 'project', 'agent')),
    target_id INTEGER NOT NULL DEFAULT 0,
    by_id INTEGER NOT NULL REFERENCES participants(id),
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (scope, target_id)
  );

  CREATE TABLE policies (
    project_id INTEGER REFERENCES projects(id),
    body TEXT NOT NULL,
    updated_by INTEGER NOT NULL REFERENCES participants(id),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE UNIQUE INDEX policies_scope ON policies (ifnull(project_id, 0));

  CREATE TABLE decisions (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    title TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    options TEXT NOT NULL DEFAULT '[]',
    decision TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    decided_by INTEGER NOT NULL REFERENCES participants(id),
    superseded_by INTEGER REFERENCES decisions(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX decisions_project ON decisions (project_id, created_at);

  CREATE TABLE ci_status (
    project_id INTEGER NOT NULL REFERENCES projects(id),
    source TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('success', 'failure', 'pending')),
    summary TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, source)
  );

  CREATE TABLE digests (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    week TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE UNIQUE INDEX digests_week ON digests (ifnull(project_id, 0), week);
  `,
  // 17: sign-in links (invites, other devices) and the browser sessions they start.
  `
  CREATE TABLE signin_links (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES participants(id),
    code_hash TEXT NOT NULL UNIQUE,
    created_by INTEGER REFERENCES participants(id),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE web_sessions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES participants(id),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  `,
  // 18: what a task cost, measured by the bridge and reported by the agent, kept apart; spent_* is the larger.
  `
  ALTER TABLE tasks ADD COLUMN measured_cents INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN reported_cents INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN measured_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN reported_tokens INTEGER NOT NULL DEFAULT 0;
  UPDATE tasks SET measured_cents = spent_cents, measured_tokens = spent_tokens;
  `,
  // 19: logins from a sign-in proxy (Google through oauth2-proxy, Cloudflare Access, Tailscale), one person each.
  `
  CREATE TABLE identities (
    identity TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES participants(id),
    created_by INTEGER REFERENCES participants(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX identities_user ON identities (user_id);
  `,
  // 20: agents that run on Orco itself (a model behind an API an org admin configured), and agents
  // limited to some of their owner's projects.
  `
  CREATE TABLE model_providers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    ciphertext BLOB,
    iv BLOB,
    tag BLOB,
    price_in REAL,
    price_out REAL,
    shared INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL REFERENCES participants(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE hosted_agents (
    agent_id INTEGER PRIMARY KEY REFERENCES participants(id),
    provider_id INTEGER NOT NULL REFERENCES model_providers(id),
    template TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL REFERENCES participants(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE agent_projects (
    agent_id INTEGER NOT NULL REFERENCES participants(id),
    project_id INTEGER NOT NULL REFERENCES projects(id),
    PRIMARY KEY (agent_id, project_id)
  );
  `,
  // 21: spend outside tasks (a hosted agent's "Try it"), and the provider account behind an OpenID login.
  `
  CREATE TABLE agent_spend (
    id INTEGER PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES participants(id),
    cents REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX agent_spend_agent ON agent_spend (agent_id, created_at);
  ALTER TABLE identities ADD COLUMN issuer TEXT;
  ALTER TABLE identities ADD COLUMN subject TEXT;
  `,
  // 22: one Onyx server to search, connected by an org admin (key sealed with ORCO_SECRETS_KEY).
  `
  CREATE TABLE onyx_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    base_url TEXT NOT NULL,
    ciphertext BLOB NOT NULL,
    iv BLOB NOT NULL,
    tag BLOB NOT NULL,
    persona_id INTEGER,
    document_sets TEXT NOT NULL DEFAULT '[]',
    sources TEXT NOT NULL DEFAULT '[]',
    updated_by INTEGER NOT NULL REFERENCES participants(id),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  `,
  // 23: whether agents get Onyx results for a task when they accept it.
  `
  ALTER TABLE onyx_settings ADD COLUMN brief INTEGER NOT NULL DEFAULT 1;
  `,
  // 24: a spend ledger, dated when the money was spent (not when its task was made), that outlives
  // its agent: monthly budgets and the per-person cap on the org's models count from it.
  `
  CREATE TABLE spend (
    id INTEGER PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES participants(id),
    owner_id INTEGER REFERENCES participants(id),
    task_id INTEGER REFERENCES tasks(id),
    project_id INTEGER REFERENCES projects(id),
    org_model INTEGER NOT NULL DEFAULT 0,
    cents REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX spend_agent ON spend (agent_id, created_at);
  CREATE INDEX spend_project ON spend (project_id, created_at);
  CREATE INDEX spend_owner ON spend (owner_id, org_model, created_at);
  INSERT INTO spend (agent_id, owner_id, task_id, project_id, org_model, cents, note, created_at)
    SELECT t.assignee_id, a.owner_id, t.id, r.project_id, EXISTS (SELECT 1 FROM hosted_agents h WHERE h.agent_id = t.assignee_id), t.spent_cents, 'before the ledger', t.created_at
    FROM tasks t JOIN rooms r ON r.id = t.room_id JOIN participants a ON a.id = t.assignee_id WHERE t.spent_cents > 0;
  INSERT INTO spend (agent_id, owner_id, org_model, cents, note, created_at)
    SELECT s.agent_id, a.owner_id, 1, s.cents, s.note, s.created_at FROM agent_spend s JOIN participants a ON a.id = s.agent_id;
  DROP TABLE agent_spend;
  `,
  // 25: one current-state line per room, replaced in place and optionally expiring.
  `
  CREATE TABLE room_status (
    room_id INTEGER PRIMARY KEY REFERENCES rooms(id),
    text TEXT NOT NULL,
    set_by INTEGER NOT NULL REFERENCES participants(id),
    set_at TEXT NOT NULL,
    expires_at TEXT
  );
  `,
  // 26: when each participant was last seen, so presence survives a restart.
  `
  ALTER TABLE participants ADD COLUMN last_seen_at TEXT;
  `,
  // 27: tasks that expire before they start; a bridge's claim on the run it starts (so two bridges
  // never run one task); what to do when an agent is lost mid-task.
  `
  ALTER TABLE tasks ADD COLUMN expires_at INTEGER;
  ALTER TABLE tasks ADD COLUMN run_claim TEXT;
  ALTER TABLE tasks ADD COLUMN run_claim_until INTEGER;
  ALTER TABLE tasks ADD COLUMN recoveries INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN lost_notified INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE schedules ADD COLUMN expires_minutes INTEGER;
  CREATE TABLE lost_policies (
    agent_id INTEGER PRIMARY KEY REFERENCES participants(id),
    minutes INTEGER NOT NULL,
    fallback_id INTEGER REFERENCES participants(id),
    release_locks INTEGER NOT NULL DEFAULT 0,
    set_by INTEGER NOT NULL REFERENCES participants(id),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  `,
  // 28: a ticket closed as a duplicate of, or superseded by, another one.
  `
  ALTER TABLE tickets ADD COLUMN closed_reason TEXT CHECK (closed_reason IN ('duplicate', 'superseded'));
  ALTER TABLE tickets ADD COLUMN closed_for INTEGER REFERENCES tickets(id);
  `,
  // 29: multiple-choice questions; decisions tied to the ticket (and question) they settle; approvals
  // tied to a ticket, with a scope and how long they stay in force once given.
  `
  ALTER TABLE questions ADD COLUMN options TEXT;
  ALTER TABLE questions ADD COLUMN recommended TEXT;
  ALTER TABLE questions ADD COLUMN multi_select INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE decisions ADD COLUMN ticket_id INTEGER REFERENCES tickets(id);
  ALTER TABLE decisions ADD COLUMN question_id INTEGER REFERENCES questions(id);
  CREATE INDEX decisions_ticket ON decisions (ticket_id);
  ALTER TABLE approvals ADD COLUMN ticket_id INTEGER REFERENCES tickets(id);
  ALTER TABLE approvals ADD COLUMN scope TEXT;
  ALTER TABLE approvals ADD COLUMN valid_hours INTEGER;
  ALTER TABLE approvals ADD COLUMN valid_until INTEGER;
  CREATE INDEX approvals_ticket ON approvals (ticket_id);
  `,
  // 30: the safety filter between agents of different owners (#81).
  `
  ALTER TABLE participants ADD COLUMN safety_filter TEXT NOT NULL DEFAULT 'strict' CHECK (safety_filter IN ('strict', 'normal', 'off'));
  CREATE TABLE held_mentions (
    message_id INTEGER NOT NULL REFERENCES messages(id),
    agent_id INTEGER NOT NULL REFERENCES participants(id),
    approval_id INTEGER NOT NULL REFERENCES approvals(id),
    rule TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('held', 'released', 'dropped')),
    PRIMARY KEY (message_id, agent_id)
  );
  CREATE INDEX held_mentions_approval ON held_mentions (approval_id);
  `,
  // 31: a one-line next step on a ticket, and an ask waiting on one person.
  `
  ALTER TABLE tickets ADD COLUMN next_step TEXT;
  ALTER TABLE tickets ADD COLUMN next_step_for INTEGER REFERENCES participants(id);
  ALTER TABLE tickets ADD COLUMN waiting_on INTEGER REFERENCES participants(id);
  ALTER TABLE tickets ADD COLUMN waiting_ask TEXT;
  ALTER TABLE tickets ADD COLUMN waiting_since TEXT;
  ALTER TABLE tickets ADD COLUMN waiting_snoozed_until TEXT;
  CREATE INDEX tickets_waiting ON tickets (waiting_on);
  `,
  // 32: when a ticket last changed status, so "stale" means the work stopped moving, not that a bulk
  // edit touched it.
  `
  ALTER TABLE tickets ADD COLUMN status_changed_at TEXT;
  UPDATE tickets SET status_changed_at = coalesce(
    (SELECT max(a.created_at) FROM ticket_activity a WHERE a.ticket_id = tickets.id AND (a.kind = 'created' OR a.detail LIKE '%"field":"status"%')),
    created_at);
  `,
  // 33: calmer notifications and a daily digest per person: their settings, snoozed items, mentions
  // they opened one by one, and the digests sent.
  `
  ALTER TABLE participants ADD COLUMN notify_level TEXT NOT NULL DEFAULT 'needs_me' CHECK (notify_level IN ('needs_me', 'all', 'off'));
  ALTER TABLE participants ADD COLUMN quiet_start TEXT;
  ALTER TABLE participants ADD COLUMN quiet_end TEXT;
  ALTER TABLE participants ADD COLUMN tz TEXT NOT NULL DEFAULT 'UTC';
  ALTER TABLE participants ADD COLUMN digest_time TEXT;
  ALTER TABLE participants ADD COLUMN digest_last TEXT;
  CREATE TABLE snoozes (
    participant_id INTEGER NOT NULL REFERENCES participants(id),
    key TEXT NOT NULL,
    until TEXT NOT NULL,
    PRIMARY KEY (participant_id, key)
  );
  CREATE TABLE mention_seen (
    participant_id INTEGER NOT NULL REFERENCES participants(id),
    message_id INTEGER NOT NULL REFERENCES messages(id),
    PRIMARY KEY (participant_id, message_id)
  );
  CREATE TABLE person_digests (
    id INTEGER PRIMARY KEY,
    participant_id INTEGER NOT NULL REFERENCES participants(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX person_digests_participant ON person_digests (participant_id, id);
  `,
  // 34: the quick replies offered for a waiting-on ask (a JSON list), when the agent chose them.
  `
  ALTER TABLE tickets ADD COLUMN waiting_options TEXT;
  `,
  // 35: folders inside a project, to group tickets by area (#91). A ticket sits in at most one.
  `
  CREATE TABLE ticket_folders (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL COLLATE NOCASE,
    emoji TEXT,
    color TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, name)
  );
  ALTER TABLE tickets ADD COLUMN folder_id INTEGER REFERENCES ticket_folders(id);
  CREATE INDEX tickets_folder ON tickets (folder_id);
  `,
  // 36: the kind of action an approval is for, and approvals that stand for that kind on one ticket
  // ("Yes, and don't ask again", #95).
  `
  ALTER TABLE approvals ADD COLUMN action_kind TEXT;
  ALTER TABLE approvals ADD COLUMN standing INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX approvals_standing ON approvals (ticket_id, requester_id) WHERE standing = 1;
  `,
  // 37: an agent's checklist for a task, like Claude Code's todo list (#94): a JSON list of steps.
  `
  ALTER TABLE tasks ADD COLUMN steps TEXT;
  `,  // 38: when a person last edited their message (#93).
  `
  ALTER TABLE messages ADD COLUMN edited_at TEXT;
  `,  // 39: private tickets, and the refs a moved ticket had before (#97).
  `
  ALTER TABLE tickets ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE ticket_moves (
    ticket_key TEXT NOT NULL,
    number INTEGER NOT NULL,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    moved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (ticket_key, number)
  );
  `,  // 40: files on tickets and their comments (#98).
  `
  CREATE TABLE ticket_files (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    activity_id INTEGER REFERENCES ticket_activity(id),
    uploader_id INTEGER NOT NULL REFERENCES participants(id),
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX ticket_files_ticket ON ticket_files (ticket_id);
  `,  // 41: shared artifacts, versioned pages published into a project (#99).
  `
  CREATE TABLE artifacts (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN ('html', 'markdown', 'chart')),
    created_by INTEGER NOT NULL REFERENCES participants(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX artifacts_project ON artifacts (project_id, updated_at);
  CREATE INDEX artifacts_ticket ON artifacts (ticket_id);
  CREATE TABLE artifact_versions (
    artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    published_by INTEGER NOT NULL REFERENCES participants(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (artifact_id, version)
  );
  `,  // 42: MCP tool use per agent, tool and day, kept locally (#103).
  `
  CREATE TABLE tool_usage (
    day TEXT NOT NULL,
    participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    tool TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    error_codes TEXT NOT NULL DEFAULT '{}',
    bytes INTEGER NOT NULL DEFAULT 0,
    max_bytes INTEGER NOT NULL DEFAULT 0,
    ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, participant_id, tool)
  );
  `,  // 43: spend and tokens per ticket, and usage an agent session reports (#106).
  `
  ALTER TABLE spend ADD COLUMN ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;
  ALTER TABLE spend ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX spend_ticket ON spend (ticket_id, created_at);
  UPDATE spend SET ticket_id = (SELECT id FROM tickets WHERE tickets.task_id = spend.task_id) WHERE task_id IS NOT NULL;
  CREATE TABLE usage_sessions (
    agent_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    session TEXT NOT NULL,
    tokens INTEGER NOT NULL DEFAULT 0,
    cents REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, session)
  );
  `,  // 44: commits that name a ticket, and CI results per repository, branch and sha (#107).
  `
  CREATE TABLE ticket_commits (
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    sha TEXT NOT NULL,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    author TEXT NOT NULL,
    message TEXT NOT NULL,
    url TEXT,
    created_at TEXT NOT NULL,
    ci TEXT CHECK (ci IN ('success', 'failure', 'pending')),
    ci_summary TEXT,
    deployed_at TEXT,
    PRIMARY KEY (ticket_id, sha)
  );
  CREATE INDEX ticket_commits_sha ON ticket_commits (sha);
  CREATE TABLE ci_results (
    project_id INTEGER NOT NULL REFERENCES projects(id),
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    sha TEXT NOT NULL,
    source TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('success', 'failure', 'pending')),
    summary TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, repo, sha, source)
  );
  CREATE INDEX ci_results_branch ON ci_results (project_id, branch, updated_at);
  `,  // 45: the scope gate: a project's scope must be approved before build work starts (#108).
  `
  ALTER TABLE projects ADD COLUMN scope_state TEXT NOT NULL DEFAULT 'none' CHECK (scope_state IN ('none', 'scoping', 'approved'));
  ALTER TABLE projects ADD COLUMN scope_version INTEGER;
  ALTER TABLE projects ADD COLUMN scope_approved_by INTEGER REFERENCES participants(id);
  ALTER TABLE projects ADD COLUMN scope_decision_id INTEGER;
  CREATE TABLE org_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,  // 46: build order rules: tickets with a label wait for a milestone or another label (#109).
  `
  CREATE TABLE order_rules (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    waits_milestone TEXT,
    waits_label TEXT,
    created_by INTEGER NOT NULL REFERENCES participants(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  `,  // 47: Definition of Done templates by label, and required criteria (#110).
  `
  CREATE TABLE checklist_templates (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    items TEXT NOT NULL,
    created_by INTEGER REFERENCES participants(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  ALTER TABLE ticket_criteria ADD COLUMN required INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE ticket_criteria ADD COLUMN template TEXT;
  INSERT INTO checklist_templates (project_id, label, items) VALUES (NULL, 'service', '[{"text": "Names follow the platform naming rules", "required": true}, {"text": "No host ports published; traffic goes through the proxy", "required": true}, {"text": "Memory and CPU limits set", "required": true}, {"text": "A healthcheck", "required": true}, {"text": "Log rotation configured", "required": true}, {"text": "The env example is updated", "required": true}, {"text": "A dev branch and its workflow", "required": true}]');
  INSERT INTO checklist_templates (project_id, label, items) VALUES (NULL, 'ui', '[{"text": "Works at phone width (390 px)", "required": true}]');
  `,
];

export interface OpenOptions {
  /**
   * Before upgrading an existing database, copy it here first (named with its schema version), so an
   * upgrade can always be rolled back. Off when unset.
   */
  snapshotDir?: string;
  log?: (message: string) => void;
}

export function openDatabase(path: string, options: OpenOptions = {}): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version > 0 && version < MIGRATIONS.length && options.snapshotDir && path !== ':memory:') {
    mkdirSync(options.snapshotDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(options.snapshotDir, `${basename(path).replace(/\.db$/, '')}-schema${version}-before-upgrade-${stamp}.db`);
    // A consistent copy, like orco backup; restore it with orco restore if the upgrade goes wrong.
    db.prepare('VACUUM INTO ?').run(target);
    options.log?.(`Upgrading the database from schema ${version} to ${MIGRATIONS.length}. A copy of it from before is at ${target} (orco restore puts it back).`);
  }
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
