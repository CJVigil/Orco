# Changelog

## Unreleased

- Plain ticket titles, with rules per project. By default a title is "Area: outcome", at most 70 characters, with no file paths, code identifiers, commit prefixes or listed internal names.
  - Project admins change the rules in Settings.
  - New ticket shows the rules under Title and warns as you type.
  - `create_ticket`, `create_tickets` and `update_ticket` file the title as written but return a `title_note` naming the broken rule. Their descriptions and `project_plan` state the rules.
  - Filters gain "Needs a plain title", which lists tickets for a person to fix. Migration 62.

- Select several tickets and change them in one go.
  - Board cards and list rows get a checkbox: on hover, or by long-press on a phone. Shift-click selects a range, and Esc clears.
  - A bar shows how many are selected and changes status, folder, labels (add or remove), assignee, milestone, cycle, priority or waiting-on, or closes them.
  - It sends one bulk request, all or nothing, with an optional "why" added as a comment, and offers one Undo. Undo is refused if any of the tickets changed since.
- Fixed: the Undo button was white on white in the light theme.

- Sign in on a phone by scanning a QR code on the PC screen.
  - Sign in on another device, and invite links, show a large QR code, drawn by a small built-in encoder that makes no network calls.
  - The code uses `ORCO_PUBLIC_URL`, or the address the page is open at, or one of the server's LAN addresses when you are browsing at localhost, with a picker when there are several. It never points at localhost or 127.0.0.1.
  - When the server listens on this PC only, the app says why phones cannot reach it and how to fix that.
  - `orco user link <name> --qr` prints the code in the terminal.
  - At startup, `orco serve` says whether phones can reach it, which address they should use, and on Windows the firewall rule the port needs.

- Five seconds to undo a tap:
  - Approvals (Yes, No and the "always" choices), question answers, passes, and replies to waiting asks are held in the browser for five seconds with **Undo** before they are sent. Undo, or closing the page, sends nothing, so a mis-tapped approval fails safe.
  - Later, and ticket status, folder, assignee and priority changes (including board drags), get an **Undo (5)** toast that reverses them, but only if nothing newer changed the ticket.
  - Ctrl/Cmd+Z runs the latest Undo when you are not typing.

- Pass on a question with one tap: question cards and Needs you have **Pass**, with three reasons.
  - **Not me** opens the question to everyone in the project now, and it leaves your list.
  - **Use your pick** answers with the option the agent recommended (shown only when it marked one).
  - **Not needed** closes the question, and the agent carries on without an answer.
  - Each reason reaches the asking agent as its next message. `get_task`, `my_work` and the card show who passed and why. `POST /api/questions/:id/pass`. Migration 61.

- Intake forms for new tickets: project admins set up forms in Integrations.
  - A form has a name, a line on when to use it, and fields: text, number, choice, person, item code, location and photo. Each field is required or optional.
  - The form sets the new ticket's labels (created if missing), folder, assignee, priority and who it waits on.
  - New ticket offers the project's forms plus Blank. A form will not file without its required fields, and writes the description as `Field: value` lines that agents can parse.
  - Agents file the same forms with `create_ticket` (`form`, `fields`), and missing required fields are refused by name. `project_plan` lists the forms.
  - Prompt links can open a form with fields filled in (`/new?project=shop&form=Damaged%20pallet&f.Location=Bay%204`).
  - Migration 60. Also fixed: agents' REST ticket creation now counts as a tickets action for agent levels (#131).

- One-tap actions: project admins save buttons, each with a label, an agent, a room, a request with optional `{{fill-in}}` fields, and a budget, in Integrations. The buttons appear in the project's rooms and in Needs you. A tap is an ordinary task from whoever tapped, so policies, budgets and pauses still apply. When the agent's owner approves an action (the owner's own actions count as approved), taps start the agent without asking. Changing the request, agent or room asks the owner again. Schedules have **Run now**. Migration 59.

- Webhooks act only on deliveries that matter:
  - Field filters on headers and body: equals, not_equals, one_of, starts_with and exists, with `[]` for lists, and no regular expressions.
  - **Post only when it matches**.
  - A duplicate key (by default the forge's delivery id), ignored for 7 days.
  - A coalesce key and window (10-3600 s, default 120; by default the CI run's commit). A burst of deliveries shares one task, and each newer one is added to that task's thread.
  - Each hook has Filters and deliveries in Integrations, with the last 50 deliveries: time, event, summary and outcome (posted, task started, held for confirmation, filtered and by which rule, duplicate, coalesced, rate limited, wake failed and why).
  - REST: `PATCH /api/hooks/:id` and `GET /api/hooks/:id/deliveries`. Migration 58.

- Choose what each agent may do in Orco: an agent's owner sets it to Read only, Comment, Work tickets, Full (the default, so nothing changes until someone chooses) or Custom areas, under Settings on the agent. Org admins can cap every agent (`POST /api/tool-cap`). The server registers only the MCP tools the level allows and refuses the same writes over REST with that agent's token. Agents cannot change levels. Every tool is listed in one table (src/tooltable.ts), and a test fails when a tool has no entry. `orco tools` prints every tool, what it touches and which levels may call it, and `whoami` shows the agent's level. Migration 57.

- Unsent text survives: every room, thread and ticket comment box keeps its own draft and attachments in this browser. Switching rooms never carries text or photos into another room or posts them there, and rooms holding a draft show a small ring. A send that does not reach the server (no signal, the server restarting) waits under the conversation as "Not sent yet, retrying", with Retry now and Cancel. It goes when the connection returns, under its own idempotency key, so it posts exactly once. After 30 seconds without the live connection, a banner says "Can't reach Orco. Last reached 10:42." with Retry.

- Links to tickets, messages and tasks: an open ticket has its own address (`#~shop/SHO-12`), which survives a reload and still opens after sign-in, including through a sign-in provider. `#!m/<id>` opens a message in its room or thread, and `#!t/<id>` opens a task's card. A hidden or unknown target says so. Board and list filters and grouping go in the address, so a filtered view can be bookmarked, and each person's last filters are remembered per project. Copy link is on tickets, messages and task cards. When `ORCO_PUBLIC_URL` is set (and is not localhost), `get_ticket`, `create_ticket`, `post` and `create_task` include a `url`. New `GET /api/messages/:id`.

- Answer an agent's question with a photo: answer boxes in Needs you and on the question card have a camera button. A photo can be the whole answer, or go with a picked option or with text. It shrinks and uploads as soon as it is picked, and goes on the answer message the agent receives. The answer also lists the photo ids (`answerAttachments`, shown in `get_task`), and the agent opens them with `view_image`. Migration 56.
- Fixed: question updates threw an error in the browser ("task is not defined"), so a ticket showing the task did not refresh.

- Photos: before upload, the browser shrinks an image whose long side is over 2,400 px, or whose file is over 5 MB, to a JPEG. JPEG and HEIC photos are always re-encoded, which drops location data. HEIC is converted where the browser can read it, and otherwise refused with a message saying what to do. Uploads start as soon as a file is attached, with a progress bar, Retry and Remove. Photos in messages and on tickets open in a full-screen viewer in the app: pinch, wheel or double-tap to zoom, drag to pan, swipe or arrow keys between images, Download, and Esc or Back to close.

- Big pastes become attachments: pasting more than 16,000 characters into a message (10,000 into a ticket comment) attaches the paste as a text file and leaves a one-line note in the draft. Ctrl+Shift+V (Cmd+Shift+V) keeps it inline. A draft over the message limit stays in the box with a note to split it. Agents see a text file's name, size and first three lines (`preview` on message files and ticket files), and call `read_file` only when they need the rest.

- Run as a service: `orco service install | status | start | stop | restart | logs | uninstall` sets up a systemd user service (Linux), a launchd agent (macOS) or a logon task (Windows). All three run one supervisor that restarts the server after a crash, waiting 1 s at first and up to 60 s, and writes a single log. `status` shows the version, uptime, port, log path and restart count. `/healthz` now reports the version and uptime. The container image stays the way to run Orco in Docker; its data and backup volumes are documented.

- Safe updates: `orco update` (and Update in Portfolio > Controls for org admins) backs up the database, builds the new version in a separate worktree, migrates a copy of the database with it and trial-starts it on a spare port, then switches the checkout, restarts the server with `ORCO_RESTART_CMD` and checks `/healthz`. If the new version fails anywhere after the switch, it goes back to the previous version and the backup by itself and says why. A broken release never gets past its trial. For git checkouts on Linux and macOS; container installs pull a new image instead.

- Quote a line: select text in a message or a ticket comment and press Quote; the draft gets the excerpt and its source (`> — quoting message 123`), kept in the reply's own text so it survives edits and copies. Clicking a quote jumps to the source and highlights the excerpt, only when it appears there once, so the wrong line is never marked. Agents get the quotes in `read`, `wait_for_mentions` and `get_ticket` as structured `quotes` with source and excerpt.

- Voice input: a mic beside the message and thread boxes, ticket comments, the new-ticket description and question answers. Speech goes into the draft only; nothing is sent or created until you press Send. A transcript that arrives after the draft was edited or replaced is dropped, not written over it, and Escape cancels a recording. Uses the browser's speech recognition (Chrome, Edge, Safari); without it no mic appears. Server-side transcription is not included.

- Handoff context packs: an agent picking up a ticket (assigned, reassigned, or after a restart or compaction) reads one budgeted selection of its history with `ticket_pack`: the original request verbatim, the handoff note, open criteria and blockers, task outcomes and answers (partial work from failed tasks too), and the newest comments, each with author and time, in order. It says what it left out and how to fetch it; the request is never shortened. The pack size is per agent (its owner sets it, `POST /api/agents/:name/pack-size`). `start_ticket` includes it, and a ticket's task tells the agent to read it first.

- Policies as a file: `ORCO_POLICY_FILE` names a versioned JSON policy for the org and each project (scope gate, build order, Done checklists, area owners, deploy windows, checked rules, permission modes, guest links), kept in git. It sets defaults, `lock` makes settings "managed by policy" in the app, and a project can only tighten the org. `orco policy check <file>` prints what it will do or exactly what is wrong; the server applies it on start (a bad file stops the start) and on `orco policy reload`; `orco policy show` prints what is in force and where each value came from (file, app or default). Example: `docs/policy.example.json`.

- Permission modes per ticket: Supervised (ask before changes, the default), Auto-accept edits (code and docs go ahead, anything outward-facing asks), Auto (routine actions go ahead, risky ones ask), Full access. A ticket takes its project's default unless it sets its own (the picker on the open ticket; the card shows it). Project and org admins cap the mode, and a capped one says who capped it. An agent's `request_approval` on the ticket is approved on the record when the mode allows it; deploys and pushes always ask. Agents see the mode in `get_ticket`. Migration 54.

- Serve Orco under a sub-path: `ORCO_BASE_PATH=/orco/` behind a proxy that strips the prefix (like nginx `location /orco/ { proxy_pass http://orco:7420/; }`). The web app uses relative URLs, so it loads, signs in and gets live updates there; redirects, cookie paths, the OAuth pages, guest links and install snippets carry the prefix, and agents connect to `https://host/orco/mcp`. Set `ORCO_PUBLIC_URL` to the address with the prefix (`https://host/orco`).

- Prompt links: `/new?project=&title=&body=&folder=&assignee=` opens a new-ticket draft, and `/ask?agent=&prompt=&ticket=` puts a task for an agent in the composer. Nothing is created or sent until the reader presses Create or Send, unknown parameters are dropped, and the reader's own access applies. Copy as link on a new-ticket draft makes one.

- Guest links: Share with guest on a ticket gives one link for one person with no account: it opens that ticket only (title, status, next step, comments, refreshed live), in the first browser that opens it, for 24 hours, until Stop sharing, a new link, the ticket closing, or an org admin turning guest links off (`POST /api/guest-settings`). A guest's question (with a photo, from the phone camera) waits on the ticket as a request until someone in the project presses Send, which comments it on the ticket with the photo and tells the ticket's agent, or Dismiss. Guest activity is audited; tokens are stored hashed. Migration 53.

- "What got done" report: a project's Report tab shows today or this week (for a folder too) on one page: tiles for done, going live next (with its approval), waiting on a person and new requests, a timeline of the day's events with times, open work by folder as bars, and who is waiting on whom, in plain language with ticket keys small. Only real events count (created, status changes, comments, approvals), not folder sorts or relabels. Print it as a one-page landscape PDF from the browser, or download Markdown (`GET /api/projects/:name/report`, `format=md`); agents get `day_report`. Admins schedule it into the project's #general for named people (`POST /api/projects/:name/report-schedules`, a cron like Fridays at 16:00). No email: Orco sends none. Migration 52.

- Admin digest: what was done with permissions, from the audit log: deploys and pushes approved and by whom (flagged when outside a window or during a freeze), standing approvals granted and used, checked rules hit and overrides with their reasons, secrets requested and used (names only), new members and agents, token rotations, pauses, freezes and budget alerts. Each line names its audit entry. Written every Monday with the weekly digests (org admins: `GET /api/admin-digests`), and open for any date range for the org or a project you administer (Portfolio > Digest; `GET /api/admin-digest`). In the app only: Orco sends no email. Migration 51.

- Incident tickets: open one from a message (its Incident action) or with `open_incident`, linked back to the alert, labelled `incident` and urgent, with the postmortem to write: timeline with timezone, impact, root cause, fix, prevention steps and owner. It cannot close as Done until every section has content and each prevention step names a follow-up ticket. Its other labels are tags: `list_incidents` (and `GET /api/projects/:name/incidents?tag=`) lists incidents by tag with their root cause.

- Checked rules: org admins add rules with a name, a pattern (text or regular expression) and where to check it: plans, approval requests, and code blocks or diffs in agents' messages and ticket comments. A match blocks the plan or approval, naming the rule and telling its owner; in a message it is flagged in the thread. Five examples ship switched off (Docker socket mounts, `ports:` in compose, terminals on servers, skipped hooks, force-pushes to main). Portfolio > Controls; `/api/checked-rules`. Migration 50.

- Deploy windows and freezes: org or project admins set weekly windows ("production deploys Wed 13:00-17:00", or never "Mon-Fri 06:00-17:00") in the server's timezone (`ORCO_TIMEZONE`), and freezes with a reason and an end time (Portfolio > Controls; `/api/deploy-windows`, `/api/freezes`). A deploy or push approval request during a freeze is refused with the freeze's reason; outside a window it is flagged on the card for the approver, or refused if the window says so. An admin can go ahead anyway with a reason (`override`), which is audited and shown. Freezes show as a banner at the top and in every agent's `my_work`. Migration 49.

- Area owners: project admins name owners (people) for a folder or label (Settings > Area owners). A ticket in an owned area needs an approving review from an owner before it goes Done, and a deploy or push approval on it waits for that review too. The card says "Needs review from ana (Infrastructure)", and a refused Done asks the owner, so it lands in their Needs you. Owners hand reviews to someone for a date range (`POST /api/delegations`). Reviews can be guided: `request_review` takes ordered stops (what changed and why, with a path or diff excerpt) and look-closely items, and Approve stays off until each is ticked. Migration 48.

- Definition of Done: checklist templates by label add their items as acceptance criteria when a ticket gets the label (`service` brings the platform checklist, `ui` "works at phone width"; org admins set templates for every project, project admins their own, in Settings). Required items must be checked before the ticket goes Done; a project admin can close it anyway with a one-line reason (`done_override`), audited and shown on the ticket. Files has New plan: `plans/NNN-<slug>.md` from the team's plan template (Status through STOP conditions) with its row in `plans/README.md`. Migration 47.

- Build order rules: "tickets labelled `ui` wait for milestone Skeleton", or for another label's open tickets. A waiting ticket cannot be started, claimed to start, or handed to an agent, the refusal says why, and the card shows "Waits on Skeleton" until the milestone's tickets are done, when it unlocks on its own. Project admins add rules in Settings > Build order (one click adds the Skeleton milestone with its checklist and the ui rule); org admins add rules for every project, which projects cannot remove (`/api/order-rules`). Migration 46.

- Scope gate: new projects start in Scope. Their build tickets stay in Backlog, and agents' approval requests for repos, stacks or deploys are refused, until `scoping/SCOPE.md` has content under every section of the template (built in: why this exists, what already exists, what the investigation established, operating mode, architecture, scope by phase, what it owes other projects; org admins can change it) and a project admin approves it. Refusals say which sections are missing. Tickets labelled `scope` are the scoping work and move freely. The approval is recorded as a decision naming the file version; editing SCOPE.md afterwards needs approval again. Org admins can take a project out of the gate, or turn it off for new projects; `ORCO_SCOPE_GATE=off` starts new projects without it until they choose. Migration 45.

- Commits on tickets: a push to a project webhook (GitHub, Gitea, Forgejo) links each commit whose message names one of the project's tickets (SHO-12) on that ticket, with its sha, branch, author and link; CI deliveries mark it passed, failed or running, and a successful deploy job marks it deployed. CI results are kept per repository, branch and commit, and `wait_for` takes `ci` (a sha or a branch). For an Orco the forge cannot reach, `orco forge-poll` runs on a machine that can reach both, polls the forge's API and posts to the webhook; the server still calls nothing. Migration 44.

- Spend per ticket: agents report a session's tokens and cost (`report_usage`, `POST /api/usage`; the Claude Code plugin does it at the end of each turn from the session transcript), booked on the ticket named or the agent's one ticket in progress, only the growth each time. A ticket shows what agents spent on it, and each project has a Spend tab: the most expensive tickets this week, and totals by folder, person, agent and day (`GET /api/projects/:name/spend`). Budgets show what is left, where an even month would be, and the day the cap runs out at this pace; whoever set the budget hears once when that falls before month end. Migration 43.

- Agent comments, ticket changes (handoffs included) and task results take `session_url`, the Claude session that did the work; the ticket shows a small Open session link on those entries, and a finished task lists it with its links. The Claude Code plugin fills it in on web sessions. Orco keeps the link only, never transcript content.

- Tickets are MCP resources (`orco://ticket/SHO-12`: description, handoff, criteria, files and the latest comments), so Claude Code can @-mention them; an agent's own open tickets are listed and refs complete. `start_ticket` claims a ticket (or keeps it if it is yours), sets it In Progress and returns it with the project notes in one call. Plugin commands `/orco:ticket <ref>` (read only) and `/orco:start <ref>`.

- Tool use: every MCP call is counted per agent, tool and day (calls, errors by code, reply size, time), kept on this server for 90 days and never sent anywhere. Org admins see it in Portfolio > Tool use (`GET /api/tool-usage`), biggest replies first. Migration 42.

- Smaller MCP replies: `list_tickets` returns one line per ticket by default (ref, status, title, assignee, folder, blocked, waiting on, next step; 90 tickets in under 10 KB) and JSON rows with `fields` (`"ref,priority,labels"` or `"all"`). `get_ticket` returns the last 10 activity entries unless `activity_limit` asks for more, and takes `fields`; `list_tasks` and `search` take `fields`. Long replies are no longer indented.

- Claude Code plugin hooks: a session opens (and reopens after resume or compaction) with what waits on the agent and the handoff of each ticket it has in progress; between turns one line says when new mentions or answers arrived, silent otherwise and quiet when Orco is down. `orco watch --max-hours N --text` blocks until a real mention, for a background watcher instead of a 280-second loop. New `GET /api/activity?after=` and `GET /api/my-work?format=brief`.

- Approval cards and ticket asks (Needs you and in chat) say "Approving this in Orco may need approval again in the agent.": an agent's own safety check can still ask in its session.

- Shared artifacts: people and agents publish pages into a project or onto a ticket (HTML, Markdown, or a bar or line chart from JSON) with `publish_artifact`; publishing with the id adds a version and old versions stay viewable. They show in a project's Artifacts tab, on their ticket, and as a card when a message links `#!artifact/N`; they open beside the conversation, full width on a click. HTML runs in a sandboxed frame with no same-origin and no network, so a page cannot read Orco's cookies or call its API. Also `list_artifacts`, `read_artifact`. Migration 41.

- Files on tickets: PDF, Word, Excel, PowerPoint, CSV, text and images up to 25 MB, attached to a ticket or a comment (drop them on the ticket, or the clip on the comment box; `attachment_ids` on `create_ticket`, `update_ticket` and `comment_ticket` after `POST /api/ticket-files`). A Files strip lists them with who added each and when; images and PDFs preview, the rest downloads. Agents get `list_ticket_files` and `read_ticket_file`, which returns the text inside: spreadsheet rows as CSV, Word paragraphs, slides, PDF text. Types are recognised by their bytes. Migration 40.

- Private tickets: only the creator, assignee, the person it waits on, project admins and their agents see one; for everyone else it is missing from the board, search, digests, `list_tickets` and a direct ref (not found). Set by the creator or a project admin (`private` on create and update, web: Make private); a lock marks the card. Tickets move between projects (`update_ticket` `project`, web: Move to…) and keep comments, criteria and history; the old ref keeps opening them. Migration 39.

- Split view: the ticket, file or image you open sits beside the conversation, with a divider you drag (remembered per person) and double-click for full width; images and text files now open there. The sidebar follows the Claude app: Needs you on top, Home (the lobby), your projects with their tickets, folders and rooms, then Recent rooms and tickets, each group foldable, with unread dots. Fewer borders, tighter rows.

- Keyboard first, like Claude Code (#93): **Ctrl+K** (⌘K) opens a palette that finds any room,
  ticket (by key or words), place or person as you type, and acts on the open ticket (assign, move,
  next step, ask someone, folder); Tab on a ticket gives its actions. `/` in the composer or a
  ticket's comment box lists the commands with what each does: `/ticket`, `/assign`, `/next`,
  `/waiting`, `/done`, `/search` and `/task`. Typing a ticket key (`SHO-`) suggests tickets (Tab
  accepts). Up in an empty composer edits your last message (`POST /api/messages/:id/edit`: people,
  their own plain messages, within a day; it pings no one new and the audit log keeps the old text),
  and Escape closes the open panel.
- Agent work at a glance (#94): `report_progress` and `update_task` take `steps`, the agent's whole
  checklist (pending, in progress, done; the text may be left out), shown as a live todo list on the
  task card that ticks as the agent reports, like Claude Code's. A status line above the composer
  says who is on what in the room ("carlos-claude · working · 12m · step 2/4", waiting on you, idle,
  failed), the ticket panel ends with the same line, and ticket cards show a small 3/5 bar.
- Approvals and asks as permission cards (#95), like Claude Code's prompt: the question in bold,
  exactly what it covers (scope, a command, a colored diff) in monospace, then numbered choices you
  can press 1, 2 or 3 for while the card has focus. **1 Yes**; **2 Yes, and don't ask again for this
  kind on this ticket** (the agent passes `kind`, like "push to main", to `request_approval`; later
  requests of that kind on the ticket are approved at once for a week or the hours asked, unless
  they look like a different risky action, and each one is posted and audited); **3 No, and tell
  the agent what to do instead**, a one-line reply it receives. Owner approvals for tasks keep
  "always allow" as their second choice, and waiting-on asks number their replies. The ticket shows
  standing approvals with **Stop** to end one early (`POST /api/approvals/:id/revoke`).
- Messages read like a Claude Code turn (#92): the first line of a longer message (and of ticket
  comments and handoffs) is its headline; lines like `● Ran tests ⎿ 1776 passed` (or a ```` ```work ````
  block) show as compact rows with their result, extra lines folded; ```` ```diff ```` blocks color added and
  removed lines; `path/file.js:123` is a chip that copies itself and ticket keys are chips that
  open the ticket. A long message folds between blocks, so it collapses to its headline and work
  rows instead of cutting a code block in half.

## 0.2.0 (2026-11-03)

Second release. The highlights since 0.1.0, with every change listed below them:

- **Tickets and planning** (M8): boards, lists, milestones, cycles, labels and folders, with a
  ticket's next step and the person it waits on up front. Assigning a ticket to an agent starts a
  task.
- **Agents that keep going on their own** (M9–M11): `my_work`, questions with options, handoff
  notes and acceptance criteria, progress and stall detection, plan approval, search, private
  memory, budgets and scheduled tasks.
- **Webhooks, reminders, escalation and an encrypted secrets broker** (M12), and OAuth for cloud
  agents (M7; testing with each vendor is still to come).
- **For people**: *Needs you* (what waits on you, three at a time), a slimmer Inbox, notifications
  with quiet hours and a daily digest, Portfolio, Onyx knowledge search, and a quieter web app that
  works on phones.

Upgrading: the database migrates on start, after a snapshot of it is saved to `ORCO_BACKUP_DIR`
(or next to the database file). Agents see the new tools when they reconnect; update `orco` on each
machine that runs a bridge (`npm install -g http://<your-server>/install/orco-0.2.0.tgz`).

- Folders for tickets (#91): group a project's tickets by area. The board shows a collapsible lane
  per folder and the list a group per folder, each with its open count; drag tickets between them,
  or pick a folder in the sidebar (under *Tickets*) to see only it. *Group by parent ticket* shows
  existing epics the same way. Tickets take `folder` (MCP, REST, the ticket panel and *New ticket*),
  `list_tickets` filters by it (`"none"` for no folder), and `list_folders` / `create_folder` let
  agents file work into the right area. People rename, reorder and remove folders in Settings.
- Yes / No for asks that are questions (#90): a `waiting_ask` ending in "?" gets *Yes* / *No*
  (and *Not yet*) instead of *Done*, in Needs you and on the ticket, so "Done" never has to mean
  "yes". Agents can offer their own replies with `waiting_options` (1 to 6), and the answer reaches
  them word for word ("answered … : Yes"). `waiting_on: ""` clears the ask, for clients that cannot
  send null.
- Quieter screens: a ticket shows only the fields and sections that have something in them, with
  one "Add" line for the rest (handoff, description, criteria, blocker, sub-ticket) and one link for
  unset fields. Needs you cards carry one "Later" instead of two snooze buttons, and the reply box
  on an ask opens from "Reply". A task card's Trail and Cancel appear when you point at or tab to
  it, and Add member moved into the room's ⋯ menu.
- Tickets keep their everyday views in view (Board, List, Notes, Files); Milestones, Cycles,
  Schedules, Integrations and Settings sit under More. Filters other than search open from one
  "Filters" button (they stay open while one is set), the board's Focus switch moved onto that
  line, and a column's "+" shows when you point at the column.
- One place for each thing: a person's Inbox now holds mentions and suggested follow-ups (with
  their agents' open tasks folded under one line) and points to Needs you for approvals,
  questions, asks, reviews, flags and stalled tasks, which no longer show twice. The Needs you
  badge counts flags and stalled tasks too, matching what the page lists. New project and How Orco
  works moved into the menu under your name (New project stays in the sidebar until you have a
  project).
- Fewer things competing for attention: each agent in My agents shows its name, Connect and its
  last 30 days, with its settings folded behind one line that says how they are set ("Settings ·
  Ask me first · Strict filter"); New token moved in there. A thread with no summary shows one
  "+ Add a summary" link instead of an empty box. Board cards say "No next step" only for work in
  progress that nothing else explains. A ticket's "Ask someone" sits on its Next line. The comment
  box is one line until you click in. The working dot pulses a few times when it appears, then
  stays still.
- The bell in the sidebar opens *Notifications*: turn them on for this device, what notifies you,
  quiet hours and the daily digest, all in one place (they left the bottom of Needs you, which now
  holds only what to act on). Sidebar groups fold when you click their name; a folded group still
  shows any room with something new and the one you are in, and the server-wide rooms start folded
  once you have a project. Ticket list rows hide the no-priority bars and the empty assignee circle
  until you point at them, and a room's "Set status" shows when you point at its header. On touch
  screens, tap a message to show "Reply in thread" instead of it sticking after a scroll.
- Layout fixes: agent settings no longer spill out of the My agents panel, task cards and their
  progress line fit on phones, board columns keep a readable width on phones, and a folded Backlog
  shows its count at the top of the column. Portfolio totals sit in one even row.
- Calmer notifications (#89): "Only what needs me" (the default) shows approvals, questions,
  reviews and asks at once and batches agent updates into one notification per 10 minutes; "All
  mentions" adds people's mentions; "Off". Quiet hours hold everything and send one summary when they
  end. Needs you items can be snoozed for an hour or until tomorrow. Opening the Inbox no longer
  marks mentions read: each one is read when opened (or with "Mark all read"). Settings follow the
  person across devices (`POST /api/me/settings`).
- A daily digest per person (#88): on weekdays at the time each person picks, at most three things
  waiting on them, "+N more" and one line on what agents finished, as a notification and at the top
  of Needs you; nothing is sent when nothing waits. Also `GET /api/digest/me` and `orco digest`, so a
  team can forward it from its own scheduled job.

- "Needs you" (#82): after signing in people land on the few things waiting on them (approvals,
  questions, asks, reviews, their unblocked tickets), three at a time with their action inline;
  agents' tasks and plain mentions fold into one FYI line.
- The next step and "waiting on" show on cards, list and Inbox rows and at the top of a ticket,
  with one-tap Done / Not yet / reply for the person it waits on (#83, #85).
- Long text folds (#84): agent comments show their first line, people's comments show in full with
  a tint and a Person label, long descriptions, handoffs and messages fold after about 8 lines, runs
  of field changes fold into "N changes", and Activity has a remembered "People only" toggle.
- States at a glance (#86): each card shows one state on its left edge with an icon and words
  (waiting on you, blocked by what, stale after 7 days without a status change, working). The
  board's Focus toggle shows only the last week of Done and folds Backlog to a count, and columns
  share the width so five fit at 1,440px.

- Agents are told how people read them (#87): the server instructions and the writing tools say to
  lead with the point, put the next step second and keep asks to 3 bullets; a comment, post, task
  note, description or handoff over about 1,200 characters (or with a first line over 120) comes back
  with a note. See docs/writing.md; "How Orco works" has the short version.
- Tickets have a one-line `next_step` (and who it is for), and `waiting_on` a person with a one-line
  ask that reaches their Inbox and `my_work`; they reply done, not yet (snoozed a day) or a line,
  which clears it and wakes the assigned agent (`POST /api/tickets/:ref/waiting`).

- A safety filter between agents of different owners (#81). An agent's posts and task requests are
  scrubbed of anything that looks like a secret (tokens, keys, private keys, cookies, `KEY=value`
  settings, passwords in URLs), and the agent is told what was removed. A message or task from
  another owner's agent that asks for credentials or permissions, a shell command, a deploy or push,
  or a deletion waits for the receiving agent's owner to approve or deny; approving passes it on.
  Owners set each agent's filter under *My agents*: strict (the default), normal (lets through
  senders they always allow) or off. Every scrub, hold and decision is in the audit log.

- Multiple-choice questions (#77): `ask_question` takes `options`, a `recommended` pick and
  `multi_select`, and several `questions` at once (each on its own ticket or task). In the web app
  each option is one tap, with free text as "Other". The answer is also posted on the ticket.
- Answers are decisions (#78): a person's answer to an agent's question is recorded as a decision
  tied to the ticket; `decisions` filters by `ticket`, and `get_ticket` shows them.
- Approvals with a ticket, a scope and an end (#79): `request_approval` takes `ticket`, `scope` and
  `valid_for_hours` (up to a week). It shows on the ticket and in its history; `get_approval` says
  `in_force`; `wait_for` wakes on `approvals`; an approval given becomes a decision on the ticket.
- `remind_me` takes `ticket` instead of `task_id` (#80).

- Waiting tools (`wait_for_mentions`, `wait_for`, approvals and locks) wait at most 280 seconds,
  still accepting up to 300: a silent 300-second wait was cut off by Node's fetch and many proxies,
  ending in an error instead of an empty answer (#75).
- `update_tickets` takes a `comment`, in `set` or per ticket, posted with each change (#76).

- Ticket writes over MCP (`create_ticket`, `update_ticket`, `claim_ticket`, `start_ticket_task`)
  reply with a summary, criterion ids and `last_activity_id` instead of the whole ticket; `full:
  true` gives the old reply (#65). `claim_ticket` and `start_ticket_task` now reply as `{ ticket }`
  like the others.
- `update_tickets` (and `POST /api/tickets/bulk`) changes up to 50 tickets at once, all or nothing,
  counted as one post (#71).
- Close a ticket as a duplicate or superseded: `duplicate_of` / `superseded_by` on `update_ticket`,
  shown on both tickets (#73).
- When a ticket's last blocker closes, it gets a history line and is touched, so `catch_up` shows
  it (#74). Description edits read as updated or cleared in the history, not null → null (#70).
- `start_ticket_task` on your own ticket opens a task from your owner (#66); tool descriptions say
  which assignments start tasks, that criterion ids come from `criteria_items` (and the error lists
  them, and `create_tickets` returns them) (#68), and text limits are in the schemas (#69).
- Docs: the start-at-login recipes use full paths to Node, Orco and the database (#67); any
  restart, upgrades included, needs open agent sessions to reconnect (#72).

- Security: a ticket's linked tickets (blocked by, blocking, and their history) in projects the
  reader cannot see are shown as hidden, as the roadmap and digests already did.

- Tasks can expire (#59): `expires_in_minutes` on `create_task` and `schedule_task`, `expires_at` on
  the REST route. One that has not started in time is cancelled with an "Expired" note and its
  requester told; it can no longer be accepted or get a token.
- One bridge per task (#58): a bridge claims a run before starting it, and a newer bridge for the
  same agent takes over (the older one hears `takeover` and stands down).
- Agents lost mid-task (#57): a restarted bridge fails, or with `"recover": "resume"` re-runs once,
  a task it was running when it stopped; owners set what happens when an agent goes quiet (tell the
  requester with the last checkpoint, hand the task to another of their agents, release its locks).
- Accepting a task that is already yours and accepted is no longer an error.

- Live updates that survive a drop (#60): event frames carry ids, a reconnect with `Last-Event-ID`
  replays the missed messages and sends `resync`, and a restart sends `shutdown` first. The web
  app, the bridge and `examples/forward-events.mjs` pick up where they left off.
- Follow rooms without being mentioned (#64): `wait_for` takes room patterns (`ops/*`, `*/alerts`)
  and returns the new message ids; `/api/events` takes `?rooms=` and `?types=`.
- Room status (#62): one current-state line per room, replaced in place and optionally expiring,
  shown under the room name, in `read` and `catch_up`, and sent to streams on connect.
- Presence (#61): going quiet is an event too, with who, the new status, last seen and why, sent to
  people who work with them; last seen is kept across restarts and shown by `list_participants`
  and `find_agent`.
- `wait_for_mentions` (#63): at most `limit` (50) at a time with a remaining count, and `after_id`
  to acknowledge, so a lost reply or a dead session never loses a mention. `orco watch --after ID`.

- Security: a live event stream ends when its credential stops working (a new token, signing out,
  an expired session, a finished task), and read-only project members can no longer release other
  people's locks.

- Spend is counted when it happens (#50) in a ledger that outlives agents, and the $50 a month for
  people who are not org admins counts what their agents spent on the org's models, removed agents
  included (#49): lowering a budget or removing an agent no longer frees the allowance.
- Agents that run on Orco (#52): each model turn asks for no more output than the budget can pay
  for, model calls never follow redirects, a model that reports no usage is charged an estimate,
  and *Try it* shows fixed messages instead of the provider's error text.
- OpenID sign-in (#51): a login an org admin added is tied to a provider account only after its
  person confirms it once with their sign-in link, not by whoever signs in first.
- Agents can ask a question on a ticket that has no task (#53): `ask_question` takes `ticket`, and
  starts an accepted task for it on the owner's behalf.
- Ticket history says "updated the handoff note" instead of showing null → null (#54).
- Agents are told that only people create projects, and to ask instead (#55).
- `orco serve` and the quick start explain reconnecting an agent session that started while Orco was
  down, with start-at-login recipes for Linux, macOS and Windows (#56).

- Search Onyx from Orco: an org admin connects an Onyx server (onyx.app) under Portfolio → Controls,
  with an API key stored encrypted and optional limits (an Onyx agent, document sets, sources).
  People get an *Onyx* tab in search, and agents a `search_knowledge` tool, for company documents
  from Slack, Drive, Confluence and the rest. Orco calls Onyx only when someone searches.
- Agents check Onyx on their own: when an agent accepts a task, the answer carries the top three
  Onyx results for it (the request, plus the titles of tickets it names). A failed search never
  fails the accept. On by default; org admins turn it off on the Onyx card.

- Fixes for agents that run on Orco (#43-#45): a model with an API key needs prices; agents stop
  at their budget during a run, and past it only an org admin lets more work start; people who are
  not org admins run at most 3, with $50 a month between them (50 per server); *Try it* is short,
  rate-limited and counted; changing a model's address needs its key again (keys are bound to it);
  removing an agent clears its project limits and budget.
- Fixes for OpenID sign-in (#46-#48): sign-in state lives in an encrypted cookie, so nobody can fill
  up the server and lock others out, and only real sign-ins count toward the limit; a login is tied
  to the provider account that first used it; `nbf` is checked, several audiences need `azp`,
  requests to the provider never follow redirects, and the sign-in page shows its own words for
  errors.

- Sign in with an OpenID Connect provider (#41): Gitea, Forgejo, Google, Microsoft, Keycloak and
  others, with `ORCO_OIDC_ISSUER`, `ORCO_OIDC_CLIENT_ID` and `ORCO_OIDC_CLIENT_SECRET`. Orco checks
  the ID token itself (PKCE, signature, issuer, audience, expiry, nonce) and maps verified emails to
  people with the same linking rules as proxy sign-in; `ORCO_OIDC_DOMAINS` limits email domains.

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
