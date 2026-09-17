# Quick Start

From nothing to a validated local checkout. No Cloudflare account is required for this path.

## Prerequisites

* **Node.js 22.23.2** and npm ≥ 10. The exact toolchain is pinned in `.nvmrc` and `.node-version`; CI runs Node 22.23.2.
* Git.

## 1. Clone and install

```bash
git clone https://github.com/XiantingWu/MailGable.git
cd MailGable
npm ci
```

`npm ci` is the only supported install command — `package-lock.json` is authoritative.

## 2. Run the full validation suite

```bash
npm run check
```

This runs, in order: binding-types drift check → TypeScript compile → unit/integration tests → migration smoke test → Wrangler deploy dry-run → attribution, public-docs, release-truth, provider-config, automation-hygiene, and operator-runner gates.

Optionally add the runtime and browser layers:

```bash
npm run test:worker   # workerd runtime tests (Vitest)
npm run test:e2e      # Playwright browser E2E (installs Chromium on first run)
```

Every command above must pass with **zero production credentials**.

## What success looks like

* `npm run check` exits `0` and ends with the worker-runtime summary.
* `npm run test:e2e` reports all browser tests passing, `0` skipped. The E2E harness starts a local `wrangler dev` process, seeds demo data, and tears it down with no leaked processes.

## 3. Run the worker locally

```bash
npm run dev
```

`wrangler dev` starts the Worker against a local D1 instance. Runtime configuration for local development lives in `.dev.vars` (copy `.dev.vars.example`); it is gitignored.

## Next steps

* Deploy to your own Cloudflare account: [DEPLOY.md](DEPLOY.md)
* Understand the design: [ARCHITECTURE.md](ARCHITECTURE.md)
* Configure runtime variables: [CONFIGURATION.md](CONFIGURATION.md)
* Something failing? [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
