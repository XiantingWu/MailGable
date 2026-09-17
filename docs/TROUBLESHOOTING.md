# Troubleshooting

## Sending fails with "provider outcome unknown"

The request reached the provider but no confirmation was returned (timeout or connection issue). The message is archived and remains `retryable_failed`. Open the thread and use **Safe retry** — the original `Idempotency-Key` prevents duplicates within the provider-specific safe-retry window (Resend 23h, Brevo 25m; Cloudflare unknown outcomes are never auto-retried). Never edit the message before retrying.

## "The safe provider retry window expired"

More than the provider-specific safe-retry window passed since the first attempt and the provider record is unknown. Check the provider dashboard for the original message using the archived provider message id (`provider_message_id` in D1), then send a new message.

## No inbound mail arrives

1. Confirm the address is a **verified destination** and a routing rule with a `literal to` matcher exists for it.
2. Confirm the rule action is **Send to a Worker** with the MailGable worker selected.
3. Check the **Cloudflare routes** panel in the admin UI and run a sync.
4. Verify the mailbox identity is `active=1` and `can_receive=1`.
5. Inbound is rejected (not archived) when the recipient is unknown — check for typos in `to:`.

## Routing sync fails

The runtime sync uses `CLOUDFLARE_ROUTING_READ_TOKEN` with read-only permissions (D1 Read, Workers Scripts Read, Workers R2 Storage Read, Email Routing Rules Read, Workers Routes Read). A token without Email Routing rule read access produces a sync error; the last good state is preserved.

## Storage probe fails

`POST /api/admin/mail/ops/storage-probe` verifies D1 and R2 read/write/delete. A failure indicates the Worker binding, bucket, or D1 database is misconfigured — check `wrangler.jsonc` `database_id` and bucket name.

## Attachments are missing on retry

Retries rebuild the payload from the archive and verify `sha256`. If an object is missing from R2, retry fails with `attachment_archive_missing`; restore the R2 backup or resend.

## Password reset / lost access

Use `scripts/reset-admin-password.ps1` (updates D1 hash with PBKDF2-SHA256 and revokes sessions), or bootstrap a fresh database.

## Tests fail locally

`npm run check` requires a network connection for the Wrangler dry-run and Node 22.x (the canonical runtime). Run `npm test` alone for the offline test suite; `node scripts/verify-migration.mjs` proves the migrations apply to a fresh database.

### Wrong Node or npm version

**Symptom:** install or validation fails with engine errors, or the suite behaves differently from CI.
**Cause:** the project pins Node 22.23.2 (`.nvmrc` / `.node-version`); `package.json` declares `>=22 <23` and `npm >=10`.
**Verify:** `node --version` and `npm --version` — use `nvm use` (or your version manager) to select 22.23.2.
**Resolution:** switch to the pinned toolchain and rerun `npm ci`.

### `npm ci` fails

**Symptom:** install fails with lockfile or integrity errors.
**Cause:** a mutated lockfile, a Node/npm mismatch, or a partial previous install.
**Verify:** `git status --porcelain` should be clean; do not run `npm install` to "fix" the lock.
**Resolution:** restore `package-lock.json` from git, remove `node_modules`, and rerun `npm ci` with the pinned toolchain. If the lockfile is genuinely wrong, fix it in a PR that explains why.

### Admin sign-in or session problems

**Symptom:** login is rejected, or you are signed out immediately.
**Cause:** an invalid `AUTH_PEPPER` (fail-closed), a wrong passphrase, an idle-expired session (`SESSION_IDLE_MINUTES`), or an expired session (`SESSION_HOURS`).
**Verify:** check the Worker logs for `auth` failures; session cookies are `__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`.
**Resolution:** confirm `AUTH_PEPPER` is the same value used when the password hash was created; reset the password with `scripts/reset-admin-password.ps1`. Rotating the pepper invalidates existing session verifiers by design.

### Cloudflare deployment/permission failures

**Symptom:** `npm run setup` / `credentials:apply` fails with a 401/403 from the Cloudflare API.
**Cause:** the operator token is missing a required scope for the operation being attempted.
**Verify:** `npm run credentials:check` classifies the token (valid / invalid / forbidden / unreachable); the required permission names per operation are in `docs/CLOUDFLARE_TOKEN_PERMISSIONS.md`.
**Resolution:** create a scoped token with the documented permission set — do not switch to a Global API Key.

### Browser E2E fails locally

**Symptom:** `npm run test:e2e` fails before running tests, or leaves a dev server behind.
**Cause:** port 8788 is already in use, or a previous run was interrupted.
**Verify:** `lsof -nP -iTCP:8788 -sTCP:LISTEN` shows a leftover process.
**Resolution:** stop the leftover process, delete `.e2e-state/`, and rerun. The harness restarts the local dev server and tears it down with its process group.

## Delete failed with "deletion incomplete"

`DELETE /api/threads/:id` failed to remove every R2 object and returned `503 deletion_incomplete`. This is fail-closed by design: the D1 metadata and thread are preserved intact. Simply retry the request; once the R2 outage clears, the retry completes the deletion. The daily scheduled cleanup also retries automatically.

## D1 quota reached (database_quota_exceeded)

Since 2026-09-01 Cloudflare's Free D1 plan **hard-rejects** requests that exceed the daily row budget (5M rows read / 100k rows written) or storage (500 MB). MailGable maps these to `503 database_quota_exceeded` with the message "Database quota reached. Check Cloudflare D1 usage and query plans."

Diagnose in order:

1. **Inspect**: Cloudflare dashboard → D1 → database → usage (rows read/written, storage) for the last day.
2. **Optimize**: confirm the thread list uses cursor pagination (no deep OFFSET), search is bounded by `docs/CAPACITY.md`, and retention purges trashed/expired threads (`TRASH_RETENTION_DAYS`, `MESSAGE_RETENTION_DAYS`).
3. **Plan**: if a light self-hosted workload still exceeds Free budgets, consider the Paid D1 tier.

The daily counters reset at UTC midnight; a small number of over-budget requests can also be retried after reset.
