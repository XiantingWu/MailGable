# Data Retention

Email contains personal information. This document states exactly where mail data lives, how long it is kept, and how it is deleted.

## Where data lives

| Storage | Contents |
| :--- | :--- |
| D1 database | Message metadata, subject, sanitized text/HTML body previews, recipients, delivery events, audit log, session and rate-limit state |
| R2 bucket (private) | Raw MIME (`*.eml`) and attachment objects |
| External destinations | If `INBOUND_FORWARD_TO` is configured, a copy is sent to those addresses. If `AUTO_BCC_ADDRESSES` is configured, every send includes those BCC recipients. MailGable cannot retract these third-party copies. |
| Resend | The outbound provider retains delivery records per its own policy |

## Retention defaults

| Setting | Default | Meaning |
| :--- | :--- | :--- |
| `MESSAGE_RETENTION_DAYS` | `0` | `0` = retain messages indefinitely. Any positive value permanently deletes messages (and their R2 objects) older than that age on the daily cleanup run. |
| `TRASH_RETENTION_DAYS` | `30` | Threads in Trash are permanently deleted after this many days on the daily cleanup run. |

The daily cleanup (`crons: ["17 4 * * *"]`) also removes:

* delivery events older than 180 days,
* audit log rows older than 365 days,
* storage probes older than 24 hours,
* settled forward-attempt rows older than 180 days.

## Deletion semantics

* **Trash** moves a thread to `status='trash'`; it no longer appears in Inbox/Archive/Sent and is subject to `TRASH_RETENTION_DAYS`.
* **Restore** returns a trashed thread to the normal folders.
* **Hard delete** (`DELETE /api/threads/:id`) is **R2-first and fail-closed**:
  1. collects every R2 key (raw + attachments) for the thread,
  2. deletes all R2 objects in batched calls (≤ 1000 keys per call),
  3. if **any** R2 deletion fails, D1 metadata and the thread are **preserved intact** and the request returns `503 deletion_incomplete` — a retry is safe and idempotent,
  4. only after all R2 objects are gone are D1 rows removed (delivery events, attachments, messages, thread).

Because R2 and D1 are not transactional together, the order is deliberately R2-first: a failure leaves the database row intact for retry, and there is no API response that requires manually copying orphaned keys — the retry is the mechanism.

* **Scheduled cleanup** (retention and trash purge) follows the same fail-closed rule: a temporary R2 failure defers the deletion, the thread remains, and the next scheduled run retries automatically.

## Data owner responsibility

* You (the operator) own the data and its deletion.
* Backups of D1/R2 are outside MailGable's control; if you snapshot storage, retention applies to the live data only.
* Deleting a message does not delete provider (Resend) or forward/BCC copies.