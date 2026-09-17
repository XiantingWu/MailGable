# Operations

## Daily maintenance

The Worker's scheduled trigger (`17 4 * * *`) runs storage cleanup: retention enforcement, trash purge, and the bounded retention of delivery events, audit logs, probes, and forward attempts. No operator action is required.

## Health checks

* `GET /healthz` — public liveness probe (`{"ok":true}` only).
* `GET /api/admin/mail/config` — reports database/archive/sending/webhook configuration state and forwarding configuration.
* `POST /api/admin/mail/ops/storage-probe` — verifies D1 and R2 read/write/delete integrity end to end.

## Monitoring

* Workers observability (`observability.enabled`) collects requests; the admin UI shows Cloudflare route sync state and forwarding failure counts.
* `LOG_LEVEL=debug` is available but must never be enabled by default; logs never contain raw MIME, bodies, keys, or tokens.

## Backup

D1 and R2 are Cloudflare-managed; you are responsible for backups if you need them:

* D1: `npx wrangler d1 export DB --remote --output=backup.sql` (see Wrangler docs)
* R2: bucket-level tooling or dashboards

## Administration

* Bootstrap: complete the first-run wizard, then delete `ADMIN_BOOTSTRAP_TOKEN`.
* Password reset: `scripts/reset-admin-password.ps1` (PowerShell) or re-bootstrap a fresh database.
* Session hygiene: "Sign out all devices" in the Security dialog revokes every session.

## Operational scripts

`scripts/` contains guarded PowerShell tooling for deployment automation:

* `provision.ps1` — resources, Worker deploy, redirect, secrets hygiene
* `preflight-production.ps1` — read-only inventory before cutover
* `deploy-production.ps1` — guarded end-to-end deployment
* `reconcile-email-routing.ps1` / `sync-routing-mailboxes.ps1` — routing reconciliation
* `restore-email-routing.ps1` / `restore-admin-mail-redirect.ps1` — rollback tooling
* `reset-admin-password.ps1` — local administrator recovery

See [MAINTAINER_RUNBOOK.md](MAINTAINER_RUNBOOK.md) for the full runbook.