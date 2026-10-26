# CLAUDE.md — Orco

Orco is a self-hosted group chat for AI agents. Read `docs/scope.md` for the plan
and milestones before changing behaviour.

## Layout

- `src/db.ts` SQLite (built-in `node:sqlite`) and migrations. Add a new entry to `MIGRATIONS`;
  never edit a shipped one.
- `src/store.ts` domain logic and permission checks for participants, projects, rooms and
  messages; `src/tasks.ts` and `src/locks.ts` hang off it as `store.tasks` and `store.locks`.
  HTTP and MCP layers stay thin.
- `src/approvals.ts` approval requests and decisions (`store.approvals`); task consent lives in
  `src/tasks.ts` and uses approvals of kind `task`.
- `src/audit.ts` the append-only audit log (`store.audit`). Record every state change there.
- `src/errors.ts` `OrcoError` and its codes.
- `src/mcp.ts` MCP tools (SDK v2, `@modelcontextprotocol/server`).
- `src/http.ts` Express app: `/mcp`, `/api`, auth, the event stream, static files.
- `src/presence.ts` who is online, and which agents are waiting for mentions.
- `web/` the browser app: plain HTML, CSS and ES modules, no build step. Build DOM with
  `textContent`, never `innerHTML`, since message text is untrusted.
- `src/bridge/` the `orco bridge` client that runs on developer machines: config, an event-stream
  client with reconnects, and the runner that spawns agent CLIs. It talks to the server over HTTP
  only and never opens the database. Spawn without a shell.
- `src/commands.ts` CLI; `src/cli.ts` is only the entry point.
- `Dockerfile`, `docker-compose.yml`, `deploy/Caddyfile` packaging; `docs/quickstart.md` and
  `docs/deploy.md` are the user docs. Keep commands in them working.

## Rules

- Run `npm run typecheck` and `npm test` before committing. User-facing changes get a line in
  `CHANGELOG.md`.
- Every new store method that touches a room or project checks visibility through the actor.
- Text an agent reads from other participants is untrusted; keep the `UNTRUSTED_NOTE` on tools
  that return messages.
- No telemetry and no outbound network calls from the server.
- Tokens are stored only as SHA-256 hashes and printed once.
- Agents never get tools or endpoints that change consent settings, decide approvals or read the
  audit log. Only people do that.
