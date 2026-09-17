# Routing

MailGable keeps mailbox identities in D1 and Cloudflare Email Routing rules in sync.

## Concepts

* **Mailbox identity** — a row in `mailboxes` (`address`, `display_name`, `can_receive`, `can_send`, `active`, `routing_managed`). Identities are **generic**: `hello@example.com` and `orders@example.com` behave exactly like any other; there are no special mailbox names.
* **Routing state** — the Cloudflare Email Routing rule snapshot for the domain (`literal to` rules and the catch-all).
* **Send capability** — `can_send=1` identities are available as sender identities in the compose dialog; `can_receive=1` identities accept inbound mail.

## Runtime synchronization

`POST /api/routing-sync` (admin session required) reads the Cloudflare routing snapshot with a scoped read token and reconciles D1:

* every enabled literal `to` address routed to the canonical Worker becomes a receive-capable identity,
* every enabled domain address becomes a send-capable identity,
* routing-managed identities that no longer exist in Cloudflare are deactivated (never deleted),
* mailbox records are the source of truth for the routing status panel.

The operational PowerShell scripts (`sync-routing-mailboxes.ps1`, `reconcile-email-routing.ps1`) perform the same reconciliation for deployment automation.

## Inbound forwarding (optional)

`INBOUND_FORWARD_TO` sends a copy of every inbound message to external addresses through Cloudflare's native forward mechanism:

* empty = disabled,
* any number of valid, deduplicated addresses,
* per-target attempt tracking with retry-on-redelivery,
* a target equal to the envelope recipient is rejected as a loop,
* forwarding failure never blocks the authoritative archive.

## Routing readiness

The routing status panel reports `success` when every routing-managed identity is active for both receive and send. It does **not** require any particular mailbox name.

## Related

* [DEPLOY.md](DEPLOY.md) — step-by-step routing configuration
* `docs/inbound-routing-runbook.md` — operational inbound runbook
* `docs/runtime-routing-sync.md` — synchronization design notes