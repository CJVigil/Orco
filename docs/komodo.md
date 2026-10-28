# Running Orco with Komodo and a self-hosted Gitea

This is the all-self-hosted setup: the code lives in your Gitea (or Forgejo), Gitea Actions builds
the image into Gitea's own container registry, Komodo deploys it, and Gitea's webhooks reach Orco.
Nothing leaves your network unless you want it to.

```
Gitea repo ──push──▶ Gitea Actions ──image──▶ Gitea registry ──pull──▶ Komodo stack ──▶ Orco
   ▲                                                                                  │
   └───────────────────────────── webhooks (push, PRs, CI status) ◀───────────────────┘
```

## 1. Put Orco in Gitea

Push a clone to a new Gitea repository, or create a pull mirror of `https://github.com/CJVigil/Orco`
(*New migration → GitHub*, with *This repository will be a mirror*) so it follows upstream.

Gitea runs `.gitea/workflows/` and ignores `.github/workflows/` when the former exists, so the
GitHub-only Windows job never waits for a runner you don't have.

## 2. Build the image with Gitea Actions

You need Actions enabled on the repository and an `act_runner` that can run Docker in jobs (the
usual setup: the runner's job containers get the host's Docker socket).

1. Create a personal access token for the user that should own the package, with package write
   access (*Settings → Applications*).
2. In the repository, *Settings → Actions → Secrets*, add `REGISTRY_USER` (that user) and
   `REGISTRY_TOKEN` (the token).
3. If your registry answers on a different host than Gitea's web address, add a repository variable
   `REGISTRY` with that host.

`.gitea/workflows/ci.yml` runs typecheck, tests and the build on every push. `.gitea/workflows/image.yml`
pushes `<gitea-host>/<owner>/orco` with these tags:

| Push | Tags |
| --- | --- |
| `main` | `:main`, `:sha-<commit>` |
| a tag `v1.2.3` | `:1.2.3`, `:latest`, `:sha-<commit>` |

The image appears under the owner's *Packages*. Link it to the repository there if you like.

## 3. Deploy with Komodo

In Komodo, add your Gitea once (core config or *Settings → Providers*):

- a **git provider** for your Gitea domain, with an account and token that can read the repository;
- a **registry** for the same domain (or `REGISTRY`), with an account and token that can read
  packages (a read-only token is enough here).

Then create a **Stack**:

- **Source:** the Orco repository on your Gitea, branch `main`.
- **File path:** `deploy/compose.registry.yml` (pulls the image; builds nothing on the server).
  To build on the server instead, use `docker-compose.yml`.
- **Environment:**

  ```
  ORCO_IMAGE=git.home.lan/you/orco:main
  ORCO_BIND=0.0.0.0                 # or keep 127.0.0.1 and put a reverse proxy in front
  ORCO_HOST_PORT=7420
  ORCO_TRUST_PROXY=uniquelocal      # when a reverse proxy on your network terminates HTTPS
  ORCO_SECRETS_KEY=                 # openssl rand -hex 32, to turn on the secrets broker
  ORCO_PUBLIC_URL=                  # only for cloud agents, see cloud-agents.md
  ```

  Empty values mean "use the default". All settings are listed in [deploy.md](deploy.md#settings).
- **Registry account:** the Gitea registry account from above, so Komodo can pull a private image.
- **Auto update** (or polling for image updates) on, if you want `:main` to follow every push. Pin a
  version tag (`:1.2.3`) instead for production.

Deploy. Komodo shows the container's health from Orco's built-in `/healthz` check.

**Behind your reverse proxy.** Orco listens on port 7420 inside the container. Point Traefik, Caddy
or Nginx Proxy Manager at it and leave `ORCO_BIND` at `127.0.0.1` (or attach the stack to the proxy's
network). Keep the proxy from buffering `/api/events` (server-sent events) and `/mcp`.

## 4. First account, tokens and backups

Open the stack's **terminal** in Komodo (the `orco` container) and run:

```bash
orco user add carlos                 # your web sign-in token, shown once
orco agent add carlos carlos-claude  # an agent token
```

The database is the `orco-data` volume on the server's local disk; redeploys and image updates
keep it. **Don't put that volume on Gluster or NFS** (SQLite can corrupt silently there; Orco warns
at start if it finds itself on one). Put the backups there instead: Orco writes one every 24 hours
to `/backups`, so add to the stack's environment

```
ORCO_BACKUP_PATH=/mnt/gluster/orco-backups   # writable by uid 1000
```

For seconds instead of a day, also enable Litestream by adding to the environment
`COMPOSE_PROFILES=litestream` and `ORCO_REPLICA_PATH=/mnt/gluster/orco-replica` (Docker Compose reads
`COMPOSE_PROFILES` from the stack's `.env`). To move Orco to another server,
see [deploy.md](deploy.md#moving-to-another-host). Schema upgrades run on start; the scheduled
backup from before an upgrade is your way back.

## 5. Gitea webhooks into Orco

1. In Orco, open a project's *Tickets → Integrations*, add a webhook, and copy the URL (shown once).
   Optionally pick an agent to wake and a word to wake it on, like `failure`.
2. In the Gitea repository, *Settings → Webhooks → Add webhook → Gitea*: paste the URL, content type
   `application/json`, and choose events: push, pull requests, issues, and *Commit status* (how
   Gitea Actions and most CI report results). Leave the secret empty; the URL is the secret.
3. **Gitea blocks webhooks to private addresses by default.** If Orco is on your LAN, allow it in
   Gitea's `app.ini` and restart Gitea:

   ```ini
   [webhook]
   ALLOWED_HOST_LIST = private
   ```

   (or list just Orco's host, like `orco.home.lan`). Without this, Gitea's delivery log shows
   "webhook can only call allowed HTTP servers".

Orco summarizes Gitea and Forgejo events ("Status ci / test failure for abc1234 in home/api", "PR #7
opened: …") and attaches the payload as untrusted relayed text. A commit status of `failure` with a
wake word of `failure` starts a task for your agent.

## 6. Agents and your Gitea

Agents work on clones of your Gitea repositories as usual; point the bridge's `cwd` at a clone.
Links they leave on finished tasks (a Gitea PR, a commit) work like any other link. If an agent needs
a Gitea token, store it as an Orco secret (*Integrations → Secrets*) so it asks for it per task
instead of keeping it in its config.

To keep Gitea issues and Orco tickets in step both ways (issues filed in Gitea become tickets agents
work, and their comments and closes flow back), run `orco sync gitea` as a second service on the
same image; see [`forge-sync.md`](forge-sync.md).
