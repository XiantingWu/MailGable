# Releasing

This is the single release runbook for MailGable. Everything else links here.

## Version policy

MailGable follows [Semantic Versioning](https://semver.org/):

* **0.x** is initial development: public APIs, configuration keys, and the D1 schema may still evolve between minor versions. Changelog entries and upgrade notes describe material changes.
* A `1.0.0` release will mark a stability commitment for the documented runtime configuration and operator workflow.

MailGable is a source project: a release is a tagged source tree, not a hosted service. Release notes describe the source and its capabilities — they do not attest any particular deployment's operational state.

## Release gates

All gates must be true on the exact commit being released:

* `npm ci` reproduces the lockfile with no mutation.
* `npm run check` passes (typecheck, tests, migration smoke, dry-run, attribution, public-docs, release-truth, provider-config, automation-hygiene, operator-runner gates).
* `npm run test:worker` and `npm run test:e2e` pass; no skipped tests, no leaked processes.
* `npm audit` reports zero findings at every severity.
* Secret scan and root-hygiene scans are clean.
* The release commit is the exact `main` HEAD (`git rev-parse HEAD == origin/main`).

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/): entries are grouped under `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security`, and `[Unreleased]` becomes `[x.y.z] - YYYY-MM-DD` at release time. Only user-visible changes belong in the changelog.

## Process

1. Confirm the working tree is clean and `main` is at the intended release commit.
2. Move `[Unreleased]` entries under the new version heading with the date.
3. Create a **draft** GitHub release with the version tag and release notes; keep it unpublished.
4. Verify the draft: tag name, target commit SHA, notes content.
5. Publish the release. Repository immutable releases are enabled, so the tag and uploaded assets are locked once published.
6. Verify the published release (`gh release verify <tag>`), and independently hash-compare the source archive against a local archive of the same commit; GitHub-generated source archives are not covered by `gh release verify-asset`.
7. Produce a final source snapshot backup that matches the tagged commit.

## Immutable releases

The repository has GitHub immutable releases enabled. Tags and release assets cannot be moved or replaced after publication; fixes require a new version. Release titles and notes remain editable.

## Dependency updates

Dependency upgrades are applied manually by the maintainer, behind the full validation gate. No dependency bot is configured, and bot-authored pull requests are not used. See [DEPENDENCIES.md](DEPENDENCIES.md).

## Attribution

The canonical history is single-author (`XiantingWu`). `scripts/verify-attribution.mjs` enforces author, committer, and trailer policy in CI; release commits must satisfy the same policy.
