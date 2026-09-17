# Brevo Provider

| | |
| :--- | :--- |
| Delivery events | webhook (`POST /webhooks/brevo`) |
| Provider idempotency | ~30 min (`idempotencyKey`, UUID) |
| Application retry window | 25 min (conservative below the provider TTL) |
| Attachments | yes (base64 via archived uploads) |
| Open/click tracking | depends on account/event configuration |

## Prerequisites

* Verified sender email/domain in Brevo (Transactional Email API)
* `BREVO_API_KEY`
* Webhook authentication token (`BREVO_WEBHOOK_TOKEN`)

## Setup

1. `npm run configure` and select `brevo`.
2. Provide `BREVO_API_KEY` (required, runtime sending; also the default
   operator-management key). `BREVO_SETUP_API_KEY` is an **optional**
   operator-management override when you keep a separate management key.
3. `npm run setup -- --mode production`.
4. Webhook: `POST https://<app-origin>/webhooks/brevo`, events
   `sent, delivered, hardBounce, softBounce, blocked, spam, invalid,
   deferred`; authenticated with `Authorization: Bearer
   <BREVO_WEBHOOK_TOKEN>`. `npm run provider:set brevo` creates/updates the
   transactional webhook with `batched=false` and bearer auth (idempotent;
   run twice to confirm reuse). Management requests use
   `BREVO_SETUP_API_KEY || BREVO_API_KEY`; with neither present,
   reconciliation reports manual and never mutates the provider.

## Single-key contract

Brevo uses **one API key by default**: `BREVO_API_KEY` is both the runtime
sending key (installed into the Worker) and the operator-management key
used for webhook reconciliation. `BREVO_SETUP_API_KEY` is an optional
advanced isolation override for management only — it is never installed
into the Worker, and provider activation always requires `BREVO_API_KEY`.

## Security

Brevo webhooks authenticate with an operator-generated **Bearer token**
(compared with timing-safe equality) — a different trust model from
Resend's Svix signature. Delivery events are correlated by the official
`message-id` field and the `mailbox:<message_id>` tag; replay identity is a
SHA-256 over provider + message + recipient + event + timestamp.

Note: Brevo's Transactional API does not expose standard
`In-Reply-To`/`References` headers through its documented custom-header
API, so external-client thread grouping is not guaranteed. The UI still
allows replies; the header simply cannot be delivered.

## Retry semantics

Brevo's idempotency TTL is short (~30 minutes), so the application retry
window is **25 minutes** — not 23 hours. Unknown outcomes outside that
window fail with `provider_retry_window_expired`.

## Remove / rotate

`npm run provider:remove brevo` (refuses while retryable messages exist
unless `--force`).
