# API

All endpoints live under `/api/admin/mail` (mapped internally to `/api`). Responses are JSON. Every response carries `X-Request-ID` (derived from `CF-Ray` or a generated UUID); error bodies include the same id for correlation with audit logs. All authenticated browser state mutations require a valid session cookie plus the `X-CSRF-Token` header and `Origin` validation. `bootstrap` authenticates with `Origin` plus the bootstrap token; the provider webhook authenticates with a Svix signature.

## Error format

```json
{ "error": "Human readable description", "code": "machine_readable_code", "request_id": "…" }
```

Common codes: `unauthorized` (401), `csrf_invalid` (403), `not_found` (404), `body_too_large` (413), `rate_limited` (429), `database_quota_exceeded` (503, D1 daily row budget exhausted), `internal_error` (500).

## Auth

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| GET | `/auth/status` | – | Initialized/authenticated state |
| POST | `/auth/bootstrap` | `X-Bootstrap-Token` | First-run administrator creation |
| POST | `/auth/login` | – | Sign in (rate limited) |
| POST | `/auth/logout` | session + CSRF | End session |
| POST | `/auth/logout-all` | session + CSRF | Revoke all sessions |
| POST | `/auth/password` | session + CSRF | Change password (revokes sessions) |

## Mailboxes and routing

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| GET | `/mailboxes` | session | Active mailbox identities |
| GET | `/routing-status` | session | Route sync state, forwarding health |
| POST | `/routing-sync` | session + CSRF | Reconcile Cloudflare routes into D1 |
| GET | `/config` | session | Deployment configuration status |
| GET | `/healthz` (public, outside admin namespace) | – | Public health probe (`{"ok":true}`) |
| POST | `/ops/storage-probe` | session + CSRF | D1 + R2 read/write/delete probe |

## Threads

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| GET | `/threads?folder=inbox\|sent\|archive\|spam\|trash\|all&q=&mailbox=&unread=&replied=&attachment=&date_from=&date_to=&limit=&cursor=` | session | Thread list (keyset/cursor pagination via `next_cursor`) |
| GET | `/threads/:id?limit=&offset=` | session | Thread detail (messages, attachments, events) |
| POST | `/threads/:id/read` | session + CSRF | Mark read/unread |
| POST | `/threads/:id/archive` | session + CSRF | Move to Archive |
| POST | `/threads/:id/unarchive` | session + CSRF | Restore from Archive |
| POST | `/threads/:id/spam` | session + CSRF | Mark as spam |
| POST | `/threads/:id/trash` | session + CSRF | Move to Trash |
| POST | `/threads/:id/restore` | session + CSRF | Restore from Trash |
| DELETE | `/threads/:id` | session + CSRF | Permanently delete; R2-first and fail-closed (`503 deletion_incomplete` keeps metadata for retry) |

## Messages

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| POST | `/messages/send` | session + CSRF + `Idempotency-Key` | Compose and send |
| POST | `/messages/:id/retry` | session + CSRF | Safe retry with the original idempotency key |
| POST | `/messages/:id/forward` | session + CSRF | Forward an archived message |
| GET | `/messages/:id/raw` | session | Download raw `.eml` |
| GET | `/attachments/:id` | session | Download attachment (Content-Disposition attachment, nosniff) |

### Send payload

```json
{
  "from_mailbox_id": "…",
  "to": "a@example.com,b@example.net",
  "cc": "",
  "bcc": "",
  "subject": "…",
  "text": "plain text",
  "html": "<p>…</p>",
  "attachments": [{ "filename": "f.txt", "contentType": "text/plain", "content": "<base64>" }],
  "thread_id": "",
  "parent_message_id": ""
}
```

The `Idempotency-Key` header (`[A-Za-z0-9:_./-]{8,256}`) together with the payload hash enforces identical retry payloads and reuses the provider idempotency key within the provider-specific safe-retry window (Resend 23h, Brevo 25m, Cloudflare no assumed idempotency). This reduces duplicate provider submissions; it is not a guarantee of SMTP exactly-once final delivery.

## Webhook

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| POST | `/webhooks/resend` (public, outside admin namespace) | Svix signature | Delivery events (bounce, complaint, delivered, opened, …) |

Signed with the Svix standard (`svix-id`, `svix-timestamp`, `svix-signature`), 5-minute timestamp skew tolerance, replay protection.