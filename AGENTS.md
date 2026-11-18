# meterboard: notes for coding agents

A static page (`public/usage/`) plus two server functions (`api/usage.mjs`, `api/mcp.mjs`). Node built-ins only:
no dependencies, no build step. Run `npm test` before every change is done.

- Settings come from environment variables, read in `lib/config.mjs`. Every one is listed in `.env.example`.
  A new setting goes in both places.
- Data comes through a source in `lib/sources/`. A new source must pass `test/source-contract.test.mjs`.
- Sign-in modes are in `lib/auth.mjs`. Keep them failing closed: real data with no mode set refuses every request.
- `GET /api/usage?config` answers before sign-in. It may only return the fields in `pageSettings`.
- Invoice figures (from bills) and estimate figures (counted by your own tools) are never added together.

## Public vs private

This repository is a public, MIT-licensed project. Treat everything in it, and
every issue, pull request and commit message, as readable by strangers.

**Where a change goes.** Ask: would this help any user, with no personal data?

- Yes: it belongs here, in core.
- No: it belongs in a private fork of this repository (an "instance"), not here.
- Unsure: do not put it here. Raise it with the maintainer.

**Never put in this repository:**

- Real names of clients or companies, account IDs, internal URLs, hostnames.
- Ticket IDs from a private tracker.
- Keys, tokens, passwords, or personal data of any kind.
- Settings that only make sense for one person. Read them from environment
  variables or an `instance/` folder instead.

**Fixes.** A bug in core is fixed here first. Forks pull the fix with a normal
`git merge`.

**Before any push to the public remote,** run the maintainer's pre-push check
and fix everything it reports.

**Commits.** Use the GitHub noreply email for the author on this repository.

**Security reports** go through a private advisory, never a public issue. See
`SECURITY.md`.
