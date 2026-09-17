# Live Validation Procedure

The end-to-end private live-validation procedure for the release candidate. Execute **only**
with disposable resources (see [LIVE_VALIDATION_ENVIRONMENT.md](LIVE_VALIDATION_ENVIRONMENT.md)).
Every step records PASS/FAIL into the sanitized evidence report
(`scripts/live-validation.mjs` output). **Never** paste credentials, tokens,
resource IDs, or account identifiers into chat, logs, or reports.

The qualified object is the immutable Git commit SHA on the single `main`
branch. There is no PR head, draft state, or feature branch to bind to.

## 0. Fresh clone (never deploy from the dev checkout)

```bash
mkdir /tmp/mailbox-live-validation && cd /tmp/mailbox-live-validation
git clone <PRIVATE_REPOSITORY> && cd <repo>

git fetch origin main
export EXPECTED_RELEASE_SHA="<exact-main-sha>"

git checkout --detach "$EXPECTED_RELEASE_SHA"
test "$(git rev-parse HEAD)" = "$EXPECTED_RELEASE_SHA"

npm ci
npm run check
npm run test:worker
npm run test:e2e
```

> `EXPECTED_RELEASE_SHA` is the exact `origin/main` commit at the moment
> validation starts — it is deliberately **not** embedded in this document,
> because every qualifying commit changes it. The evidence file is bound to
> that SHA and any mismatch fails with `evidence_release_mismatch`.
> `EXPECTED_RC_SHA` is accepted as a deprecated alias.

Gate: `HEAD == EXPECTED_RELEASE_SHA == origin/main`, worktree clean.

## 1–3. Setup runs

```bash
export APP_ORIGIN=https://<test-custom-domain>
EXPECTED_RELEASE_SHA="$EXPECTED_RELEASE_SHA" node scripts/live-validation.mjs preflight
node scripts/live-validation.mjs setup1    # first production run
node scripts/live-validation.mjs setup2    # idempotent second run
```

Expectations:

* Run 1: Worker/D1/R2 created, all repository migrations applied, workers.dev OFF,
  APP_ORIGIN configured.
* Run 2: everything reused, no duplicates, no resets, no re-migrations,
  no routing corruption.

## 4. Admin bootstrap

Open `https://<test-custom-domain>/admin/mail/`, bootstrap with the one-time
token (15+ character passphrase, Unicode accepted), then immediately:

```bash
npm run setup:remove-bootstrap
```

Verify login still works and a second bootstrap is rejected.

## 5. Public/Admin boundary

`node scripts/live-validation.mjs boundary`

* `GET /healthz` (no auth) → `{"ok":true}`
* `POST /webhooks/resend` without valid Svix signature → rejected
* `POST /webhooks/brevo` with invalid Bearer auth → rejected
* `/api/admin/mail/config|mailboxes|threads` without auth → 401

Cloudflare Email Service delivery events arrive via a Queue consumer (no
HTTP endpoint); its malformed-input rejection is covered by the unit
contract tests.

## 6–18. Mail smoke (manual, external inboxes)

Use the two disposable recipient inboxes from the environment spec:

| # | Check | Detail |
| :--- | :--- | :--- |
| 6 | Inbound plain text | external → test mailbox; D1 message, thread, R2 raw, download |
| 7 | HTML hostile smoke | https/mailto kept; javascript:/data:/vbscript:/relative/protocol-relative removed; remote image not loaded; no script/form execution; iframe can't touch parent |
| 8 | Attachments | normal + Unicode + bidi filenames; R2/D1/SHA256; safe UI and download filenames; raw preserved |
| 9 | Duplicate inbound | same fixture twice → one canonical message/archive, zero duplicate attachment metadata |
| 10 | Threading | A → B(re:A) → C(re:A,B) same thread; cross-mailbox References must not merge |
| 11 | Outbound | compose/reply/reply-all/forward/attachment/CC/BCC each delivered to an external inbox; D1+R2 outgoing archive; provider id; status |
| 12 | Delivery event | real provider event → verified per provider, correlated, recipient state updated; replay is a no-op |
| 13 | Idempotency | same key+payload → no new logical send; same key+different payload → 409 before provider |
| 14 | Receive-only | remove the sending key; inbound still works; compose disabled with explanation (not a late 503) |
| 15 | Routing authorization | `hello@test` → Worker becomes managed identity; `billing@test` → external/other Worker must NOT gain send authority |
| 16 | Archive/Spam/Trash/Restore | full cycle through UI/API; folder semantics + cursor pagination |
| 17 | Permanent delete | record R2 keys; hard delete; D1 thread/messages/attachments absent AND R2 raw/attachments absent |
| 18 | Retention | short retention; >50 expired threads; first run bounded batch, second run continues; R2-first; then restore config |

## 19–22. Backup / restore / D1 Time Travel

* 19: fixture with inbound/outbound/HTML/attachments/archive/trash/delivery
  event; record counts + selected SHA256.
* 20: D1 export + R2 copy + backup manifest (release SHA, migration version,
  timestamp, counts; no secrets).
* 21: restore into **fresh** D1 #2 + R2 #2; redeploy candidate; verify all
  counts, raw MIME, attachment hashes, thread summaries, search, cursor.
* 22: destructive synthetic D1 mutation → D1 Time Travel restore → D1
  recovered; prove **R2 did not time travel** (documented contract).

## 23. Teardown

Revoke setup credential and provider test keys, delete webhook/event
subscription, Worker, D1, R2, Email Routing rules, and disposable
DNS/subdomain. Keep only the sanitized evidence report.

## Evidence recording and finalize

```bash
node scripts/live-validation.mjs record inbound_text PASS
node scripts/live-validation.mjs record inbound_html FAIL --code invalid_link_policy
...
node scripts/live-validation.mjs finalize     # machine gate: all steps PASS + SHA binding
```

`record` only accepts the allowlisted step IDs and stable sanitized error
codes; evidence JSON is never hand-edited. Only `finalize` may print
`REAL-WORLD RELEASE VALIDATION: PASS`.

## Evidence report

`node scripts/live-validation.mjs report` prints the sanitized template:

```
RELEASE_SHA / REMOTE_MAIN_SHA
PROVIDERS_EXERCISED
SETUP RUN #1 / #2 IDEMPOTENT
INBOUND TEXT/HTML / ATTACHMENT / DUPLICATE / THREADING
SEND / REPLY / REPLY ALL / FORWARD / WEBHOOK / IDEMPOTENCY
RECEIVE ONLY / ROUTING AUTH BOUNDARY
ARCHIVE/SPAM/TRASH/RESTORE / HARD DELETE D1 / HARD DELETE R2 / RETENTION
BACKUP / FRESH RESTORE / D1 TIME TRAVEL
WORKERS.DEV OFF / APP_ORIGIN / PUBLIC-ADMIN BOUNDARY
REAL SECRET IN REPORT: 0 / REAL PII IN REPORT: 0
```

Failures include error codes, sanitized log snippets, and the fixing commit
SHA — never raw credentials.
