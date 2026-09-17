# Credentials

**You configure credentials once on your own machine. MailGable maintainers
never receive them.**

Credentials remain:

* on your local machine (`.mailbox/credentials.env`, mode 0600, gitignored)
* in your own Cloudflare Worker secrets
* at your selected outbound provider

Never send Cloudflare API tokens, Resend/Brevo keys, `AUTH_PEPPER`, webhook
secrets, or mailbox passwords to the maintainer, an Issue, a Discussion, a
chat tool, or a CI log.

## One-time configuration

Run the wizard once:

```bash
npm run configure
```

It writes exactly two gitignored stores in `.mailbox/`:

| File | Purpose | Tracked |
| :--- | :--- | :--- |
| `.mailbox/config.json` | non-secret operator intent (mode, worker name, domain, admin email, app origin, Cloudflare account/zone ids, outbound provider, D1/R2 names) | gitignored |
| `.mailbox/credentials.env` | secrets only, mode 0600, atomic writes | gitignored |
| `.mailbox/credentials.example.env` | template with lifecycle classes | tracked |
| `mailbox.config.example.json` | non-secret template | tracked |

Secrets and non-secret configuration are deliberately kept in separate
files: one is data you want diffable, the other is `0600` and never
tracked.

After `npm run configure`, every operator command reuses the stored
values and never asks again:

* `npm run setup -- --mode production` (and `setup:deploy`, `setup:migrate`,
  `setup:remove-bootstrap`)
* `npm run provider:set ...`, `npm run provider:remove ...`,
  `npm run provider:recover`
* `npm run credentials:apply`, `npm run credentials:rotate`
* `npm run db:migrate:remote`

## Credential precedence

All Node operator tooling reads credentials through a single loader
(`scripts/config/credentials.mjs`) with this precedence:

1. explicitly supplied process environment
2. `MAILBOX_CREDENTIALS_FILE` (path to a credentials env file)
3. `.mailbox/credentials.env`

`.dev.vars` and `.env` are deliberately **never** production credential
sources; `.dev.vars` serves `npm run dev` only.

The credential file is a data file, never a shell program: only literal
`KEY="value"` lines are accepted, with no `$VAR`, `$(command)`, backtick,
or `source` expansion. Unknown keys fail loudly (`credential_key_unknown`)
so a typo like `CLOUDFLARE_AP1_TOKEN` can never become a confusing
authentication failure.

### Cloudflare: token vs account

* **`CLOUDFLARE_API_TOKEN`** — process environment may override the central
  store (useful for CI). The token is injected only into Wrangler child
  processes via the central operator runner; it is never a Worker secret,
  never a Worker var, and never written to `~/.wrangler`, `.env`, or
  `.dev.vars`.
* **`CLOUDFLARE_ACCOUNT_ID`** — canonical operator config
  (`.mailbox/config.json`) is **authoritative**. A stale value in the
  shell never overrides it, and when the operator config has no account id
  a stale shell value is removed rather than propagated. Deployment
  resource state is bound to the configured account, so cross-account
  mistakes are prevented.

## Cloudflare API token permissions

Use a **scoped API token**, never a Global API Key by default. The token is
the operator/control-plane credential for your Cloudflare deployment
(Worker, D1, R2, Queues, Email Routing, secrets, deploy), independent of
the outbound provider. It is collected in production mode for **every**
outbound provider (`none`, `resend`, `brevo`, `cloudflare`), never only for
`cloudflare` outbound.

Two supported strategies (pick one; both are supported by the same
one-time configuration):

* **Convenience** — keep a minimal-scope operator token in the local
  central store (`.mailbox/credentials.env`). Every operator command
  (`provider:set`, `db:migrate:remote`, `setup`, reconcile) reuses it
  without re-entry. Recommended when you manage the deployment from one
  machine.
* **Maximum security** — after setup, revoke the token at the Cloudflare
  dashboard. A later management operation (provider switch, queue
  lifecycle, D1/R2 management, remote migrations) re-provisions a scoped
  token and re-enters it once (`npm run configure -- --replace`).

One-time configuration guarantees the system supports **persistent local
credential reuse**. Voluntarily revoking a provider/operator credential is
a security-policy choice, not a product requirement that you re-enter
credentials on every operation.

See `docs/CLOUDFLARE_TOKEN_PERMISSIONS.md` for the exact permission set.

## Lifecycle classes

| Class | Credentials | Where |
| :--- | :--- | :--- |
| Operator-local | `CLOUDFLARE_API_TOKEN`, `RESEND_SETUP_API_KEY`, `BREVO_SETUP_API_KEY` | local central store only; management/control plane; never installed into the Worker, never a Worker var/D1 row/argv/log |
| Persistent runtime | `AUTH_PEPPER`, `CLOUDFLARE_ROUTING_READ_TOKEN` + active provider (`RESEND_API_KEY`/`RESEND_WEBHOOK_SECRET` or `BREVO_API_KEY`/`BREVO_WEBHOOK_TOKEN`) | Worker secrets via `credentials:apply` (stdin, never logged) |
| Transient | `ADMIN_BOOTSTRAP_TOKEN` | deleted after bootstrap (`setup:remove-bootstrap`) |
| Cloudflare outbound | none | Worker `send_email` binding — no runtime sending token |

`CLOUDFLARE_API_TOKEN` (operator resource management) and
`CLOUDFLARE_ROUTING_READ_TOKEN` (Worker runtime Email Routing read) are
deliberately separate credentials and never merged.

## Commands

```bash
npm run configure             # interactive wizard; auto-generates secrets
                              # (values shown as "stored"/"generated" only)
npm run configure -- --replace  # deliberately re-enter a key; never deletes
                              # keys you do not re-enter
npm run credentials:status    # READY/ABSENT + lifecycle role + source
                              # (file/env/absent), never values
npm run credentials:check     # read-only capability probes: VALID, INVALID,
                              # FORBIDDEN, RATE_LIMITED, UNREACHABLE,
                              # PROVIDER_ERROR, NOT_CONFIGURED
npm run credentials:apply     # uploads active-provider persistent secrets
npm run credentials:rotate -- <KEY>  # journaled local + remote rotation
npm run credentials:recover   # converge a pending rotation to the Worker
npm run provider:set brevo    # switch provider, apply secrets, reconcile webhook
npm run provider:remove resend
npm run db:migrate:remote     # state-gated remote D1 migrations via central runner
```

Provider API keys are never stored in D1; D1 stores only provider message
ids, provider event ids, and normalized state.

## Resend and Brevo management keys

* Resend uses two keys: `RESEND_SETUP_API_KEY` (operator-local management,
  Full Access) and `RESEND_API_KEY` (runtime sending). Both are stored
  centrally; only `RESEND_API_KEY` (and `RESEND_WEBHOOK_SECRET`) ever
  become Worker secrets.
* Brevo uses a **single key by default**: `BREVO_API_KEY` is both the
  runtime sending key and the operator-management key. `BREVO_SETUP_API_KEY`
  is an **optional** management override when you keep the Worker sending
  key separate from your operator management key. Management requests use
  `BREVO_SETUP_API_KEY || BREVO_API_KEY`; provider activation always
  requires `BREVO_API_KEY`.
* Resend's webhook signing secret is **never generated by MailGable**: it
  comes from the Resend webhook API during `provider:set resend` and is
  stored centrally (0600) then uploaded to the Worker.
* Brevo's `BREVO_WEBHOOK_TOKEN` is a MailGable-chosen bearer token agreed
  with the Brevo webhook configuration; it is generated by `npm run
  configure` and reused by reconciliation.

## Rotation

* Rotating `AUTH_PEPPER` invalidates existing password verifiers unless the
  old pepper is retained temporarily (see `docs/SECURITY_MODEL.md`). Direct
  rotation of `AUTH_PEPPER` is refused by the CLI.
* `npm run credentials:rotate -- <KEY>` updates the local central store
  atomically and the Worker secret through the central Wrangler runner,
  behind a journal (`.mailbox/credential-operation.json`) that records
  only non-secret metadata (`schema_version`, `operation`, `key`, `phase`,
  `started_at`, `worker_name`) — never values, hashes, prefixes, or
  suffixes.
* If the remote update fails, the journal stays and
  `npm run credentials:recover` converges the Worker from the **current
  local value** — it never re-asks the secret and never rolls back.
* Operator-local keys (`CLOUDFLARE_API_TOKEN`, `RESEND_SETUP_API_KEY`,
  `BREVO_SETUP_API_KEY`) rotate the local store only — they never execute a
  Worker secret put.

## Inactive-provider Worker secrets

After a provider switch, the previous provider's Worker runtime secrets are
removed automatically (e.g. switching Resend -> Brevo deletes
`RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` from the Worker). The local
central store keeps those keys, so switching back later re-uploads them
without re-entering. Common secrets (`AUTH_PEPPER`,
`CLOUDFLARE_ROUTING_READ_TOKEN`) are never removed.
