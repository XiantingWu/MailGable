# Cloudflare API token permissions

`CLOUDFLARE_API_TOKEN` is the **operator / control-plane** credential for
your MailGable deployment. It is collected by `npm run configure` in
production mode for every outbound provider (`none`, `resend`, `brevo`,
`cloudflare`) because Cloudflare hosts the Worker, D1, R2, Queues, Email
Routing, secrets, migrations, and the deploy itself — independent of which
outbound provider sends mail.

It is **operator-local**: never installed into the Worker, never a Worker
var, never a D1 row, never passed on argv, and never logged.

## Token shapes

`CLOUDFLARE_API_TOKEN` is treated as an **opaque secret** — MailGable never
validates, parses, or classifies it by shape, prefix, suffix, or length.
The current Cloudflare token ecosystem includes:

* **User API tokens** — supported (classic long-hex or any current shape)
* **Account API tokens** (`cfut_...` user-owned, `cfat_...` account-owned)
  — supported; forwarded verbatim to Wrangler
* **Global API Key** — never recommended and not required

For durable CI/CD/operator deployments, an **account-owned token**
(`cfat_...`) is a good operational choice because it is not tied to a
single user's profile lifecycle. Account-owned tokens are recommended but
**never required**: user tokens work identically.

The credential tools only ever report `READY`/`VALID`/`INVALID`/... plus
`source` and `role` — never the token, its prefix/suffix, hash, or length.

## Recommended permission set

Create a **scoped API token** (Account -> My Profile -> API Tokens) with
these permissions and nothing broader:

| Account permissions | Scope |
| :--- | :--- |
| Workers Scripts — Edit | deploy the Worker, secrets |
| D1 — Edit | create/adopt databases, remote migrations |
| R2 — Edit | create buckets, sentinel, object lifecycle |
| Queues — Edit | create the email-events queue and subscriptions |
| Email Routing Addresses — Edit | email worker address rules |
| Workers KV — Edit | only if you use KV-backed features |

| Zone permissions | Scope |
| :--- | :--- |
| Zone — DNS — Edit | custom-domain route (`mail.<your-domain>` -> Worker) |
| Zone — Email Routing Addresses — Edit | routing rules for mailbox addresses |
| Zone — Workers Routes — Edit | route management for the custom domain |

The token needs read access to the account whose id is stored in
`.mailbox/config.json` (`cloudflare_account_id`). A stale shell
`CLOUDFLARE_ACCOUNT_ID` never overrides the operator config.

## Two supported strategies

The same one-time configuration supports either policy:

* **Convenience** — keep the scoped operator token in the local central
  store (`.mailbox/credentials.env`, 0600, gitignored). Every operator
  command (`setup`, `provider:set`, `db:migrate:remote`, reconcile)
  reuses it with no re-entry. Choose this when you operate the deployment
  from one trusted machine.
* **Maximum security** — after setup, revoke the token at the Cloudflare
  dashboard. When a later management operation needs it (provider switch,
  queue lifecycle, D1/R2 management, remote migrations), provision a fresh
  scoped token and re-enter it once:
  `npm run configure -- --replace` (per-key replacement; keys you do not
  re-enter are kept).

One-time configuration guarantees the system supports persistent local
credential reuse; revoking a provider/operator credential is a deliberate
security-policy choice, not a product requirement to re-enter credentials.

## What the token is NOT for

* It is **not** the outbound sending credential (Cloudflare outbound uses
  the Worker `send_email` binding and needs no token).
* It is **not** `CLOUDFLARE_ROUTING_READ_TOKEN` (the Worker runtime token
  for Email Routing sync, a separate, runtime-persistent secret).
* It is never long-lived inside the Worker.
