# Security Model

## Scope

MailGable is a **single-administrator** self-hosted mailbox. The threat model assumes the Cloudflare account (Workers, D1, R2, Email Routing) is controlled by the operator, and that the operator wants a durable, private archive of domain email without running a mail server.

## Authentication

* Passwords are NFC-normalized, then derived with PBKDF2-SHA256 (per-admin random 16-byte salt, `PASSWORD_ITERATIONS`, default 8,000) and the 32-byte derived key is **HMAC-SHA256-signed with `AUTH_PEPPER`** (scheme `pbkdf2-sha256+hmac-sha256-v1`). The verifier therefore depends on the pepper: different peppers produce different hashes for identical password/salt/iterations. `AUTH_PEPPER` is never stored in D1, logged, or returned from the API.
* **Legacy hashes**: any pre-v1 hash (plain PBKDF2) verifies on login and is immediately re-derived and upgraded to the v1 scheme.
* **Pepper rotation**: rotating `AUTH_PEPPER` invalidates existing password verifiers unless the old pepper is temporarily retained for migration; treat rotation as a planned, documented operation.
* **Platform KDF constraint**: Cloudflare's `workerd` runtime has been observed to reject WebCrypto PBKDF2 requests above 100,000 iterations — a currently observed platform ceiling, not a documented API guarantee — and the Workers Free plan limits CPU to 10 ms per request, which fits roughly 8,000 iterations. MailGable therefore does **not** claim OWASP-current (600,000) PBKDF2 parameters. Decision basis: the default (`PASSWORD_ITERATIONS=8000`) is chosen to stay inside the Free-tier 10 ms CPU budget so receive-only deployments work plan-independently; operators on paid CPU quotas should raise it toward the observed ceiling after measuring their own request budget. A local WebCrypto benchmark (Node 22, Apple Silicon; salt + PBKDF2-SHA-256 + HMAC-pepper; not a Workers production measurement) measured 8,000 iterations at ≈ 2.4 ms median (max ≈ 5.5 ms) and 100,000 iterations at ≈ 16.8 ms median — supporting this choice. The pepper remains defense-in-depth — it is not a substitute for KDF work factor. Compensating controls:
  * mandatory ≥ 15-character passphrases (15 Unicode code points after NFC normalization; ≤ 128 code points / 512 bytes),
  * `AUTH_PEPPER` ≥ 32 bytes,
  * login rate limiting per IP and per email,
  * User-Agent-bound sessions (IP addresses are privacy-preserving hashed for audit and rate-limit metadata, not enforced as a session bound),
  * session tokens stored hashed (SHA-256) in D1,
  * `__Host-` prefixed `SameSite=Strict` cookies.
* **No MFA yet.** Treat a single passphrase as the only boundary. Roadmap: Cloudflare Access / external identity and WebAuthn/passkeys.

## Sessions and CSRF

* Session tokens: 32 random bytes, transported only in the `__Host-` cookie (`Secure`, `HttpOnly`, `SameSite=Strict`, bounded `Max-Age`).
* Sessions are bounded twice: an absolute lifetime (`SESSION_HOURS`, default 12) and an inactivity window (`SESSION_IDLE_MINUTES`, default 60; `0` disables idle expiry). An expired session is revoked server-side on first use after expiry.
* State-changing endpoints require an `X-CSRF-Token` header matching the session, plus a matching `Origin`.
* Password changes and "sign out all" revoke every session.

## Inbound mail safety

* Unknown or inactive recipients are rejected at the Email Routing boundary.
* Raw MIME is stored in a **private** R2 bucket; the browser never receives raw bytes except via an authenticated download endpoint.
* Attachments are size-bounded (20 MB raw, 8 MB per attachment inbound with total caps), filename-sanitized, and integrity-hashed (`sha256` verified on every reuse).
* **No antivirus scanning.** MailGable does not inspect content for malware; do not treat it as a filtering gateway.

## HTML mail rendering

* Inbound HTML is sanitized server-side, then rendered in a sandboxed iframe with:
  * `sandbox="allow-popups allow-popups-to-escape-sandbox"` — **no** `allow-scripts`, `allow-same-origin`, or `allow-forms`; the sandbox is the final boundary even if sanitization misses an edge case,
  * `Content-Security-Policy: default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'`,
  * remote images blocked by default (every `src`/`srcset` is removed),
  * **link policy**: only `https:` and `mailto:` hrefs survive and are rewritten to `target="_blank" rel="noopener noreferrer nofollow"`; `http:`, `javascript:` (mixed-case included), `data:`, `vbscript:`, protocol-relative, and relative URLs are stripped, along with any attacker-supplied `target`/`rel`/`download` attributes.
* The admin page itself is served with a strict top-level CSP and `X-Frame-Options: DENY`.

## Observability and query strings

Cloudflare Workers invocation logs record request URLs, including query
strings (search terms, mailbox filters). The application's own custom logs
only ever contain redacted fields (`docs/CONFIGURATION.md`). If URL query
strings are unacceptable in platform logs, operators can disable invocation
logs (`observability.logs.invocation_logs = false`) or retain only sampled
logs (`head_sampling_rate`) — the current Wrangler schema does not support
query-string redaction, so this is a documented platform tradeoff, not a
hidden guarantee.

## Webhooks

* Provider delivery events must carry a valid Svix signature with a bounded timestamp skew (`svix-id` replay protection).
* Webhook payloads are stream-bounded (1 MiB) before buffering.
* Delivery status merges are monotonic; out-of-order or duplicate events cannot regress state.

## Secrets hygiene

* No secrets in source: secrets are installed as Worker secrets via the central operator runner and a gitignored `.dev.vars` is used only for local development.
* Logs never include raw MIME, message bodies, API keys, passwords, session tokens, webhook secrets, or full authorization headers. Email addresses are only logged where operationally essential and may be hashed.

## Data privacy

See [Data retention](DATA_RETENTION.md). Email is personal data: `INBOUND_FORWARD_TO` and `AUTO_BCC_ADDRESSES` create third-party copies that MailGable cannot retract.

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md). Private vulnerability reporting will be enabled on the public repository.