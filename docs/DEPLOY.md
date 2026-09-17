# Deployment

This guide takes a fresh Cloudflare account to a working inbox. Everything below uses disposable example values — replace them with your own.

The canonical path is the guided operator workflow:

```text
npm run configure
npm run setup -- --mode production
npm run provider:set <none|resend|brevo|cloudflare>
npm run credentials:...
npm run db:migrate:remote
```

All authenticated Wrangler work flows through the central operator runner
and the centralized credential store; you never run `npx wrangler login` or
raw `wrangler secret` commands as part of the normal MailGable operator
path.

## Prerequisites

* A Cloudflare account with Workers, D1, R2, and Email Routing enabled
* A domain on that account (e.g. `example.com`)
* **Node.js 22.x** and npm ≥ 10 (the canonical runtime contract in `package.json` is `>=22 <23`)
* Optional outbound provider: [Resend](https://resend.com), [Brevo](https://www.brevo.com), or Cloudflare Email Service — receive-only needs none

## 1. Clone and validate

```bash
git clone <repository-url> MailGable
cd MailGable
npm ci
npm run check
npm run configure
```

`configure` collects the Cloudflare operator token (control plane) plus
your outbound provider keys and stores them once in gitignored
`.mailbox/credentials.env` (0600). Every operator command reuses them.
See [docs/CREDENTIALS.md](CREDENTIALS.md) and
[docs/CLOUDFLARE_TOKEN_PERMISSIONS.md](CLOUDFLARE_TOKEN_PERMISSIONS.md)
for the exact permission set and the Convenience vs Maximum-security
token retention strategies.

## 2. Guided production setup

The guided setup discovers/creates D1 and R2, applies migrations, installs
runtime secrets via stdin, and deploys — all through the central operator
runner:

```bash
npm run setup -- --mode production
```

Production mode validates every input before touching a resource, generates
the custom-domain route with **workers.dev OFF**, and prints the remaining
manual Email Routing steps. `workers.dev` is disabled in production; always
use your `APP_ORIGIN` custom domain.

## 3. Apply migrations (remote)

```bash
npm run db:migrate:remote
```

`db:migrate:remote` validates the operator state (HEAD rc, worker, D1 UUID,
config hash) and runs `d1 migrations apply --remote` through the central
Wrangler runner, so the token you stored with `npm run configure` is used.

## 4. Deploy only

```bash
npm run setup:deploy
```

## 5. Configure Email Routing

MailGable automates Email Routing rule synchronization through its admin
**Cloudflare routes** panel (`routing_managed` identities in D1) using the
Cloudflare Email Routing rules APIs. What still requires the operator:

1. In the Cloudflare dashboard for your domain: **Email → Email Routing → Enable** (account-level enablement is not automated by this release).
2. Verify a destination address (Cloudflare sends a confirmation email).
3. Add routing rules: each mailbox address (e.g. `hello@example.com`) → **Send to a Worker** → the deployed Worker, or create the rules through MailGable's route sync where supported.
4. Optionally add a catch-all to the Worker.

The Cloudflare API supports creating/updating/deleting Email Routing rules
with Worker actions; MailGable currently automates the rule-sync portion and
deliberately leaves account enablement and destination verification to the
operator. That is a scoping choice, not a platform limitation.

## 6. Bootstrap the administrator

Open `https://<app-origin>/admin/mail/` (your custom domain — never
`<worker>.workers.dev` in production):

1. Enter the administrator email and a passphrase of at least 15 characters.
2. Provide the one-time `ADMIN_BOOTSTRAP_TOKEN` secret.
3. After success, remove the bootstrap secret with the qualified command:

```bash
npm run setup:remove-bootstrap
```

## 7. Outbound providers

### Receive-only

```bash
npm run provider:set none
```

No outbound provider is configured; the UI disables compose and explains why;
nothing fails at send time.

### Resend

1. Add the sending domain in Resend → Domains, publish SPF/DKIM, wait for verification.
2. `npm run configure` and select `resend` — enter `RESEND_SETUP_API_KEY` (management) and `RESEND_API_KEY` (sending).
3. `npm run provider:set resend` creates/updates the canonical webhook and stores the real signing secret as `RESEND_WEBHOOK_SECRET`.

See [docs/providers/RESEND.md](providers/RESEND.md).

### Brevo

1. Add a verified sender email/domain in Brevo (Transactional Email API).
2. `npm run configure` and select `brevo` — enter `BREVO_API_KEY` (single sending + default management key); `BREVO_SETUP_API_KEY` is an optional management override.
3. `npm run provider:set brevo` creates/updates the transactional webhook with Bearer auth (`BREVO_WEBHOOK_TOKEN`).

See [docs/providers/BREVO.md](providers/BREVO.md).

### Cloudflare Email Service

1. Onboard the sending domain in Cloudflare Email Sending with DNS verified.
2. `npm run configure` and select `cloudflare` — the operator token is the control-plane credential; no runtime sending secret is required.
3. `npm run provider:set cloudflare` creates the queue and reconciles the `email.sending` Queue Event Subscription for the configured zone/domain.

See [docs/providers/CLOUDFLARE_EMAIL.md](providers/CLOUDFLARE_EMAIL.md).

## 8. Send/receive smoke test

Provider-neutral core (common to every outbound provider):

1. Send an email to `hello@example.com` from any external address.
2. Confirm the conversation appears in the Inbox with a raw archive and attachments.
3. Reply from the web console and confirm the provider delivery event appears in the thread.
4. Replay the delivery event and confirm it is a no-op (no state regression).

Provider-specific smoke checks are listed in each provider document and in
[docs/RELEASE_SMOKE_TEST.md](RELEASE_SMOKE_TEST.md).

## Verify a fresh install

`npm run check` includes a migration smoke test that proves a **fresh database has zero hardcoded mailbox identities** — no example-domain mailboxes survive into a configured deployment.

## Break-glass manual reference

The following raw Wrangler operations are **not part of the qualified
MailGable operator path**. They exist only as an unsupported break-glass
reference for operators who must bypass the central runner manually; they
bypass the credential/state gates that the qualified path enforces:

```bash
# break-glass only — normally performed by `npm run setup -- --mode production`
npx wrangler login
npx wrangler d1 create <d1-name>
npx wrangler r2 bucket create <r2-name>
npx wrangler d1 migrations apply DB --remote --config wrangler.deploy.jsonc
npx wrangler secret put <NAME> --config wrangler.deploy.jsonc   # stdin
npx wrangler secret delete <NAME> --config wrangler.deploy.jsonc
```

## Production notes

* Workers Free CPU limits affect PBKDF2 iterations (see [Security model](SECURITY_MODEL.md)).
* `workers.dev` is disabled in production; access the admin console only through `APP_ORIGIN`.
* Use `scripts/preflight-production.ps1` and `scripts/deploy-production.ps1` (Windows/PowerShell) for a guarded, credential-verified cutover, or apply the same steps manually.
* `docs/MAINTAINER_RUNBOOK.md` documents operational maintenance.
