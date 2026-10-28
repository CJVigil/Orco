# Two-way issue sync: Gitea, Forgejo and GitHub

`orco sync gitea` and `orco sync github` keep issues in a repository and tickets in an Orco project
in step, so people can keep filing issues where they always have while agents work them as Orco
tickets. Below, "Gitea" stands for whichever forge you sync; GitHub works the same way.

| On the forge | In Orco |
| --- | --- |
| A new issue | A new ticket: title, body with a link back to the issue, labels (created in Orco if missing). A closed issue lands in the first *completed* status. |
| The title or body edited | The ticket's title or description follows |
| The issue closed or reopened | The ticket moves to the first *completed* status, or back to the first *unstarted* (or *backlog*) one |
| A comment | A ticket comment: "**ben** on Gitea: …" (or "on GitHub") |
| A comment: "**ana** in Orco (API-4): …" | A person or agent comments on the ticket |
| A comment with the agent's note | An agent finishes the ticket's task with a note |
| The issue closed or reopened | The ticket moved to a completed or canceled status, or out of one |

Not synced: tickets created in Orco (they stay Orco-only), pull requests, assignees, milestones,
and label changes after the first sync.

It runs as its own process beside Orco and polls both sides, so the Orco server still makes no
outbound calls and the forge needs no webhook. It never echoes: it skips changes made by its own Orco
user, and it marks the comments it writes on the forge with a hidden `<!-- orco-sync -->`.

## Set it up for Gitea or Forgejo

1. In Orco, add a user for the sync (a person account, so it can file tickets) and add it to each
   project it syncs:

   ```bash
   orco user add gitea          # prints its token once
   ```

   Then add `gitea` to the project: open one of its rooms in the web app and use *Add member*
   (or `orco api POST /projects/api/members '{"user":"gitea"}'` as a project member).
2. In Gitea, create an access token (*Settings → Applications*) with `read:issue` and
   `write:issue`, for a user that can see the repositories. A dedicated bot user keeps its comments
   recognisable.
3. Write a config file:

   ```json
   {
     "orco": { "server": "https://orco.home.lan", "token_env": "ORCO_SYNC_TOKEN" },
     "gitea": { "url": "https://git.home.lan", "token_env": "GITEA_TOKEN" },
     "repos": [
       { "repo": "home/api", "project": "api" },
       { "repo": "home/web", "project": "web", "labels": false }
     ],
     "poll_seconds": 60,
     "state": "./orco-gitea-state.json"
   }
   ```

   Tokens come from the environment, never the file. `state` (relative to the config file) is
   where the sync remembers which issue is which ticket and how far it has read; keep it, or the
   next start files every issue again.
4. Run it:

   ```bash
   export ORCO_SYNC_TOKEN=orco_u_… GITEA_TOKEN=…
   orco sync gitea gitea-sync.json --once   # one round, to check
   orco sync gitea gitea-sync.json          # keeps running, every poll_seconds
   ```

## Set it up for GitHub

The same steps, with a GitHub token and a `github` section instead of `gitea`:

1. Add the Orco user as above (call it `github`, say) and add it to the project.
2. Create a fine-grained personal access token (*Settings → Developer settings → Fine-grained
   tokens*) limited to the repositories you sync, with **Issues: Read and write** (Metadata: read
   is added for you). A machine user keeps the sync's comments apart from yours.
3. The config:

   ```json
   {
     "orco": { "server": "https://orco.home.lan", "token_env": "ORCO_SYNC_TOKEN" },
     "github": { "token_env": "GITHUB_TOKEN" },
     "repos": [{ "repo": "CJVigil/Orco", "project": "orco" }],
     "poll_seconds": 120
   }
   ```

   For GitHub Enterprise Server, add `"api_url": "https://github.example.com/api/v3"`.
4. `orco sync github github-sync.json --once`, then without `--once`.

GitHub allows 5,000 API calls an hour per token. Each round makes two or three calls per repository
plus one Orco call per synced ticket, so a 60 to 120 second poll stays far below that.

## The first round
 reads every issue in each repository, open and closed. To start with only open
issues, close nothing and archive what you do not want afterwards, or begin with a fresh repository.

## Running it with Docker or Komodo

The Orco image has the `orco` command, so the sync can run as a second service on the same image:

```yaml
  orco-gitea-sync:
    image: ${ORCO_IMAGE:-orco}
    command: ["sync", "gitea", "/config/gitea-sync.json"]   # the image's entrypoint is orco
    environment:
      ORCO_SYNC_TOKEN: ${ORCO_SYNC_TOKEN}
      GITEA_TOKEN: ${GITEA_TOKEN}
    volumes:
      - ./gitea-sync:/config        # gitea-sync.json, and the state file next to it
    healthcheck:
      disable: true                 # the image's check probes the web server, which this does not run
    restart: unless-stopped
```

Point `orco.server` at Orco's address on the Compose network (like `http://orco:7420`). If Gitea is
on your LAN, the sync calls it directly; Gitea's webhook host allow-list does not apply. For GitHub,
use `command: ["sync", "github", ...]` and pass `GITHUB_TOKEN`; the sync's container then needs
outbound HTTPS to api.github.com (Orco's own container still does not).

## Notes

- Each round applies Gitea's changes to Orco first, then Orco's to Gitea. If an issue and its ticket
  both change status between two rounds, the Orco side ends up applied last and wins.
- A failing round (Gitea or Orco unreachable, a token revoked) is logged and retried on the next
  poll; nothing is lost, since the sync reads from where it left off.
- Comments are copied as Markdown text. Attachments, reactions and comment edits are not.
- Pull requests are skipped on both forges.
