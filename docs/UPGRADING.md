# Upgrading

How to upgrade MailGable between releases. The project is 0.x: releases may
change configuration and schema, but every release ships the migrations to
take you forward. **Back up before upgrading.**

## Procedure

1. **Back up** (see [BACKUP_RESTORE.md](BACKUP_RESTORE.md)):
   ```bash
   npx wrangler d1 export DB --remote --output=pre-upgrade-$(date +%Y%m%d).sql
   # and mirror the R2 bucket with your backup tooling
   ```
2. **Pull/tag** the new version:
   ```bash
   git fetch origin
   git checkout <tag-or-branch>
   npm ci
   ```
3. **Run the preflight checks**:
   ```bash
   npm run check
   ```
4. **Apply migrations** (fresh installs and upgrades share the same set):
   ```bash
   npm run db:migrate:remote
   ```
5. **Deploy**:
   ```bash
   npm run deploy
   ```
6. **Post-deploy smoke**: open the admin UI, confirm routing sync state,
   send a test message, verify delivery state, and run the storage probe.

## Rollback limitations

* Migrations are forward-only. Rolling back to an older release requires
  restoring the pre-upgrade D1 export and R2 mirror into fresh resources.
* New migrations are tested on the upgrade path in CI; a backup restored
  into a newer schema can only be migrated forward.
* Provider (Resend) records are not part of MailGable backups.

## Release contract

* Every release documents its migration version (`docs/MIGRATIONS.md`).
* `0.1.0` is an immutable release tag; tags are never moved or overwritten.
* The `[Unreleased]` changelog section lists pending changes; released
  versions get dated entries.