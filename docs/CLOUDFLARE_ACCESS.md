# Production Authentication Hardening: Cloudflare Access

MailGable's built-in administrator authentication is a single passphrase with
PBKDF2-SHA256 constrained by the Workers platform (see
[SECURITY_MODEL.md](SECURITY_MODEL.md)). There is **no built-in MFA**.

The recommended production hardening is to place **Cloudflare Access** in
front of the admin interface and require MFA at the identity provider.

## Close alternate entry points first

Before relying on path-based Access policies, remove the public side doors:

* Keep `workers_dev` and preview URLs **disabled in the Wrangler config**
  (`"workers_dev": false`, `"preview_urls": false`), not only in the dashboard —
  a later deploy can otherwise re-enable them.
* The production setup flow generates a custom-domain route with `workers.dev`
  off; verify the deployed Worker has no `*.workers.dev` hostname left.
* If the account supports Worker-level Access, prefer binding Access to the
  whole Worker: that covers its routes, custom domains, `workers.dev` host, and
  preview URLs in one place instead of relying on per-hostname policies.

## Recommended deployment

1. Create an Access application for `https://<your-domain>/admin/mail/*`
   and a second application (or policy) for `https://<your-domain>/api/admin/mail/*`.
   Do **not** protect `/webhooks/resend` (provider delivery events, verified by
   Svix signatures) or `/healthz` (minimal public liveness). If the whole host
   must be protected, create the narrowest path-based Bypass policy for
   `/webhooks/resend` and `/healthz` only — specific path applications match
   first, and every Bypass removes Access logging, so keep the exception set
   minimal.
2. Configure the identity provider with MFA enabled.
3. Policy: require the identity provider group, e.g. `mailgable-admins`.
4. Do not expose a bypass route for `/admin/mail/`.
5. Keep MailGable's own login as the inner boundary (defense in depth):
   * `AUTH_PEPPER` stays configured and fail-closed;
   * the built-in session, CSRF, and audit protections remain active.

## What this guide deliberately does not do

MailGable v0.1 does **not** trust `Cf-Access-Authenticated-User-Email` from
the request headers as proof of identity. Doing that safely requires either
verifying the Access identity/JWT cryptographically or an architecture where
the admin path cannot be reached without going through Access (no exposed
workers.dev bypass, no route shadowing). Until that verification exists, the
Access layer is deployed as an HTTP gate and MailGable keeps its own
authentication.

## Tradeoffs

* **Session binding**: sessions are User-Agent-bound; IP addresses are hashed
  for audit/rate limits only, so mobile/NAT/IPv6 users are not logged out
  constantly.
* **Passwords**: 15+ character passphrases; long input is rejected, never
  truncated.
* **Iterations**: 8,000 PBKDF2 iterations by default (platform CPU/KDF cap);
  raise `PASSWORD_ITERATIONS` on paid CPU quotas, up to 100,000.

## Roadmap

* WebAuthn / passkeys
* Optional native Cloudflare Access identity integration with JWT verification