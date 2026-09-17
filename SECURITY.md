# Security Policy

The security of MailGable and its underlying email processing infrastructure is fundamental. This document outlines the vulnerability reporting policy, technical constraints, and security boundary considerations.

---

## Supported Versions

| Version | Supported |
| :--- | :--- |
| `main` (active development) | :white_check_mark: |

Security patches are applied to the active default branch. This is a 0.x project: no semantic-version support contracts exist until the v1.0.0 milestone.

---

## Reporting a Vulnerability

> [!CAUTION]
> **Please do NOT report security vulnerabilities through public GitHub Issues, pull requests, or public discussions.**

Report all potential security vulnerabilities privately. Prefer **GitHub Private Vulnerability Reporting** from the repository's Security tab (Security → "Report a vulnerability"); if that entry point is unavailable, contact the maintainer directly through the repository owner.

When submitting an advisory:

1. Provide a clear description of the vulnerability and its potential impact.
2. Include minimal, reproducible steps or proof of concept.
3. **Do NOT include live production credentials, real API tokens, personal email data, or private Cloudflare identifiers.**
4. Allow reasonable time for remediation prior to public disclosure.

---

## Security Architecture & Subsystem Boundaries

### 1. Authentication & Password Derivation
* **Password Policy**: Passwords are NFC-normalized and must be at least **15 characters** (Unicode code points); more than 128 code points or 512 bytes is **rejected, never silently truncated**. Unicode passphrases and spaces are allowed; there are no composition requirements.
* **Password Hashing**: NFC-normalized passwords are derived with PBKDF2-SHA256 (unique 16-byte salt, `PASSWORD_ITERATIONS`) and the derived key is **HMAC-SHA256-signed with `AUTH_PEPPER`** (≥ 32 bytes). The hash therefore depends on the pepper. Legacy plain-PBKDF2 hashes verify on login and upgrade to the v1 scheme automatically. Rotating `AUTH_PEPPER` invalidates existing verifiers unless the old pepper is temporarily retained.
* **Platform KDF Constraint**: Cloudflare Workers Free enforces a 10 ms CPU limit per invocation, and the `workerd` runtime caps WebCrypto PBKDF2 iterations at 100,000. The default of 8,000 iterations (~4 ms) fits that budget. MailGable therefore does **not** claim OWASP-current (600,000) PBKDF2 parameters; this is an explicit platform constraint. Deployments with paid CPU quotas may raise `PASSWORD_ITERATIONS` (max 100,000).
* **No MFA yet**: a single passphrase is the only authentication boundary. Cloudflare Access / WebAuthn are on the roadmap.
* **Session Management**: Sessions use cryptographically random 256-bit tokens, stored as SHA-256 hashes in D1, transmitted via `__Host-` prefixed, `Secure`, `HttpOnly`, `SameSite=Strict` cookies, bound to the User-Agent. IP addresses are privacy-preserving hashed for audit and rate-limit metadata and are intentionally not enforced as a session bound (mobile/NAT/IPv6 users would be logged out constantly).

### 2. Cross-Site Request Forgery (CSRF) & State Protection
* All authenticated browser state mutations (`POST`, `PUT`, `DELETE`) require the `X-CSRF-Token` header and origin validation against the canonical application origin. `bootstrap` uses Origin plus the one-time bootstrap token; provider delivery-event ingress is authenticated per provider (see section 5).

### 3. Inbound Processing & Raw MIME Sanitization
* Inbound emails are captured through Cloudflare Email Routing events; unknown or inactive recipients are rejected.
* **Content Sandboxing**: HTML bodies are sanitized server-side, then rendered in a sandboxed iframe with `sandbox=""` and a restrictive CSP (`default-src 'none'`, remote images blocked by default).
* **Resource Limits**: Incoming MIME messages are capped at 20 MiB raw, 8 MiB per attachment and 15 MiB total (50 attachments); outgoing at 5 MiB per attachment and 8 MiB total.
* **No antivirus scanning**: MailGable does not inspect content for malware. Do not treat it as a filtering gateway.

### 4. Storage Isolation & R2 Archival
* Raw MIME streams and binary attachments are archived in private Cloudflare R2 object storage with unguessable key identifiers (`incoming/...`, `outgoing/...`).
* Storage buckets are completely private and never exposed directly to public HTTP traffic.
* Deletion is R2-first: hard delete removes archive objects before D1 rows and reports orphaned keys instead of leaking them silently.

### 5. Provider Delivery-Event Authentication & Outbound Idempotency

Provider delivery-event ingress is authenticated per provider — no single
cryptographic scheme is claimed for all providers:

* **Resend** webhooks are verified with the Svix raw-body cryptographic
  signature (`svix-id`, `svix-timestamp`, `svix-signature`) against the
  configured `RESEND_WEBHOOK_SECRET`, with bounded timestamp skew and
  replay protection.
* **Brevo** webhooks are authenticated with the configured Bearer
  `BREVO_WEBHOOK_TOKEN` compared in constant time; unauthenticated or
  mismatched requests are rejected before processing.
* **Cloudflare Email Service** delivery events arrive through a Queue Event
  Subscription consumed by the Worker; only `source.type=email.sending` and
  the official `cf.email.sending.message.*` lifecycle events are accepted —
  Email Routing inbound events are never treated as delivery events.

Shared guarantees across all providers:

* event correlation to the archived message,
* duplicate protection (an already-recorded `(provider, provider_event_id)`
  is a no-op before any message mutation; `UNIQUE` constraints guard races),
* out-of-order monotonic merge (events never regress a delivered/terminal state),
* bounded body/input handling,
* no secret logging.

Idempotent sending uses a client-chosen `Idempotency-Key` with a payload
hash. The application-level safe-retry window is **provider-specific**:
Resend 23 hours (below its 24-hour idempotency key validity), Brevo 25
minutes (below its ~30-minute TTL), Cloudflare no assumed idempotency
(unknown outcomes are never auto-retried).

### 6. Cloudflare Credentials & Least Privilege
* Local testing and dry-run deployments require **zero production credentials**.
* The validation suite (`npm run check`) must succeed with **zero production credentials**; it runs locally and never receives repository secrets.
* Runtime routing synchronization requires only scoped, read-only Cloudflare Email Routing permissions (`CLOUDFLARE_ROUTING_READ_TOKEN`).

### 7. Logging & Privacy
* Logs never contain raw MIME, message bodies, API keys, passwords, session tokens, webhook secrets, or full authorization headers.
* `LOG_LEVEL=debug` is available but never enabled by default.
* Email data is personal data: see [docs/DATA_RETENTION.md](docs/DATA_RETENTION.md) for where copies exist (forwarding, BCC, provider).