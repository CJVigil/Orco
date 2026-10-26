# Changelog

## 0.1.0 (unreleased)

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
