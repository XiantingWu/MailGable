# Contributing to MailGable

Thank you for contributing to MailGable! Please review these guidelines before participating.

---

## Contribution Model

MailGable is maintained by a single maintainer. To keep the canonical repository history attributable to exactly one identity:

> Code pull requests from external contributors are currently not accepted.
> Bug reports, feature requests, reproducible cases, and design suggestions are welcome.
> Code changes merged into the canonical repository are maintained by XiantingWu.

Please open an issue before starting substantial code work: it lets the maintainer confirm direction first, and avoids effort on changes that would not be merged.

If you open a code pull request from another account, it will be reviewed and closed with thanks. If your suggestion is adopted, the maintainer re-implements it in a new commit. External PRs are not rebased, merged, or squashed into `main`, because those operations can carry third-party author attribution into the canonical history.

The repository enforces this policy with:

* Repository-local Git hooks (`.githooks/`) that reject commits outside the single allowed identity and commit messages containing attribution trailers.
* `scripts/verify-attribution.mjs`, which audits every reachable commit (author, committer, email, and message trailers) and runs in CI and as part of `npm run check`. Platform-generated merge/squash commits are accepted only when the commit author is the allowed identity — the committer recorded by GitHub is treated as a platform artifact, not a person.

**Security issues must never be opened publicly.** Follow [SECURITY.md](SECURITY.md) and use private vulnerability reporting.

---

## Local Development Workflow

### 1. Requirements

* **Node.js 22.x** (`.nvmrc` pins the supported major; CI runs Node 22)
* npm (lockfile is authoritative — always use `npm ci`)
* A Cloudflare account only if you deploy; the full local suite needs no external credentials

### 2. Installation

Always use clean dependency installation:

```bash
npm ci
```

### 3. Source layout

Sources are edited directly — there is no code generation step.

* **Backend**: edit `src/**/*.ts` (Worker entry `src/index.ts`, modules under `src/mail/`, providers under `src/providers/`).
* **Frontend**: edit `public/js/*.mjs` (plain ES modules, no build step) and `public/*.css` / `public/index.html`.

### 4. Verification Commands

Run these locally before proposing a change. CI runs the same commands:

```bash
npm test            # unit/integration tests + migration smoke + migration verification
npm run test:worker # Worker runtime tests (workerd via Vitest)
npm run check       # typecheck + tests + dry-run + attribution + public-docs + security gates
npm run test:e2e    # browser E2E (Playwright; installs Chromium on first run)
```

The full suite is secretless: it must pass with **zero production credentials**.

### 5. Branch / PR Expectations

* Keep changes focused, scoped, and clearly titled.
* Use descriptive branch names; `main` is the only long-lived branch.
* Complete every section in [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md).
* Expect review from the maintainer; adopted changes may be re-implemented under the single-author policy.

---

## Engineering Standards

### Security & Privacy

* **Zero Real Secrets**: Never commit API keys, Cloudflare tokens, webhook secrets, or private passwords.
* **No Real PII / Emails**: Do not commit real personal email addresses, production dumps, or customer data. Use RFC example domains (`example.com`, `example.org`, `example.net`).
* **Synthetic Fixtures**: All test fixtures and attachments must be synthetically generated.
* **Threat Analysis**: For changes touching `src/auth.ts`, session handling, webhook parsing, or object storage permissions, document the threat-model impact in the PR description.

### Database Migrations

* Schema changes must be added as **new, sequentially numbered migration files** in `migrations/` (e.g., `0008_feature_name.sql`).
* Once released, existing migrations must not be modified or reordered.
* All migrations must pass `scripts/verify-migration.mjs`; exercise both fresh-install and upgrade paths.
* Read [docs/MIGRATIONS.md](docs/MIGRATIONS.md) before adding a migration.

### Provider Changes

* Providers live under `src/providers/` behind the shared `OutboundProvider` boundary.
* Provider behavior is covered by contract tests (`npm run test:provider-contracts`) and configuration checks (`npm run check:provider-configs`, part of `npm run check`).
* Delivery-event handling must stay idempotent and monotonic; document webhook trust assumptions per provider.

### Documentation

* Documentation must match behavior. `scripts/verify-public-docs.mjs` (part of `npm run check`) fails on stale references and removed terminology.
* When behavior changes, update the README, the relevant `docs/` handbook page, and the API reference in the same change.
* Keep one source of truth per topic; link existing documents instead of duplicating content.

### Pull Request Quality

* Include tests for behavioral changes where practical; explain why if not.
* Keep the validation suite green: no change may require repository secrets.
* Workflows must pin external actions to full commit SHAs and keep `contents: read` defaults.
