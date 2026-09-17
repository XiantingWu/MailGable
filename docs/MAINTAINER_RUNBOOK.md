# Maintainer Runbook

Operational workflow for provisioning, verifying, and maintaining the self-hosted mailbox stack on Cloudflare and the outbound provider (Resend). This document is for **maintainers and advanced operators**; public users should follow `docs/DEPLOY.md`.

---

## Architecture & Invariants

The standard deployment model consists of:

* **Worker**: `mailgable-dev` (or your chosen worker name)
* **D1 Database**: `mailgable-db`
* **R2 Bucket**: `mailgable-r2`
* **Email Routing**: operator-defined mailbox identities routed to the Worker. There are **no special mailbox names** — `hello@`, `sales@`, `orders@`, `support@` all behave identically. Mailbox records and the Cloudflare routing snapshot are the only source of truth.
* **Outbound Delivery**: provider API with signed webhook reconciliation
* **Optional Forwarding / BCC**: `INBOUND_FORWARD_TO` and `AUTO_BCC_ADDRESSES` are operator-optional; `AUTO_BCC_REQUIRED=true` fails closed when BCC is unconfigured

---

## Credential Lifecycle

Credentials fall into three classes:

| Class | Examples | Guidance |
| :--- | :--- | :--- |
| Setup-only (temporary) | `RESEND_SETUP_FULL_ACCESS_KEY` | Create for provisioning, use, then revoke immediately. Never install into the Worker runtime. |
| Runtime (secrets) | `AUTH_PEPPER`, `ADMIN_BOOTSTRAP_TOKEN` (temporary), `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `CLOUDFLARE_ROUTING_READ_TOKEN` | Installed as Worker secrets via the central operator runner; never in `wrangler.jsonc` or committed files. |
| Local operator | `MAILBOX_ADMIN_PASSWORD`, deployment tokens | Held in gitignored `.dev.vars` for automation; never printed. |

Copy `.dev.vars.example` to `.dev.vars` (gitignored) only for local automation; `ops.env.example` documents the setup-only operator credentials. Never commit or print credential values.

## Management Token Minimum Permissions

| Credential | Account Permissions | Zone Permissions |
| :--- | :--- | :--- |
| `CLOUDFLARE_READ_TOKEN` | D1 Read; Workers Scripts Read; Workers R2 Storage Read; Account Settings Read | Workers Routes Read; Single Redirect Read; Email Routing Rules Read |
| `CLOUDFLARE_DEPLOY_TOKEN` | D1 Write/Edit; Workers Scripts Write/Edit; Workers R2 Storage Write/Edit; Account Settings Read | Workers Routes Write/Edit; Single Redirect Write/Edit; Email Routing Rules Write/Edit |
| `RESEND_SETUP_FULL_ACCESS_KEY` | Full Access for domain and webhook setup (temporary) | N/A |
| `RESEND_PRODUCTION_SENDING_ACCESS_KEY` | Sending Access restricted to the configured domain | N/A |
| `MAILBOX_ADMIN_PASSWORD` | Local-only administrator password | N/A |

---

## Deployment & Verification Workflow

1. **Local Preflight Verification**:
   ```bash
   npm run check
   ```
2. **Database Migration**:
   ```bash
   npm run db:migrate:remote
   ```
3. **Worker Deployment**:
   ```bash
   npm run deploy
   ```
4. **Post-Deployment Health Checks**:
   * Verify HTTP access to `/admin/mail/`
   * Verify D1 operations probe
   * Verify R2 storage probe

For a guarded production cutover with rollback, use `scripts/preflight-production.ps1` and `scripts/deploy-production.ps1` (PowerShell, Windows). See `scripts/README.md` for the full inventory.