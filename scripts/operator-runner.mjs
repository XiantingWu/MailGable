// Unique Wrangler execution layer for operator tooling.
//
// Every Cloudflare-authenticated Wrangler invocation (setup, provider:set,
// provider:remove, credentials:apply, Cloudflare reconcile, setup:deploy,
// setup:migrate, setup:remove-bootstrap, db:migrate:remote) goes through
// runWrangler() so the central credential store is injected consistently:
//
//   - CLOUDFLARE_API_TOKEN  (from .mailbox/credentials.env or process env;
//                            process env wins) — child env ONLY, never a
//                            Worker secret, never printed
//   - CLOUDFLARE_ACCOUNT_ID (from the canonical operator config, ALWAYS
//                            authoritative) — a stale shell value is never
//                            trusted, because deployment resource state is
//                            bound to the configured account
//
// No .env or .dev.vars file is ever generated to carry credentials.
import { spawn } from "node:child_process";
import process from "node:process";
import { loadCredentials } from "./config/credentials.mjs";
import { loadOperatorConfig } from "./config/operator-config.mjs";

export function buildWranglerChildEnv({ credentials, operatorConfig, baseEnv = process.env } = {}) {
  const credentialsResolved = credentials || loadCredentials({ env: baseEnv });
  const operator = operatorConfig || loadOperatorConfig();
  const childEnv = { ...baseEnv };
  // Process env wins (Phase 8): only inject the central value when the
  // caller's environment does not already carry a Cloudflare token.
  if (!childEnv.CLOUDFLARE_API_TOKEN && credentialsResolved.CLOUDFLARE_API_TOKEN) {
    childEnv.CLOUDFLARE_API_TOKEN = credentialsResolved.CLOUDFLARE_API_TOKEN;
  }
  // Account id is canonical operator config (authoritative). A shell value
  // must never override it — and when the operator config has no account
  // id, a stale shell value is removed rather than propagated, so a child
  // process can never target a different account than the one the
  // deployment state is bound to.
  if (operator.cloudflare_account_id) {
    childEnv.CLOUDFLARE_ACCOUNT_ID = String(operator.cloudflare_account_id);
  } else {
    delete childEnv.CLOUDFLARE_ACCOUNT_ID;
  }
  return childEnv;
}

// Returns a childEnv with every credential-bearing variable scrubbed from
// the visible environment; for tests asserting the token never leaks to
// stdout/stderr.
export function publicEnvSnapshot(env) {
  const snapshot = {};
  for (const [key, value] of Object.entries(env)) {
    if (/TOKEN|SECRET|PEPPER|PASSWORD|KEY/i.test(key)) continue;
    snapshot[key] = value;
  }
  return snapshot;
}

function wranglerArgs(args) {
  // Tolerate argv builders that already start with "wrangler".
  return args[0] === "wrangler" ? args.slice(1) : args;
}

export function runWrangler(args, { credentials, operatorConfig, stdio = "inherit", spawnOptions = {} } = {}) {
  const childEnv = buildWranglerChildEnv({ credentials, operatorConfig });
  return spawn("npx", ["wrangler", ...wranglerArgs(args)], {
    env: childEnv,
    stdio,
    ...spawnOptions,
  });
}

export function runCaptureWrangler(args, { credentials, operatorConfig } = {}) {
  const childEnv = buildWranglerChildEnv({ credentials, operatorConfig });
  return new Promise((resolve) => {
    const result = spawn("npx", ["wrangler", ...wranglerArgs(args)], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    result.stdout.on("data", (chunk) => { stdout += chunk; });
    result.stderr.on("data", (chunk) => { stderr += chunk; });
    result.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}

export function runInheritWrangler(args, { credentials, operatorConfig } = {}) {
  const childEnv = buildWranglerChildEnv({ credentials, operatorConfig });
  return new Promise((resolve) => {
    const child = spawn("npx", ["wrangler", ...wranglerArgs(args)], { env: childEnv, stdio: "inherit" });
    child.on("close", (code) => resolve(code === 0));
  });
}