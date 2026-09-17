# Backup & Restore

A self-hosted mailbox must answer: how do I recover my mail?

## What MailGable stores

| Data | Where | Backed up by |
| :--- | :--- | :--- |
| Message metadata, threads, bodies, delivery state, audit log | D1 | D1 export (below) |
| Raw MIME, attachments | R2 | R2 snapshot (below) |
| Delivery records | Resend | **not** part of a MailGable backup |
| Forward/BCC copies | external destinations | not retrievable by MailGable |

## D1 backup

```bash
npx wrangler d1 export DB --remote --output=mailgable-backup-YYYYMMDD.sql
```

D1 exports produce schema + data SQL. Restore into a fresh database:

```bash
npx wrangler d1 create mailgable-db-restore
# update wrangler.deploy.jsonc with the new database_id
npx wrangler d1 execute DB-restore --remote --file=mailgable-backup-YYYYMMDD.sql
npx wrangler d1 migrations apply DB --remote   # apply any migrations newer than the backup
```

> [!IMPORTANT]
> Restore into an **empty** database. Re-running a restore against a database
> that already contains rows will violate primary keys.

## R2 backup

R2 has no built-in snapshot/restore on all plans; use the provider's bucket
tooling or `rclone`-style mirroring to another region/bucket:

```bash
# example with rclone (configure a remote pointing at the bucket)
rclone sync r2:mailgable-r2 /path/to/mirror
```

Restore order:

1. Restore R2 objects first (messages reference object keys; a missing object breaks downloads and retries).
2. Restore D1 next.
3. Apply any migrations released after the backup.
4. Rebuild routing: after restore, run the routing sync from the admin UI (or `sync-routing-mailboxes.ps1`) so mailbox identities match the Cloudflare snapshot.

## Schema versioning

`migrations/` are applied in order; `scripts/verify-migration.mjs` verifies
fresh-install invariants, and the test suite covers the upgrade path (e.g.
`0008` migrates pre-public folder statuses). A backup restored into a newer
schema should be migrated forward only, never backward.

## What is NOT part of a backup

* Resend delivery records — the provider's own history is authoritative for
  sent messages; after a restore, delivery events recorded *after* the backup
  are lost (the provider will not replay them).
* Forwarded copies and automatic BCC copies at external providers.
* Cloudflare Email Routing configuration — rebuild it from the routing rules
  or the `deployment-backups/` snapshots written by the operator scripts.

## Verify a restore

At least once per release cycle, run a disposable restore smoke test:

1. Create fresh D1 + R2.
2. Restore an export and the mirror.
3. Boot the Worker against the restored resources.
4. Open a known thread, download its raw message and attachment.
5. Send a reply and confirm delivery state appears.

## See also

* [Data retention](DATA_RETENTION.md)
* [Operations](OPERATIONS.md)