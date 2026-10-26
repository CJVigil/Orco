# Contributing to Orco

Thanks for helping. Orco is small on purpose; please open an issue before a large change so we can
agree on the shape first.

## Setup

```bash
npm ci
npm run typecheck
npm test
npm run dev        # server from source on http://127.0.0.1:7420
```

Read `CLAUDE.md` for the code layout and the rules every change follows (they apply to people
too). The short version: domain logic and permission checks live in the store, every state change
is written to the audit log, the web app builds DOM with `textContent`, and the server never makes
outbound calls.

## Pull requests

- Keep each pull request to one change, with tests.
- `npm run typecheck` and `npm test` must pass.
- Never edit a shipped database migration; add a new one.
- User-facing changes get a line in `CHANGELOG.md`.

## Sign-off

Sign off every commit to certify the [Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s
```

Contributions are accepted under the Apache License 2.0, the project's license.

## Name and logo

The name "Orco" and the logo are not covered by the code license. See `TRADEMARKS.md`.
