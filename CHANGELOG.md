# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.1.0] - 2026-09-16

### Added
* Public-quality baseline repository structure for MailGable.
* Automatic type-drift and repository-truth gates (`scripts/refresh-env-types.mjs`, `scripts/verify-migration.mjs`, `scripts/verify-attribution.mjs`, `scripts/verify-public-docs.mjs`, `scripts/verify-release-truth.mjs`, `scripts/verify-provider-configs.mjs`, `scripts/verify-operator-runner.mjs`).
* GitHub governance files: `CODEOWNERS`, `PULL_REQUEST_TEMPLATE.md`, and structured issue templates.
* Public documentation: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`, and the `docs/` handbook (architecture, deployment, configuration, security model, retention, API, routing, operations, troubleshooting, migrations, roadmap).
* Thread lifecycle: Archive, Spam, Trash, Restore, and R2-consistent permanent deletion.
* Optional inbound forwarding (`INBOUND_FORWARD_TO`) and optional automatic BCC (`AUTO_BCC_ADDRESSES` with `AUTO_BCC_REQUIRED` fail-closed enforcement).
* Generic mailbox identities: fresh migrations seed zero hardcoded mailboxes; mailbox records are the only source of truth.
* Administrator password policy: 15-character minimum, 128-byte maximum with rejection instead of silent truncation.
* Message retention (`MESSAGE_RETENTION_DAYS`) and trash purge (`TRASH_RETENTION_DAYS`) with R2-before-D1 deletion.
* Outbound provider boundary (`OutboundProvider` / `ResendProvider`) without behavior changes to idempotency or delivery reconciliation.
* Canonical source layout: `src/mail/*` TypeScript modules and `public/js/*` ES modules replace the generated single-bundle pipeline.
* Apache-2.0 license (`LICENSE` at the repository root, `package.json` SPDX id).

### Changed
* Public documentation matured for release: restructured README (badges, quick links, design choices, screenshots with demo disclosure), documentation index (`docs/README.md`), `docs/QUICKSTART.md`, `docs/FAQ.md`, `docs/RELEASING.md`, and a Now/Next/Later roadmap.
* Clarified the maintainer-led contribution model in `CONTRIBUTING.md` and best-effort support policy in `SUPPORT.md`.

### Security
* Hardened secret and credential boundaries across all scripts, documentation, and configuration templates.
* Documented the platform PBKDF2-SHA256 iteration constraint honestly (workerd cap and Workers Free CPU limits) instead of claiming OWASP-current parameters.
* Ensured zero secrets and zero personal identifiers exist in public codebase.

### Removed
* GitHub Actions workflows; the repository is published as source only, and all validation runs locally through `npm run check`.
* Dependabot version-update automation; dependency upgrades are applied manually by the maintainer, so no bot-authored pull requests or contributors appear.
* Pre-public example-domain mailbox seeds and the special `support`/`contact`/`privacy` identity handling.
* The `source-parts/` deterministic-bundle generation pipeline.
* Removed the Chinese administrative-interface localization. Repository documentation and the administrative UI are now maintained in English only. Unicode email content remains fully supported.