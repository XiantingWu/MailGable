# GitHub Repository Lifecycle & Setup Guide

This guide details the sequential setup procedures across the repository lifecycle: before initial push, after initial private push, prior to public disclosure, and post-publication governance.

---

## Phase A: Before First Push (Local Staging)

1. **Verify Remote Origin**:
   ```bash
   git remote -v
   # Should point to XiantingWu/MailGable (SSH or HTTPS)
   ```
2. **Confirm Working Brand**:
   `MailGable` is the selected brand and is applied across the tree (package, docs, UI, resource defaults).
3. **Open Source License — SELECTED**: `Apache-2.0` is installed as the root
   `LICENSE` (canonical text) and `package.json` carries the same SPDX id.
4. **Secret & Residue Scan**:
   Verify zero live credentials, personal emails, or private account IDs exist across the codebase:
   ```bash
   npm run check
   ```
5. **Code of Conduct**:
   **Owner decision (2026-09-15): no `CODE_OF_CONDUCT.md` is included.** No
   public moderation contact is configured, so no conduct policy is published.
6. **Confirm Git Ignore**:
   Ensure `.dev.vars` is ignored while `.dev.vars.example` is tracked.

---

## Phase B: After First Private Push (Private Repository Verification)

1. **Perform Initial Push**:
   ```bash
   git push -u origin main
   ```
2. **Verify the Tree**:
   * Confirm `git status` is clean and the pushed commit matches the local candidate.
   * The repository ships **without GitHub Actions workflows**; all validation runs locally with `npm run check` before pushing.

---

## Phase C: Before Changing Visibility to Public

1. **Finalize License**:
   `LICENSE` (Apache-2.0) is present and committed; verify GitHub license
   detection after publication.
2. **Repository Rename Handling**:
   > [!IMPORTANT]
   > If the repository is renamed from `XiantingWu/MailGable` prior to publication, update all repository-specific GitHub URLs in `.github/ISSUE_TEMPLATE/config.yml`, `SECURITY.md`, `SUPPORT.md`, and `.github/CODEOWNERS`.
3. **Verify Documentation**:
   Ensure `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`, and `CHANGELOG.md` are aligned with the final release scope.

---

## Phase D: Immediately After Visibility is Changed to Public

### 1. Repository Details & About
* **Description**:
  ```text
  Self-hosted email inbox built on Cloudflare Workers, D1, and R2.
  ```
* **Topics**:
  ```text
  email, self-hosted, cloudflare, cloudflare-workers, email-routing, d1, r2, typescript
  ```

### 2. Community Features
Under **Settings ➔ General**:
* [ ] **Issues**: Enabled
* **Discussions**: **Disabled** (owner decision: this release does not maintain a forum surface; questions go to Issues)
* [ ] **Wikis**: Disabled (documentation is maintained within the repository)

> The project is single-contributor: external **code** PRs are not merged
> (see CONTRIBUTING.md). Do **not** create `good first issue` or
> `help wanted` labels; they would invite contributors whose code PRs get
> closed. Issues, feature requests, design discussions, and security
> reports are explicitly welcome.

### 3. Code Security & Analysis
Under **Settings ➔ Code security and analysis**:
* [ ] **Private vulnerability reporting**: Enabled
* [ ] **Secret scanning / Push protection**: Enabled where available
* **Dependabot security/version updates**: **Not used** (owner decision). Dependency updates are applied manually by the maintainer; no bot-authored pull requests or contributors appear.
* **Dependency graph**: Optional (only needed for GitHub SBOM export; no CI depends on it).

### 4. Branch Protection & Ruleset for `main`
Under **Settings ➔ Rules ➔ Rulesets** (create a ruleset targeting `main`):
* **Target branches**: Default branch (`main`)
* **Enforcement**: Active
* **Rules**:
  * [ ] **Restrict deletions**
  * [ ] **Block force pushes**
  * No required status checks (the repository ships without workflows)
  * No required pull request (single-maintainer direct pushes)

### 5. Issue & PR Label Inventory
Ensure the following standard labels exist in **Issues ➔ Labels**:
* `bug` (Red: `#d73a4a`) - Confirmed bugs or unexpected defects
* `enhancement` (Blue: `#a2eeef`) - New features or improvements
* `security` (Dark Red: `#b60205`) - Security and vulnerability fixes
* `documentation` (Purple: `#0075ca`) - Documentation updates
* `dependencies` (Yellow: `#0366d6`) - Automated and manual dependency updates
* `breaking-change` (Orange: `#d93f0b`) - Backward-incompatible modifications
* `question` (Pink: `#d876e3`) - Clarification or design discussions

### 6. Social Preview Image
When the branding is finalized, upload a 1280 × 640 social preview image under **Settings ➔ General ➔ Social preview**.
