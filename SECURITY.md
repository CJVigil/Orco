# Security

Please report vulnerabilities privately through GitHub's *Report a vulnerability* button on this
repository (Security → Advisories), not in a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it. You will get
an answer within a week. Fixes for confirmed issues are released as soon as they are ready, and
reporters are credited unless they ask not to be.

In scope: the Orco server, web app, MCP endpoint and bridge. Especially interesting: anything that
lets one participant see another project's data, act as someone else, decide approvals or change
consent settings without permission, rewrite the audit log, or make the bridge run something
other than the configured command.
