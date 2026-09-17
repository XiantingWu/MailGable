# Scripts

This directory contains developer, deployment, and maintenance tooling. Cross-platform tooling is Node.js (`.mjs`); advanced/operator cutover and disaster-recovery automation is PowerShell (`.ps1`, Windows/PowerShell).

## Node.js tooling (cross-platform)

| Script | Purpose | Mutates? | Credentials | Platforms |
| :--- | :--- | :--- | :--- | :--- |
| `run-tests.mjs` | Compiles the test build, syntax-checks every `public/js/*.mjs` module, and runs the unit/integration suite | no | none | Node 22.x |
| `verify-migration.mjs` | Applies all D1 migrations to temporary SQLite and asserts schema invariants (fresh install = zero hardcoded mailboxes) | no | none | Node 22.x |
| `verify-attribution.mjs` | Audits all reachable commits for the single-authorized author/committer identity and forbidden attribution trailers | no | none | Node 22.x |
| `setup.mjs` | Guided operator entry point for production provisioning and deployment (`--mode production`, `--dry-run`, `--deploy-only`, `--migrate-only`, `--remove-bootstrap`) | yes | central store (operator token) | Node 22.x |
| `db-remote.mjs` | Applies D1 migrations to the remote database after the operator state gate (`npm run db:migrate:remote`) | yes | central store (operator token) | Node 22.x |
| `live-validation.mjs` | Disposable live-validation runner (`preflight` / `setup1` / `setup2` / `boundary` / `record` / `finalize` / `report`) with sanitized evidence output | yes (external test environment) | live test credentials | Node 22.x |
| `bootstrap-admin.mjs` | One-time administrator bootstrap against a deployed Worker (`origin`, `email` arguments; token and password are prompted hidden — never argv) | yes (auth state) | bootstrap token (stdin) | Node 22.x |
| `configure.mjs` | Interactive/non-interactive wizard: writes `.mailbox/config.json` + `.mailbox/credentials.env` once; idempotent (PRESENT — keeping existing), `--replace` for per-key replacement, `--all-providers` for all three providers | yes (local stores) | operator token (control plane) | Node 22.x |
| `credentials.mjs` | `status` (READY/ABSENT + role + source), `check` (probe verdicts), `apply` (Worker secrets via stdin), `rotate <KEY>` (journaled), `recover` (converge pending rotation) | apply/rotate/recover yes | central store + Worker secrets | Node 22.x |
| `provider.mjs` | `set <provider>` (journaled single switch point), `remove`, `recover`, `status`; minimizes inactive-provider Worker secrets after a switch | yes | operator token (control plane) | Node 22.x |
| `setup-core.mjs` | Pure setup planning/validation (no side effects) | no | none | Node 22.x |

## PowerShell operator tooling

All `.ps1` scripts use `-WhatIf`/`-Confirm` where supported and never print secret values.

| Script | Purpose | Read-only? | Cloudflare scope | WhatIf? | Rollback |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `provision.ps1` | Deploy the canonical Worker, D1 migrations, R2 bucket, Single Redirect rule; remove legacy Worker; optional Email Routing switch | no | Workers, D1, R2, Rulesets, Email Routing, Workers Routes | partial | yes (backups) |
| `preflight-production.ps1` | Read-only inventory of all legacy control planes before a cutover | yes | read across Workers/Routing/Rulesets | n/a | n/a |
| `deploy-production.ps1` | Guarded end-to-end production deployment (dependency lock, exact R2, secret hygiene, routing reconciliation) | no | Workers, D1, R2, Email Routing, Rulesets | no | yes |
| `run-production-with-dev-vars.ps1` | Runs the production launcher using `.dev.vars` credentials with phase checks | no | same as launcher | no | yes |
| `production-credential-forwarding.ps1` | Secure credential forwarding helper (keeps SecureStrings out of child processes) | no | n/a | no | restores Wrangler state |
| `reconcile-email-routing.ps1` | Reconcile/verify every literal domain route and catch-all to the canonical Worker; destination verification, backup, rollback | Check mode: yes; Reconcile: no | Email Routing (rules, catch-all, destinations) | Check mode | yes (complete backup) |
| `sync-routing-mailboxes.ps1` | Synchronize route-derived mailbox identities into D1 (insert/activate/deactivate; never deletes) | Check mode: yes; Sync: no | Email Routing read + D1 query | Check mode | n/a (idempotent) |
| `restore-email-routing.ps1` | Restore a complete Email Routing snapshot with fail-closed catch-all handling | no | Email Routing | yes | yes (pre-restore snapshot) |
| `restore-admin-mail-redirect.ps1` | Restore only the managed Single Redirect rule from a backup | no | Rulesets | yes | yes |
| `harden-admin-mail-redirect.ps1` | Lock the admin redirect to GET/HEAD and exclude POST | no | Rulesets | yes | yes |
| `inspect-email-routing-activity.ps1` | Read-only observability over Email Routing activity | yes | Email Routing activity | n/a | n/a |
| `reconcile-legacy-resources.ps1` | Inventory/clean legacy resources without touching D1 or R2 data | Check mode: yes | Workers/Routing inventory | yes | n/a |
| `reset-admin-password.ps1` | Controlled local administrator password recovery against canonical D1; revokes sessions | no | D1 only | yes | n/a |
| `configure-runtime-routing-sync.ps1` | Configure the runtime routing sync token/zone settings | no | Token management | yes | n/a |

## Guidance

* **Quick start**: use the cross-platform `npm run setup` flow (see `docs/DEPLOY.md`). PowerShell scripts are advanced/maintainer tooling.
* **Secrets**: never embed credentials in scripts; always pass SecureString/secret values and rely on `production-credential-forwarding.ps1`.
* **WhatIf**: every mutating script supports `-WhatIf` unless marked otherwise; verify the dry-run output before executing.
* **Rollback**: routing and redirect scripts write complete backups under `deployment-backups/` before mutating.