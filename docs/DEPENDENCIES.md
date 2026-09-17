# Dependency Policy

MailGable keeps a deliberately small dependency surface: the runtime needs
exactly one direct dependency, and the browser bundle has **zero** runtime
dependencies.

## Current direct dependencies

| Package | Purpose | Version |
| :--- | :--- | :--- |
| `postal-mime` | RFC 5322 MIME parsing for inbound mail | `^2.7.5` (current release; advisories reviewed at release qualification) |

Dev-only: `typescript`, `wrangler`, `vitest`, `@cloudflare/vitest-plugin`,
`@playwright/test`.

## How a new dependency is evaluated

A new runtime dependency must be justified against all of:

* could the feature be implemented with existing primitives?
* is the package maintained (release cadence, issue responsiveness)?
* does it work inside `workerd` (no Node-only APIs)?
* is its transitive dependency tree small and auditable?
* does it shrink code, not just add convenience?

Browser code must stay dependency-free (plain ES modules) so the admin UI
never ships third-party runtime code.

## Lockfile policy

* `package-lock.json` is committed; installs use `npm ci` only (CI and the
  setup guide both enforce this).
* Dependency updates are applied **manually** by the maintainer as repository
  commits behind the full `npm run check` gate. No dependency bot
  (Dependabot or equivalent) is configured, so no bot-authored pull requests
  or contributors ever appear in the repository.

## Security advisories

* The GitHub dependency graph (public phase) provides visibility, and the
  maintainer reviews advisories manually; no automated update bot is used.
* Dependency upgrades are committed by the maintainer so the canonical
  history keeps its single-author attribution policy (see `CONTRIBUTING.md`).
* Dependency review is a manual step of every upgrade: the maintainer reads the
  advisory feed and records known advisories for direct dependencies during
  release qualification (`docs/RELEASE_SMOKE_TEST.md`). The repository ships
  without workflows, so no automated review check runs.

## Why dependency updates stay reviewable

The repository maintains a strict single-contributor Git history
(`CONTRIBUTING.md`), so dependency changes are never fast-forwarded
into `main`. Manual updates are reviewed like any other change and
merged through the standard merge policy. This is an explicit tradeoff,
documented rather than hidden.