# Cloudflare Email Service Provider

| | |
| :--- | :--- |
| Delivery events | Queue Event Subscription (no public webhook) |
| Provider idempotency | not assumed |
| Application retry window | none for unknown outcomes |
| Attachments | supported (5 MiB is the total message limit, measured on the real outgoing MIME) |
| Open/click tracking | no core event |
| Threading headers | supported (`In-Reply-To`, `References` allowlisted) |

## Prerequisites

* Cloudflare **Workers Paid** (Email Sending is Beta)
* Sending domain onboarded in Cloudflare Email Sending with DNS verified
* Inbound Email Routing remains Cloudflare Email Routing (separate feature)

## Setup

1. `npm run configure` and select `cloudflare`. The Cloudflare operator
   token (`CLOUDFLARE_API_TOKEN`) is collected in production for every
   provider — it is the deployment/control-plane credential (see
   `docs/CLOUDFLARE_TOKEN_PERMISSIONS.md`), not a `cloudflare` outbound
   credential.
2. `npm run setup -- --mode production` — the generated config includes the
   `EMAIL` (send_email) binding and the `<worker>-email-events` Queue
   **consumer** (the Event Subscription produces into the queue; no producer
   binding is needed). **No runtime sending secret is required.**
3. `npm run provider:set cloudflare` — creates the queue if absent and
   reconciles the `email.sending` Queue Event Subscription (delivered,
   deferred, bounced, failed, rejected, complained) for the configured
   zone/domain, idempotently. If the operator token is absent, create the
   subscription manually:
   `wrangler queues subscription create <worker>-email-events --source email.sending
   --events message.delivered,message.deferred,message.bounced,message.failed,message.rejected,message.complained
   --zone-id <ZONE_ID> --domain <SENDING_DOMAIN>` (idempotent; run twice to
   confirm reuse, never duplicate).

## Limits

* Total message size: **5 MiB** — enforced before send
  (`provider_payload_too_large`); larger messages are rejected up front.

## Retry semantics

Cloudflare Email Sending does not document provider idempotency, so
unknown outcomes are **never auto-retried**. The operator verifies the
provider record and only then decides on a new send.

## Event handling

Queue events (`cf.email.sending.*`) are normalized (delivered, deferred →
delivery_delayed, bounced, failed, rejected → suppressed, complained) and
applied through the same monotonic reconciliation as other providers;
`payload.eventId` is the replay-safe unique key.
