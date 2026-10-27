# Changelog

## Unreleased

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
