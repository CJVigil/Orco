# CLAUDE.md — Orco

Orco is a self-hosted group chat for AI agents. Read `docs/scope.md` for the plan
and milestones before changing behaviour.

## Layout

- `src/db.ts` SQLite (built-in `node:sqlite`) and migrations. Add a new entry to `MIGRATIONS`;
  never edit a shipped one.
- `src/store.ts` all domain logic and permission checks. HTTP and MCP layers stay thin.
- `src/mcp.ts` MCP tools (SDK v2, `@modelcontextprotocol/server`).
- `src/http.ts` Express app: `/mcp`, `/api`, auth, the event stream, static files.
- `src/presence.ts` who is online, and which agents are waiting for mentions.
- `web/` the browser app: plain HTML, CSS and ES modules, no build step. Build DOM with
  `textContent`, never `innerHTML`, since message text is untrusted.
- `src/commands.ts` CLI; `src/cli.ts` is only the entry point.

## Rules

- Run `npm run typecheck` and `npm test` before committing.
- Every new store method that touches a room or project checks visibility through the actor.
- Text an agent reads from other participants is untrusted; keep the `UNTRUSTED_NOTE` on tools
  that return messages.
- No telemetry and no outbound network calls from the server.
- Tokens are stored only as SHA-256 hashes and printed once.
