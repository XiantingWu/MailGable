# Security Baseline

Target: **OSPS (OpenSSF) Baseline Level 1** — and nothing more. Level 2
requires non-author human approval on merges, which conflicts with the
project's single-maintainer contribution policy, so Level 2 is explicitly
not claimed.

## Level-1 items and status

| Item | Status |
| :--- | :--- |
| Repository owner accounts use MFA | **OWNER VERIFIED** (cannot be proven from code) |
| `main` branch protection: no deletion, no force push | ACTIVE — repository ruleset "main protection" (see `docs/GITHUB_SETUP.md`) |
| `LICENSE` file | PASS — Apache-2.0 installed at repository root (owner decision 2026-09-15) |
| Security reporting channel | PASS: `SECURITY.md`; GitHub Private Vulnerability Reporting enabled on the public repository |
| Dependency manifest / lockfile | PASS (`package-lock.json`, `npm ci` only; see `docs/DEPENDENCIES.md`) |
| Dependency update automation | MANUAL — the maintainer applies dependency upgrades behind the full validation gate; no update bot is configured (no bot-authored PRs or contributors) |
| CI/CD workflows in the repository | NOT APPLICABLE — the repository ships as source only; validation runs locally via `npm run check` |
| Actions pinned to immutable SHAs | NOT APPLICABLE (no GitHub Actions workflows bundled) |
| Automation hygiene gate | PASS (`scripts/verify-workflows.mjs` in `npm run check`: no workflows, no dependency bot, toolchain pinned) |
| Generated executable artifact policy | NOT APPLICABLE (no binary/distributed artifact; source → Cloudflare deploy) |
| `codeowners` | PRESENT (owner-repo default) |

## Explicit non-claims

* **Not** "100% secure", "enterprise-grade", or "production-proven".
* **Not** OSPS Level 2 (single-maintainer policy).
* No MFA built into the application itself — see `docs/CLOUDFLARE_ACCESS.md`
  for the recommended external boundary.

## Verification evidence

* `npm run check` (typecheck, unit tests, migration, dry-run, attribution,
  public-docs, security gates) — run locally by the maintainer
* `npm run test:worker` (real workerd runtime tests) — run locally
* `npm run test:e2e` (browser E2E) — run locally
* `scripts/verify-public-docs.mjs` (stale-reference gate) — part of `npm run check`
* `scripts/verify-workflows.mjs` (automation hygiene gate) — part of `npm run check`
* Git history attribution audit — part of `npm run check` (single-contributor)