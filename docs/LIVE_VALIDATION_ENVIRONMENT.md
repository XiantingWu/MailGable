# Live Validation Environment

Everything required to run the private real-world qualification
(`docs/RELEASE_SMOKE_TEST.md`). Every resource below is **disposable** and
must be torn down after the run. Never use production mailboxes, keys,
domains, or existing D1/R2 databases.

## Cloudflare

| Resource | Spec |
| :--- | :--- |
| Zone / domain | Disposable subdomain or test zone (e.g. `mail.test.example.net`) |
| Worker | Fresh, disposable name |
| D1 | Fresh `mailgable-db` (new) |
| R2 | Fresh `mailgable-r2` (new) |
| Email Routing | Enabled on the disposable zone; destinations verified |
| Custom domain | The test zone must serve `/admin/mail/` |
| Runtime token | Scoped read token for routing sync (or none — sync can be skipped in smoke) |
| Bucket Lock / lifecycle | Not enabled (tests lifecycle interactions separately in integration) |

`setup.mjs --mode production --app-origin https://<test-zone>` provisions
Worker/D1/R2 and deploys; Email Routing and the custom domain are manual.

## Resend

| Resource | Spec |
| :--- | :--- |
| Sending domain | Disposable subdomain (e.g. `mail.test.example.net`), **not** the production domain |
| SPF / DKIM | Verified via Resend DNS records |
| Sending API key | Restricted to the test domain only |
| Webhook | `POST https://<test-zone>/webhooks/resend`, all delivery events |
| Signing secret | Stored only as a Worker secret / env var, never in the repo |

## External

* At least two test recipient inboxes (e.g. two free inboxes created for the
  test) for To/CC/BCC and reply flows.

## Forbidden

* production mailbox, production API keys, customer email addresses,
  real business data, existing production D1/R2.

## Credential handling

* Credentials enter via environment variables or a gitignored ops env file
  (`ops.env.example` documents the classes); never commit, screenshot, or
  log values.
* Worker secrets are installed via the central operator runner (never committed).
* The final report only records presence (`RESEND_API_KEY = PRESENT`), never
  values.

## Teardown checklist

* Delete the disposable zone/subdomain (or its email routing records).
* Delete Worker, D1, R2.
* Revoke the Resend test domain and sending key.
* Delete the webhook and signing secret.
* Delete the test recipient inboxes.