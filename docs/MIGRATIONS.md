# Migrations

Database schema changes are incremental SQL files in `migrations/`, applied in order by Wrangler's D1 migration tooling.

## Policy

* New schema changes are a **new** file with the next number after the highest existing migration (e.g. after `0011`, the next file is `0012_*.sql`).
* Released migrations are never modified or reordered.
* Fresh installs and upgrades must both be verified by `node scripts/verify-migration.mjs` (part of `npm run check` and CI).
* The documented migration set must equal the filesystem migration set; a machine-checkable test (`tests/migration-doc-match.test.mjs`) enforces this so the documentation cannot silently drift behind the schema again.

## Verification

```bash
npm run check          # includes the SQLite migration smoke test
npm run db:migrate:local   # local dev database
npm run db:migrate:remote  # production D1
```

The smoke test applies every migration to an in-memory SQLite database and asserts:

* required columns exist (`request_hash`, `provider_internet_message_id`, `body_truncated`, `recipient_status_json`, `reply_to_json`, `routing_managed`),
* the fresh database contains **zero hardcoded mailbox identities**,
* `inbound_forward_attempts`, `mail_ops_probes`, and the relaxed admin password-iteration CHECK exist.

## History

| Migration | Contents |
| :--- | :--- |
| 0001 | Core schema: admins, sessions, attempts, mailboxes, threads, messages, attachments, delivery events, audit log |
| 0002 | Hardening: body truncation, request hash, recipient status JSON, provider message ids |
| 0003 | Reply safety: `reply_to_json`, thread/mailbox index |
| 0004 | Operations probes |
| 0005 | Relaxed password iteration CHECK (platform KDF constraint) |
| 0006 | `routing_managed` flag and index |
| 0007 | Per-target inbound forward attempts |
| 0008 | `mail_threads.status` rebuilt with the `archived` vocabulary (pre-public `closed` rows migrate to `archived`) |
| 0009 | Password scheme versioning (`admins.password_scheme`) and audit correlation index fix |
| 0010 | Denormalized thread list read model (latest message summary columns, cursor index, backfill) |
| 0011 | Generic outbound provider identity: `outbound_provider`/`provider_message_id`/`provider_retry_deadline` on messages, provider-generic delivery-event identity, unique provider namespaces, Resend backfill |

## Pre-public normalization

Before the first public release the seed rows for example-domain mailbox identities were removed from migrations so that a fresh install starts with an empty, operator-controlled mailbox table.