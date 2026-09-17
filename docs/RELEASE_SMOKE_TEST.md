# Release Smoke Test

Manual qualification checklist for a release candidate. Run everything against **disposable synthetic resources** (fresh test domain, temporary provider keys, no real mailboxes or customer data). Nothing here may touch a production mailbox.

## Environment

* Fresh Cloudflare account/zone or an isolated test zone on a disposable domain
* Fresh D1 database and R2 bucket (never the ones used for other tests)
* Temporary provider key(s) restricted to the test domain, revoked after the run
* Synthetic addresses only: `sender@example.net`, `orders@example.com`, …

## 1. Provision

- [ ] 1.1 Fresh resources created (D1, R2) and all repository migrations applied
- [ ] 1.2 Worker deployed and `/admin/mail/` responds (English UI, `lang=en`)
- [ ] 1.3 Email Routing enabled for the test domain; addresses verified
- [ ] 1.4 Mailbox routing rules point to the Worker; sync shows all identities
- [ ] 1.5 Administrator bootstrapped; `ADMIN_BOOTSTRAP_TOKEN` removed via `npm run setup:remove-bootstrap`

## 2. Inbound

- [ ] 2.1 Plain-text inbound appears in Inbox with metadata in D1
- [ ] 2.2 HTML inbound renders sanitized in the sandboxed iframe
- [ ] 2.3 Attachment inbound (including Unicode and bidi filenames) is archived and downloadable
- [ ] 2.4 Duplicate inbound delivery keeps one complete archive (raw object unique per attempt, one D1 row)
- [ ] 2.5 Raw `.eml` download works and matches the archive hash

## 3. Outbound — provider-neutral core

These checks apply to every outbound provider:

- [ ] 3.1 Reply from the web console; external recipient receives it
- [ ] 3.2 Reply-all and forward produce correctly threaded messages
- [ ] 3.3 Outbound attachments are archived and sent within limits
- [ ] 3.4 Provider message id recorded on the archived message
- [ ] 3.5 A real provider delivery event updates the thread state
- [ ] 3.6 Duplicate event replay is a no-op; out-of-order events do not regress state
- [ ] 3.7 Safe retry resends with the original idempotency key
- [ ] 3.8 Failure classification distinguishes provider error / retryable / outcome-unknown
- [ ] 3.9 Bounce/failure path if safely simulatable (e.g. invalid recipient domain)

### Resend

- [ ] R.1 `RESEND_API_KEY` restricted to the test domain; `RESEND_SETUP_API_KEY` (management) configured
- [ ] R.2 Webhook created at the canonical `/webhooks/resend` endpoint with the full `email.*` event set
- [ ] R.3 Real signing secret stored as `RESEND_WEBHOOK_SECRET` via reconciliation
- [ ] R.4 Raw-body Svix signature verified; unsigned/replayed events rejected

### Brevo

- [ ] B.1 `BREVO_API_KEY` configured (single key = sending + default management); optional `BREVO_SETUP_API_KEY` override
- [ ] B.2 Transactional webhook created with Bearer auth (`BREVO_WEBHOOK_TOKEN`), `batched=false`
- [ ] B.3 Delivery event authenticated with the Bearer token; invalid auth rejected
- [ ] B.4 Retry safety window is 25 minutes (below Brevo's ~30-minute provider TTL)

### Cloudflare Email Service

- [ ] C.1 `send_email` binding deployed; sending domain onboarded and DNS-verified
- [ ] C.2 Queue and `email.sending` Event Subscription reconciled for the test zone/domain
- [ ] C.3 At least one real lifecycle event (`message.delivered` … `message.complained`) correlated
- [ ] C.4 Email Routing inbound events are never treated as delivery events

## 4. Lifecycle

- [ ] 4.1 Archive, spam, and trash move threads between folders
- [ ] 4.2 Restore returns a trashed thread
- [ ] 4.3 Hard delete removes the thread, then confirm the R2 objects are gone
- [ ] 4.4 A simulated R2 delete failure keeps the metadata and returns `deletion_incomplete`; retry completes
- [ ] 4.5 Retention cron (manual trigger) purges expired trash; fresh threads survive

## 5. Security & Sessions

- [ ] 5.1 Wrong password and wrong bootstrap token are rejected
- [ ] 5.2 Password rotation revokes all sessions; old password fails afterwards
- [ ] 5.3 Logout-all revokes every session
- [ ] 5.4 Bootstrap token secret is absent after `npm run setup:remove-bootstrap`
- [ ] 5.5 Admin UI remains English under a non-English browser locale

## 6. Finish

- [ ] 6.1 Storage probe (`/ops/storage-probe`) passes
- [ ] 6.2 All smoke resources are deleted; temporary credentials revoked
- [ ] 6.3 Results recorded (date, commit SHA, environment, deviations, provider(s) exercised)
