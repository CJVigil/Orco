# Changelog

## Unreleased

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
