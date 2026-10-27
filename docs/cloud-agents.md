# Cloud agents

Hosted agents such as Grok Bot, Claude (custom connectors, including Claude Duet) and OpenAI's
agents run in their vendor's cloud. They add MCP servers as *custom connectors* and sign in with
OAuth instead of a pasted token. Orco supports that flow from version 0.2.

Status: the OAuth flow is tested end to end with the official MCP TypeScript client and in a real
browser. It has **not yet been tested with each vendor's connector**; the per-vendor steps below
follow their documentation and may need adjusting.

## How it works

1. You add Orco's MCP URL (`https://orco.example.com/mcp`) as a custom connector in the vendor's app.
2. The vendor discovers Orco's sign-in endpoints, registers itself, and sends you to an Orco page.
3. You sign in with your Orco user token, see which app is asking and where it will send you back,
   choose **which of your agents it acts as**, and allow or deny.
4. The vendor gets a token that works only on `/mcp`, acts exactly as that agent (same projects,
   consent policy, rate limits and audit trail), and refreshes itself. Access tokens last an hour;
   refresh tokens 30 days and are replaced on every use.
5. Revoke it any time in the web app under *My agents → Connected apps*.

A connected app cannot change settings, decide approvals or read the audit log, same as any agent.

## 1. Give the agent its own identity

Create an agent for each hosted service, so you can tell them apart and revoke one without the
others:

```bash
orco agent add carlos carlos-grok
orco agent add carlos carlos-duet
```

Keep their task policy at *Ask me first* (the default) unless you want other people's agents to
reach them without you. These agents can also act in your email, calendar and other accounts.

## 2. Turn on OAuth

Set the public address people and vendors will use, as an origin with no path:

```bash
ORCO_PUBLIC_URL=https://orco.example.com orco serve
```

The startup log shows `OAuth for cloud agents: on`. Without `ORCO_PUBLIC_URL`, OAuth is off and
nothing below is served. `http://` is accepted only for `localhost` testing.

## 3. Make `/mcp` reachable from the internet, and nothing else

Vendors connect from their own clouds, so the MCP endpoint has to be public. Expose only what they
need and keep the web app on your private network.

**Caddy** (`deploy/Caddyfile.public`): serves `/mcp`, `/oauth/*`, the two discovery documents and
the sign-in page's stylesheet and icon, and answers 404 for everything else.

```bash
ORCO_PUBLIC_DOMAIN=orco.example.com caddy run --config deploy/Caddyfile.public
```

(With Docker Compose, mount it in place of `deploy/Caddyfile` and point the domain at the host.)

**Cloudflare Tunnel**, with the same paths:

```yaml
ingress:
  - hostname: orco.example.com
    path: ^/(mcp|oauth/.*|\.well-known/oauth-(protected-resource(/mcp)?|authorization-server)|style\.css|favicon\.svg)$
    service: http://localhost:7420
  - service: http_status:404
```

Either way, set `ORCO_TRUST_PROXY` (for example `loopback`) so Orco sees HTTPS, marks cookies
`Secure`, and applies sign-in limits per visitor. Without it every request appears to come from the
proxy, so a stranger's failed sign-ins would lock everyone out for 15 minutes.

Exposed to the internet, the sign-in page is a target: failed sign-ins are limited to 10 per
address per 15 minutes, and client registrations to 20 per address per hour. User tokens are
long random strings; keep them private.

## 4. Connect the agent

**Grok (grok.com connectors, Grok Bot).** Connectors → New Connector → Custom, enter
`https://orco.example.com/mcp`, and complete the Orco sign-in when it opens. Grok rejects
localhost and private addresses, which is why step 3 is required.

**Claude (custom connectors, used by Claude and Claude Duet).** Settings → Connectors → Add custom
connector, enter `https://orco.example.com/mcp`, then sign in to Orco. Claude connects from
Anthropic's cloud, so the URL must be public.

**OpenAI.** OpenAI's platform can reach remote MCP servers by URL, and private ones through its
Secure MCP Tunnel. Whether its consumer agents expose custom servers is still unclear; check the
current OpenAI documentation.

## 5. Getting work to them

The bridge cannot start a cloud agent. Tell the agent, in its own instructions, to check Orco on its
schedule: for example *"Each morning and when I ask, call `list_tasks`, accept anything assigned to
you, and report back with `update_task`."* Tasks from other people still wait for your approval
first if the agent's policy is *Ask me first*.

## Limits

- Client registration uses Dynamic Client Registration. Client ID Metadata Documents, which the
  MCP spec now prefers, would require Orco to fetch URLs from the internet and are not supported
  yet. Every client tested so far falls back to registration.
- Orco serves OAuth 2.0 metadata, not OpenID Connect discovery.
- The consent page needs your user token each time you connect a new app from a vendor's site.
