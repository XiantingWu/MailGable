# Resend Provider

| | |
| :--- | :--- |
| Delivery events | webhook (`POST /webhooks/resend`) |
| Provider idempotency | 24 h (Resend `Idempotency-Key`) |
| Application retry window | 23 h (margin below the provider TTL) |
| Attachments | yes (via archived uploads) |
| Open/click tracking | depends on account/event configuration |

## Prerequisites

* SPF and DKIM-verified sending domain
* Sending API key restricted to that domain
* Webhook signing secret

## Setup

1. `npm run configure` and select `resend` (or `--all-providers`).
2. Provide `RESEND_API_KEY` (required, runtime sending) and
   `RESEND_SETUP_API_KEY` (operator-local management, Full Access, used for
   webhook reconciliation). Both stay in the local central store; only
   `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` become Worker secrets.
3. `npm run setup -- --mode production`.
4. Webhook: `POST https://<app-origin>/webhooks/resend`, delivery events
   (`delivered`, `bounced`, `complained`, `failed`). `npm run provider:set
   resend` creates/updates the canonical webhook and stores the signing
   secret as `RESEND_WEBHOOK_SECRET` without printing it (idempotent; run
   twice to confirm reuse). Without a setup key, configure manually.

## Security

Resend webhooks are verified with the **Svix cryptographic signature** over
the raw body (`svix-id`, `svix-timestamp`, `svix-signature`, 5-minute skew,
replay-safe by unique `svix_id`).

## Retry semantics

Unknown outcomes retry within 23 h with the same key and payload. After the
window, `provider_retry_window_expired` requires manual provider-record
verification.

## Remove / rotate

`npm run provider:remove resend` (refuses while retryable messages exist
unless `--force`).
