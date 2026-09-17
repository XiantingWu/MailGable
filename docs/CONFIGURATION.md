# Configuration

MailGable is configured with Cloudflare Worker `vars` (plaintext, non-secret settings) and Worker `secrets` (sensitive values installed as Worker secrets via the central operator runner). See `wrangler.jsonc` for the development defaults.

## Variables

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `MAIL_DOMAIN` | The primary domain configured for email routing | `example.com` |
| `ADMIN_EMAIL` | Administrator login and alert recipient | `admin@example.com` |
| `MAIL_DISPLAY_NAME` | Default sender display name | `MailGable` |
| `APP_ORIGIN` | Canonical browser origin; **required in production** (fail-closed otherwise) | `https://mail.example.com` |
| `MAILBOX_ADDRESSES` | Comma-separated desired mailbox identities (optional; mailbox records and Cloudflare routing are the source of truth) | `hello@example.com,sales@example.com` |
| `INBOUND_FORWARD_TO` | Comma-separated external addresses that receive a copy of every inbound message. **Empty disables forwarding.** | `backup@example.org` |
| `AUTO_BCC_ADDRESSES` | Comma-separated addresses automatically BCC'd on every send. **Empty disables automatic BCC.** | `audit@example.net` |
| `AUTO_BCC_REQUIRED` | `true` fails closed when `AUTO_BCC_ADDRESSES` is empty (high-assurance deployments) | `false` |
| `PASSWORD_ITERATIONS` | PBKDF2-SHA256 iterations; constrained by the platform (see below) | `8000` |
| `SESSION_HOURS` | Absolute session validity duration in hours | `12` |
| `SESSION_IDLE_MINUTES` | Revoke a session after this many minutes without a request; `0` disables idle expiry (the absolute `SESSION_HOURS` bound still applies) | `60` |
| `MESSAGE_RETENTION_DAYS` | Retention for non-trash messages; `0` = retain indefinitely | `0` |
| `TRASH_RETENTION_DAYS` | Retention for trashed threads before permanent deletion | `30` |
| `LOG_LEVEL` | Structured log verbosity: `error`, `info`, or `debug`. Errors always log; `info` adds operational events; `debug` is off by default | `info` |
| `CLOUDFLARE_ZONE_ID` | Zone identifier used by runtime routing synchronization | `00000000-0000-0000-0000-000000000000` |
| `MAIL_WORKER_NAME` | Canonical Worker name used by runtime routing synchronization | `mailgable-dev` |

Logs are single-line JSON (`level`, `message`, fields). They never include raw MIME, message bodies, API keys, passwords, session tokens, webhook secrets, or authorization headers; sensitive field names are redacted automatically.

## Secrets

Installed as Worker secrets (never in `wrangler.jsonc` or `.dev.vars` committed files):

| Secret | Purpose |
| :--- | :--- |
| `AUTH_PEPPER` | ≥ 32 random bytes used for session and rate-limit hashing; **fail-closed** (missing/short → auth returns 503) |
| `ADMIN_BOOTSTRAP_TOKEN` | One-time value required by the initial administrator bootstrap; remove after setup |
| `RESEND_API_KEY` | Outbound provider API key (Resend) |
| `RESEND_WEBHOOK_SECRET` | Svix signing secret for the delivery webhook |
| `BREVO_API_KEY` | Outbound provider API key (Brevo; also the default management key) |
| `BREVO_WEBHOOK_TOKEN` | Bearer token for the Brevo delivery webhook |
| `CLOUDFLARE_ROUTING_READ_TOKEN` | Read-only Cloudflare token for runtime routing synchronization |

These are the Worker **runtime** secrets. Operator-local credentials
(`CLOUDFLARE_API_TOKEN`, `RESEND_SETUP_API_KEY`, `BREVO_SETUP_API_KEY`)
are never Worker secrets — see [CREDENTIALS.md](CREDENTIALS.md) for the
full lifecycle table.

## Password policy

* Passwords are NFC-normalized; minimum **15 characters** (Unicode code points), no composition requirements; Unicode passphrases and spaces are allowed.
* Maximum 128 code points (512 bytes); longer input is **rejected, never silently truncated**.
* The stored verifier is `pbkdf2-sha256+hmac-sha256-v1`: PBKDF2-SHA256 plus an HMAC-SHA256 signature with `AUTH_PEPPER`. Legacy plain-PBKDF2 hashes upgrade on first login.
* There is no MFA yet — see [Security model](SECURITY_MODEL.md) for the platform KDF constraint and roadmap.

## Canonical origin

Production deployments must set `APP_ORIGIN` to the canonical browser origin (e.g. `https://mail.example.com`). Without it, browser-authenticated endpoints fail closed with `503 origin_not_configured`; only `localhost`/`127.0.0.1`/`::1` are auto-allowed for local development. Disable `workers.dev` in production (or protect it identically with Cloudflare Access) to avoid an unprotected origin.

## Local development

Copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill in values, then:

```bash
npm ci
npm run dev
```

`npm run check` runs typecheck, the full test suite, the migration smoke test, a Wrangler dry-run, and the commit attribution audit.