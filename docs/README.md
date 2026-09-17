# MailGable Documentation

Everything published with the source tree, organised by what you are trying to do.

## Getting started

| Document | Contents |
| :--- | :--- |
| [README](../README.md) | Project overview, features, and positioning |
| [QUICKSTART.md](QUICKSTART.md) | Zero-to-validated-checkout path for developers |
| [DEPLOY.md](DEPLOY.md) | Canonical deployment guide (fresh Cloudflare account → working inbox) |

## Architecture

| Document | Contents |
| :--- | :--- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Worker, storage, provider, and data-model design |
| [CAPACITY.md](CAPACITY.md) | Storage and quota planning notes |
| [DATA_RETENTION.md](DATA_RETENTION.md) | Retention defaults and deletion semantics |

## Configuration

| Document | Contents |
| :--- | :--- |
| [CONFIGURATION.md](CONFIGURATION.md) | Runtime variables, secrets, and password policy |
| [CREDENTIALS.md](CREDENTIALS.md) | Central credential entry point and lifecycle |
| [CLOUDFLARE_TOKEN_PERMISSIONS.md](CLOUDFLARE_TOKEN_PERMISSIONS.md) | Operator token permission set |
| [providers/](providers) | Per-provider facts: [Resend](providers/RESEND.md), [Brevo](providers/BREVO.md), [Cloudflare Email Service](providers/CLOUDFLARE_EMAIL.md) |

## Operations

| Document | Contents |
| :--- | :--- |
| [OPERATIONS.md](OPERATIONS.md) | Day-2 operations |
| [BACKUP_RESTORE.md](BACKUP_RESTORE.md) | Backup and restore procedure |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Symptom → cause → verification → resolution |
| [FAQ.md](FAQ.md) | Frequently asked questions |
| [ROUTING.md](ROUTING.md) / [inbound-routing-runbook.md](inbound-routing-runbook.md) / [runtime-routing-sync.md](runtime-routing-sync.md) | Email Routing synchronization |
| [UPGRADING.md](UPGRADING.md) / [MIGRATIONS.md](MIGRATIONS.md) | Upgrades and schema evolution |

## Security

| Document | Contents |
| :--- | :--- |
| [SECURITY.md](../SECURITY.md) | Vulnerability reporting and supported versions |
| [SECURITY_MODEL.md](SECURITY_MODEL.md) | Threat model, platform KDF constraints, HTML sandboxing |
| [SECURITY_BASELINE.md](SECURITY_BASELINE.md) | OSPS baseline self-assessment |
| [CLOUDFLARE_ACCESS.md](CLOUDFLARE_ACCESS.md) | Optional external access boundary |
| [resend-credential-lifecycle.md](resend-credential-lifecycle.md) | Resend credential lifecycle specifics |

## Reference

| Document | Contents |
| :--- | :--- |
| [API.md](API.md) | Admin API endpoint reference |
| [DEPENDENCIES.md](DEPENDENCIES.md) | Dependency policy (manual review; no update bot) |
| [BENCHMARK.md](BENCHMARK.md) | Benchmark methodology and data |
| [RELEASE_SMOKE_TEST.md](RELEASE_SMOKE_TEST.md) | Post-deploy smoke test |
| [LIVE_VALIDATION_ENVIRONMENT.md](LIVE_VALIDATION_ENVIRONMENT.md) / [LIVE_VALIDATION_PROCEDURE.md](LIVE_VALIDATION_PROCEDURE.md) | Optional disposable live-validation track |

## Maintainers

| Document | Contents |
| :--- | :--- |
| [RELEASING.md](RELEASING.md) | Version policy and release runbook |
| [MAINTAINER_RUNBOOK.md](MAINTAINER_RUNBOOK.md) | Maintenance procedures |
| [GITHUB_SETUP.md](GITHUB_SETUP.md) | Repository lifecycle and settings |
| [BRAND_CLEARANCE.md](BRAND_CLEARANCE.md) | Brand and license decision record |
| [ROADMAP.md](ROADMAP.md) | Project direction (Now / Next / Later) |
