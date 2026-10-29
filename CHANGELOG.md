# Changelog

## Unreleased

- Agents that run on Orco (#42): org admins add an AI model (any OpenAI-compatible API, key stored
  encrypted), and people make agents on it in the browser from plain templates (answers questions,
  writes summaries, drafts replies, keeps tickets tidy, general helper), choosing projects, who may
  give it tasks and a monthly budget, with a *Try it* box, pause and remove. The server runs them
  with Orco tools only (no shell, no files), and they never administer anything. The server's
  outbound-calls rule now reads: none, except to endpoints an org admin configures.
- Agents can be limited to some of their owner's projects.

- Security fixes for sign-in through a proxy (#38-#40): Orco now also requires `ORCO_AUTH_SECRET`,
  which the proxy sends in `X-Orco-Auth-Secret` (an address like `loopback` also covers every other
  program and agent on that host); requests with an `Authorization` header never sign in through the
  proxy; behind the proxy, a browser session counts only while the proxy's login is that person's;
  and a login is linked when someone signs in with their token or a sign-in link and confirms it,
  not afterwards. Org admins can remove anyone's login. Agent text is masked in object keys and file
  names too, and a webhook stops waking an agent whose owner no longer lets its creator give it work.

- Security fixes (#32-#37): run reports, project files and ticket imports now hide leased secrets
  like every other route (a test checks every authenticated JSON route); masking private keys no
  longer stalls the server on hostile text; webhooks need write access, wake only your own or
  willing agents, stop posting when their creator loses access, and are removed only by their
  creator or an admin; the audit log shows entries outside projects only to org admins (others see
  their own); ticket imports are all or nothing, check field types and self-blocks, and treat label
  names case-blind; viewers cannot store secrets; an outlying reported cost is held to a ceiling and
  flagged; a task token's mention wait no longer swallows the agent's other mentions; schedules run
  once in the hour repeated when clocks go back; very broad `ORCO_TRUST_PROXY` ranges are refused;
  long messages render quickly.

- Sign in with Google (or GitHub, Microsoft, your company's login) through a proxy in front of Orco:
  set `ORCO_AUTH_HEADER` to the header your sign-in proxy fills (oauth2-proxy, Cloudflare Access,
  Tailscale, Authelia, Authentik) and `ORCO_TRUST_PROXY` to its address. Orco makes no outbound calls
  for it. Admins invite by email, people already here link their login once, and
  `orco user email` links one on the server; nobody can link a login to someone else's account.
  The header is read only from the trusted proxy, and Orco refuses to start with a hop count.

- Security fixes (#25-#31): `orco connect` checks the agent names, tools and tokens a server sends
  before writing anything, and keeps token files inside their folder (on Windows, locked to your
  account with an ACL). Pairing shows the address a request came from and warns when it is not your
  network; codes are typed from the joining computer's screen (links no longer carry them), and
  reusing an existing agent says plainly that its current token ends. The pairing secret moved out
  of the URL. Every browser sign-in is now its own session, ended by *Sign out everywhere*,
  `orco user signout` or rotating the token. Opening a sign-in link while signed in asks before
  switching accounts. Agents see only the people and agents they share a project with. The
  usage-limit retry count is kept by the server, so a bridge restart does not reset it.

- Security fixes (#16-#20, #22, #24): agents and task tokens never administer a project, whatever
  their owner's role (groups, members, roles, budgets, pauses, policies); an agent's reported cost can
  only raise a task's spend, never lower what the bridge measured; decisions are superseded only from
  where they were made (org-wide ones by org admins); groups are listed to people only, without
  projects they cannot see; every string an agent sends (REST bodies, MCP tool arguments, text
  files) is stored with leased secret values hidden; the roadmap and digests no longer name blocker
  tickets in projects the reader cannot see; and `ORCO_TRUST_PROXY=true` is refused.
- Bridge (#21, #23): a usage limit counts only when the tool says so at the very end of its output
  (a plain line among the last three, or its own error event), is checked before a clean exit counts
  as done, and is retried at most 6 times in a row before the task fails; hand-overs cannot loop back
  to an agent that already had the work; the limit message is masked before it reaches a task note.

- Sign-in links: inviting someone gives a link that signs them in once (7 days) and welcomes them,
  instead of a token to paste. Anyone makes a 15-minute one for their own other device (click your
  name), and for someone who lost access `orco user link <name>` prints one on the server. Nobody
  can make one for another existing person in the browser, not even an org admin. Each starts a
  30-day browser session of its own.
- *Add member* suggests the people not in the project yet, and after your first task Orco offers,
  once, to notify you when agents finish or need you. Your name in the sidebar opens a menu with
  *Sign in on another device* and *Sign out*.

- Joining a computer needs only Node: the server hands out its own copy of Orco, so the line the
  browser shows (`npx -y <server>/install/orco-<version>.tgz connect <server>`) works without a
  clone or install (`ORCO_PACKAGE`; the Docker image includes it).
- Task cards explain themselves: each state says what it means, and an open task says why it waits
  (its agent is not running, the owner has to allow it, it asked something) with a button for the
  fix, like *Connect a computer*, *Open Inbox* or, for a failed task, *Ask again*.
- A calmer room header: Locks and the audit log moved into a ⋯ menu, and presence reads in plain
  words (Ready, Asleep · wakes up for tasks, Offline · not connected).

- Easier to start: a new server prints a setup link, and the first person makes their account in
  the browser. People add their own agents (*My agents* → *Add an agent*), with the token shown once
  next to ready-to-paste setup for `orco connect`, Claude Code, Codex and other MCP clients, and org
  admins add people from *Portfolio* → *Controls*.
- `orco connect <server>` joins a computer without copying tokens: it finds the agent tools
  installed there, shows a short code that you approve in the browser (choosing which of your agents
  run there), writes their tokens to private files and a bridge config, checks it, and starts the
  bridge (`--service` installs a login service instead). Bridge agents take `token_file`, and
  `token_env` defaults to `ORCO_TOKEN_<NAME>`.
- Guided first steps: a *Getting started* checklist (project, agent, computer, first task, first
  result), an *Ask an agent* form with starting points (fix a bug, review a pull request, write
  docs, …) and optional limits, and *How Orco works*, a plain-words explainer.

- Out of usage: when an agent's tool hits its usage limit, rate limit or credit, the bridge hands the
  task (with its checkpoint) to the agent's `fallback`, or waits until the limit resets (or
  `retry_minutes`) and resumes it, instead of failing it.

- Running many projects: a **Portfolio** view with project health (red, amber, green and why), a
  roadmap of milestones across projects with cross-project blockers and at-risk detection, a decision
  log agents read, weekly digests posted to each project (and a roll-up for org admins), and
  controls: project roles (admin, member, viewer), org admins, groups with `@group` mentions, monthly
  budgets per project and agent that hold new tasks past the cap, a kill switch for all, a project's
  or one agent's work, and org-wide policies projects can only tighten. Agents get the rules and
  decisions in force with each task.
- Changed: adding members and changing roles takes a project admin; the first user on a server
  becomes an org admin, and each project's creator its admin.

- Security: only people create projects and add members (the `create_project` and `add_member` MCP
  tools are gone), and an agent's approval requests always go to its owner. Leased secret values are
  hidden in agents' posts, task notes and run logs, and only people read run logs. Webhook tasks wait
  for the hook creator's approval by default. `ORCO_OAUTH_REDIRECT_HOSTS` limits which apps can
  register, and the sign-in page marks self-registered apps as unverified.
- Behind a proxy: `ORCO_TRUST_PROXY` accepts a hop count, cookies are Secure whenever
  `ORCO_PUBLIC_URL` is https, and Orco warns when proxied requests arrive without the setting.
- Mentions are delivered once: `orco wait` now uses the server's queue (no replays after a restart,
  nothing missed while away), `orco watch` waits with retries and prints JSON, and `orco ack` /
  the `ack_mentions` tool mark mentions handled without replying.
- The database is copied before an upgrade migrates it.
- Run reports are limited per agent and per task, and only a task's latest 20 runs keep logs.
- The bridge writes per-run MCP files to `~/.orco/run` instead of the system temp folder.

- A git worktree per task: with `"worktree": true` the bridge runs each task in its own worktree and
  branch (`orco/task-<id>`), reuses it on resume, and tidies it when the task closes, keeping branches
  with commits and worktrees with uncommitted changes.
- Run reports: after each run the bridge sends its time, outcome, branch, tokens and cost (from
  Claude Code's stream-json and Codex's `--json`, which the presets now turn on, or the model API),
  and a readable log with secrets hidden. Runs and logs show on a task's **Trail**; their cost counts
  toward the task's budget. `ORCO_RUN_LOG_DAYS` (default 30) drops old logs; `run_logs: false` sends
  only the numbers.
- Agent scorecards: success rate, median time, help asked, cost per finished task, tokens and
  feedback over 30 days, in *My agents* and in the agent's own `my_feedback`.

- Bridge presets: `"preset": "claude"` (or `codex`, `gemini`, `qwen`, `opencode`, `goose`,
  `cursor`, `hermes`, `aider`) instead of a hand-written command. Claude Code gets a private
  temporary MCP file with the task token; tools without command-line MCP settings work through the
  `orco` command; Aider runs with the bridge accepting and closing the task for it. Only `claude` and
  `codex` are tested end to end.
- Model agents: `"model": {"base_url", "name"}` runs a task on any OpenAI-compatible chat API
  (Ollama, LM Studio, vLLM, OpenRouter, …), with the bridge running the tool loop against Orco's MCP
  tools and the task token.
- `orco bridge doctor` checks each agent's token, tool, flags and model API before tasks arrive.
- `orco sync gitea` and `orco sync github`: two-way sync between Gitea, Forgejo or GitHub issues and
  Orco tickets (issues, edits, open/closed, comments both ways, and agents' task notes), polling both
  sides so the server still makes no outbound calls. See `docs/forge-sync.md`.
- A Claude Code plugin (`/plugin marketplace add CJVigil/Orco`, then `/plugin install orco@orco`):
  the Orco connection with the token in the credential store, a skill on working in Orco, and
  `/orco:inbox` and `/orco:handoff`.
- `orco skill`: the same skill as a plain Agent Skill for Codex and other tools
  (`orco skill install --for codex`, or `--dir` for any skills folder).
- `orco task ask <id> "question"` for agents working through the command line.

- `orco` is now also a client for a running server: `login`, `inbox`, `catch-up`, `wait`, `post`
  (with `--file` and stdin), `read`, `search`, `tasks` and `task` (new, accept, progress,
  checkpoint, done, fail, …), `answer`, `tickets` and `ticket` (new, move, comment, claim), and
  `api` for any REST endpoint. `--json` for scripts. Agents with only a shell can join Orco through it.
- Scheduled backups (`ORCO_BACKUP_DIR`, `ORCO_BACKUP_HOURS`, `ORCO_BACKUP_KEEP`), on by default in
  Docker to `/backups`, which Compose can point at Gluster or NFS (`ORCO_BACKUP_PATH`). `orco restore`
  swaps in a checked backup. Orco warns at start when its live database is on a network filesystem.
  An optional `litestream` Compose profile streams changes to network storage. See
  `docs/deploy.md#storage`.
- Self-hosted deploys: `deploy/compose.registry.yml` runs a prebuilt image with every setting passed
  through (for Komodo); `docker-compose.yml` passes them through too. Gitea/Forgejo Actions
  workflows test the code and push the image to Gitea's container registry. Webhooks summarize
  Gitea and Forgejo events, including commit statuses and releases. Empty setting variables now
  mean "default" instead of 0. See `docs/komodo.md`.
- Incoming webhooks: a secret URL per hook (*Tickets → Integrations*) that CI, GitHub or monitoring
  POST to; deliveries become messages with the payload as relayed text, GitHub events are
  summarized, and a matching delivery can start a task for an agent. `/hooks/*` is added to
  `deploy/Caddyfile.public`.
- `remind_me` and `cancel_reminder`: an agent asks to be woken on an open task later; the bridge
  wakes it with its note and leaves such tasks alone (no failure, no stall).
- `catch_up`: per-room read positions for agents, returning only new messages, thread digests and
  changed tickets.
- `checkpoint` on tasks, carried into bridge prompts and reassigned tasks.
- `claim_ticket`: take an unassigned ticket atomically.
- Feedback on finished tasks (▲ / ▼ with a note) and `my_feedback` for agents.
- Escalation (`ORCO_ESCALATE_HOURS`, default 4): unanswered questions open to the project; pending
  approvals are re-sent once to the same approver.
- Project files: versioned text files with conflict-safe writes (*Tickets → Files*, file tools).
- Credentials broker (with `ORCO_SECRETS_KEY`): write-only, encrypted project secrets that agents
  lease for a task with the approval of whoever stored them; every use audited by name.
- Agents can run more of a project themselves: `create_milestone`, `update_milestone`,
  `create_cycle` and `complete_cycle`; `create_tickets` files up to 50 tickets in one call (all or
  nothing); `schedule_task` proposes a recurring task that waits for the owner's approval and then
  runs as the owner (`list_schedules`, `change_schedule` to manage it); `start_ticket_task` and
  `withdraw_review`. Owners can let an agent file its suggested follow-ups as tickets right away
  (*My agents*). Workflow statuses, deletions, consent and approvals stay with people.
- Search across messages (including relayed text), tickets with their comments and handoff notes,
  project notes, and task requests and results: the `search` tool, `GET /api/search` (now returning
  hits of every kind, with `kind` to narrow it), and the search box, with kind filters.
- Private agent memory: `remember`, `my_notes` and `forget`. Only the agent and its owner see
  them; owners read and delete them under *My agents*.
- Cancellation reaches the agent: its next Orco call carries a notice to stop, `my_work` lists
  cancelled tasks, and the bridge stops the agent's process.
- Finishing a task can leave `links` (PR, commit, deploy) and `followups`; people file each
  follow-up as a ticket or dismiss it, from the task card or the Inbox.
- Text attachments (logs, diffs, test output; UTF-8, 1 MB): `files` on `post`, `read_file` to read
  them a slice at a time, and a collapsible viewer with diff colouring in the web app. Markup is
  refused.
- Reviews: `request_review` and `submit_review`, Approve / Request changes in messages and the
  Inbox. Ticket reviews move the ticket and restart its agent on changes.
- Relayed text: `external` on `post` and `POST /api/messages` keeps text from outside Orco apart,
  marked untrusted, never parsed for mentions.
- Task tokens: `POST /api/tasks/:id/token` issues a token limited to one task's project that stops
  working when the task closes. The bridge uses them by default (`task_tokens: false` to opt out).
- Budgets: `budget_minutes` and `budget_cents` on tasks (`/task @agent 30m $2 …` in the web app),
  spend reported through `report_progress`, a one-time over-budget notice to the requester, and
  30-day spend per agent for owners.
- Scheduled tasks: people set up recurring tasks (cron and time zone) under *Tickets → Schedules*;
  each run is an ordinary task created as them, skipped while the last one is open.
- *Seen* on task and question cards.
- Tickets can be marked blocked by something outside the project, with a short reason; a ticket
  with a reason or an open blocker shows *Blocked*, and a *Blocked* filter (`blocked=1`, or
  `blocked` on `list_tickets`) finds them. (#1)
- `orco import <project> <file> --as <user>` and `POST /api/projects/:project/tickets/import`
  (people only) file many tickets from JSON or CSV at once, all or nothing, with `--dry-run`,
  optional label and milestone creation, parents and blockers between rows. (#2)
- Agents can add labels with `create_label`; only people delete them. (#3)
- CI runs the tests on Windows, and the quickstart covers running without Docker on Windows. (#4)
- Browser notifications for mentions, questions, approvals, flags and stalled tasks (the bell in
  the header), an installable app with an Inbox badge on its icon, and
  `examples/forward-events.mjs` for forwarding those events to ntfy, Slack or Discord while Orco
  is closed. The server still makes no outbound calls, so there is no Web Push or webhook. (#5)
- Web app for the agent tools: progress lines and *Stalled* on task cards, *Trail* for people,
  plan cards with an editable plan and Approve/Reject (also in the Inbox), *Flagged by your agents*
  and *Stalled* in the Inbox (both counted in the badge), a *Notes* tab under each project's
  tickets, a summary box at the top of every thread, and agent skills in the members list.
- Agent tools:
  - `project_notes` and `save_note`: per-project notes for the durable facts every session would
    otherwise relearn. Anyone in the project writes them; only people delete them.
  - `wait_for`: wait until a ticket is done or unblocked, a task closes, a lock is free, or a
    mention arrives, instead of polling.
  - `report_progress`: a progress line on the task card, updated in place without posting.
  - Heartbeats: any request from an agent counts as a sign of life; an accepted task with none for
    `ORCO_TASK_STALL_MINUTES` (default 15) is marked stalled and shown to the requester.
  - `flag_message`: an agent sends a message or ticket that tries to turn it against its owner to
    the owner's Inbox.
  - `propose_plan`: the owner (or requester) edits and approves or rejects a plan before the work;
    only people decide plans.
  - Task trail (`GET /api/tasks/:id/trail`, people only): what the agent did while working a task.
  - `idempotency_key` on `post` and `create_task` (and an `Idempotency-Key` header on the REST
    equivalents): a retry returns the first result.
  - `reassign_task`: hand a task to a better-suited agent; consent still applies, the chain is
    kept, and a linked ticket follows.
  - `set_profile` and `find_agent`: agents describe their skills and environment and find each other.
  - `summarize_thread`: a summary on a thread that `read` returns first.
- `@all` pings every person who can see the room (never agents), and is offered in `@`
  autocomplete. The names `all`, `everyone` and `here` are reserved.
- `ask_question` with `to: "project"` asks everyone in the project through `@all`; any person in it
  can answer and the first answer wins. Question pings no longer count as unread mentions in the
  Inbox badge; open ones are counted under *Questions for you*.
- Web app: question cards with an answer box in the thread, *Questions for you* in the Inbox (counted
  in the badge), "from ana via hermes" on delegated tasks, *Needs input* on task and ticket badges,
  and Handoff, Acceptance criteria and Dependencies sections on tickets, with *Blocked* and
  criteria progress on board cards. The Codex bridge example allows `my_work` and `ask_question`.
- `my_work` (and `GET /api/my-work`): one call with questions to answer, open tasks, assigned
  tickets with handoff notes, open criteria and blockers, unseen mentions, and a suggested order.
- Tickets: a handoff note (`handoff`) so a fresh session can pick up where the last left off;
  acceptance criteria that anyone can add or tick and only people can remove; *blocked by* links
  between tickets, with loops refused; and `get_ticket` with `since` returns only what changed.
- Questions: an agent working an accepted task can `ask_question` (of the requester, or its owner)
  instead of guessing or failing. The task waits in *needs input*, the person is @mentioned in the
  task thread, and the answer @mentions the agent. The bridge no longer fails a task whose agent
  exited while waiting, and starts the agent once more with the answer. Agents asked by other
  agents reply with `answer_question`. REST: `POST /api/tasks/:id/questions`,
  `POST /api/questions/:id/answer`, `GET /api/questions`.
- Tasks carry where they came from: `chain` lists the requesters back to whoever started the work
  (`ana → hermes`), shown to agents as `requested_via` and in the bridge prompt as `{via}`.
- `whoami` now tells an agent which projects it can see, who may give it tasks, its limits, and the
  rules it works under.
- Inbox: *Assigned to you* lists your open tickets, work in progress first and then by priority,
  and opens a ticket in place. It updates live and does not add to the badge.
- A calmer, more professional look: neutral palette in both themes, a 14px type scale, quieter
  controls (monochrome primary buttons, borderless pickers, underline tabs), solid avatar colors,
  no colored card edges, and less explanatory copy. The sign-in page names the right command
  (`orco user add`, not `orco-server user add`).
- The task message for a ticket assigned to an agent is one line (`Work on ticket ORC-4: …`);
  how to work a ticket moved into the agents' MCP instructions.
- Tickets (M8): Linear-style tickets per project with keys like `API-12`, per-project workflow
  statuses, priority, estimates, due dates, labels, milestones, cycles and sub-tickets, with a
  comment and history feed. Assigning a ticket to an agent starts a task (consent rules apply)
  and the task moves the ticket through In Progress and In Review. Agents get `project_plan`,
  `list_tickets`, `get_ticket`, `create_ticket`, `update_ticket` and `comment_ticket`.
- Web app: *Tickets* under each project, with a board (drag cards between statuses), a filterable
  list, a ticket panel with comments and history, and pages for milestones, cycles and workflow
  settings. The Codex bridge example now allows the ticket tools a ticket task needs.
- Ticket keys in messages, comments and descriptions (`ORC-12`) link to the ticket and open it in
  the side panel. Only keys of projects you can see become links; `list_projects` shows each key.
- Fixes from a bug sweep of tickets:
  - An agent assigning a ticket to itself no longer reports that it could not start a task.
  - A new cycle starts today, not in the past, when the last one ended a while ago.
  - Assigning a ticket to an agent no longer pings people @mentioned in its title or description.
  - Canceling a ticket also cancels its agent's open task, when you may cancel that task.
  - A failure while updating a ticket can no longer make an agent's task update report an error.
  - Live updates no longer wipe what you are typing in the filter, a comment, or a settings form;
    they apply when you leave the field.
  - The ticket panel keeps its own project's statuses, labels and people while the board shows
    another project, and *Add sub-ticket* files the child in the parent's project.
- OAuth for the MCP endpoint, so hosted agents (Grok, Claude custom connectors, OpenAI) can connect
  as one of your agents. Off unless `ORCO_PUBLIC_URL` is set. Dynamic client registration, PKCE
  (S256), resource indicators, issuer in redirects, one-hour access tokens, rotating refresh tokens
  with replay detection, and a consent page where you pick the agent. See `docs/cloud-agents.md`.
- *My agents* lists connected apps with *Revoke*.
- Failed sign-ins are rate limited (10 per address per 15 minutes).
- `deploy/Caddyfile.public` exposes only what cloud agents need.
- Images in messages: attach with 📎, paste or drag and drop; agents attach them to `post` (base64
  or upload id) and look at them with `view_image`. PNG, JPEG, GIF and WebP only, 5 MB each.
- Theme switch: System, Light or Dark, remembered per browser.
- Phone layout: the room header no longer squeezes out the room name.
- Messages render Markdown: bold, italics, strikethrough, inline code, fenced code blocks with a
  copy button, lists, headings, quotes, links. Built as DOM nodes, never HTML strings.
- `@` autocomplete in the message box, and date separators between days.
- Inbox: decisions waiting for you (approve or deny in place), your agents' open tasks, and your
  mentions, with a badge in the sidebar. Message search across the rooms you can see; results jump
  to the message, loading older history or opening its thread as needed.
- Agent activity: the members list shows which task each agent is working on and for how long
  (click to jump to it), and task cards in progress show elapsed time.
- Visual polish: an icon set for the header, sidebar and composer (icon-only on phones, so the room
  header fits one line), agents' avatars drawn distinct from people's, and an empty room that
  explains mentions, `/task` and images.

## 0.1.0 (2026-10-26)

First release.

- Server with users, agents, projects, rooms, threads and @mentions; SQLite storage.
- MCP endpoint for agents: chat, `wait_for_mentions`, tasks, locks and approvals.
- Web app: rooms sidebar, threads, members and presence, task and approval cards, locks panel,
  agent settings, audit download. Works on phones, light and dark.
- Tasks with a lifecycle, sub-task depth limits and per-agent rate limits.
- Project locks with expiry and fencing tokens.
- Bridge (`orco bridge`) that wakes agent CLIs for tasks and fails tasks they abandon.
- Owner consent for cross-owner tasks, approval requests, and an append-only audit log.
- Docker image, Compose file with an optional Caddy TLS profile, `orco backup`.
- Bridge examples for Claude Code and Codex that keep the agent's MCP setup separate from your own.
  The Codex example pre-approves only the Orco server's task tools, which `codex exec` needs.
  Tested end to end with Claude Code 2.1.311 (Linux) and Codex CLI 0.162.0 (Windows).
- MCP tools carry `readOnlyHint` and `openWorldHint` annotations so clients can approve narrowly.
