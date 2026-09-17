#!/usr/bin/env node
// Credential lifecycle commands.
//
//   node scripts/credentials.mjs status
//   node scripts/credentials.mjs apply [--config <generated-wrangler>]
//   node scripts/credentials.mjs check
//   node scripts/credentials.mjs rotate <KEY>
//   node scripts/credentials.mjs recover
//
// status prints READY/ABSENT + role + source (file/env/absent) — never
// values, prefixes, suffixes, hashes, or lengths. apply uploads the
// selected persistent runtime secrets (common + active provider) through
// `wrangler secret bulk` via stdin; setup-only credentials are never
// uploaded and no temporary secret JSON file is created. check runs
// read-only capability probes. rotate updates a provider key locally
// (hidden input) and remotely through a journaled transaction; recover
// converges a pending rotation's current local value to the Worker.
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  loadCredentials,
  credentialSources,
  providerActiveCredentials,
  setCredential,
  CREDENTIAL_SCHEMA,
  OPERATOR_LOCAL_CREDENTIALS,
} from "./config/credentials.mjs";
import { loadOperatorConfig } from "./config/operator-config.mjs";
import { validateOperatorState, loadSetupState, loadGeneratedConfig, readCredentialOperationJournal, writeCredentialOperationJournal, clearCredentialOperationJournal, CREDENTIAL_OPERATION_SCHEMA_VERSION } from "./config/operator-state.mjs";
import { currentGitSha } from "./git-state.mjs";
import { runWrangler } from "./operator-runner.mjs";

const COMMAND = process.argv[2] || "status";
const ARG = process.argv[3] || "";
const GENERATED = process.env.MAILBOX_GENERATED_CONFIG || path.join(process.cwd(), "wrangler.deploy.jsonc");

function fail(code, message) {
  console.error(`credentials: [${code}] ${message}`);
  process.exit(1);
}

function status() {
  const credentials = loadCredentials();
  const sources = credentialSources();
  const operatorConfig = loadOperatorConfig();
  const ready = (name) => (credentials[name] ? "READY" : "NOT CONFIGURED");
  const provider = String(operatorConfig.outbound_provider || "none");
  const sendingReady = {
    none: "N/A (receive-only)",
    resend: ready("RESEND_API_KEY"),
    brevo: ready("BREVO_API_KEY"),
    cloudflare: "READY (EMAIL binding, no secret)",
  }[provider];
  const eventsReady = {
    none: "N/A (receive-only)",
    resend: ready("RESEND_WEBHOOK_SECRET"),
    brevo: ready("BREVO_WEBHOOK_TOKEN"),
    cloudflare: "READY (queue events, no secret)",
  }[provider];
  const providerLabel = { none: "none", resend: "Resend", brevo: "Brevo", cloudflare: "Cloudflare" }[provider] || provider;
  // Per-key table: name, READY/ABSENT, lifecycle role, provenance. The
  // source is file/env/absent only — never a path, value, prefix, suffix,
  // hash, or length.
  for (const entry of CREDENTIAL_SCHEMA) {
    const name = entry.key;
    const present = Boolean(credentials[name]);
    const source = sources[name] || "absent";
    console.log(`${name.padEnd(28)} ${present ? "READY " : "ABSENT"}  ${entry.role.padEnd(20)} source=${source}`);
  }
  console.log("");
  console.log(`Cloudflare operator auth       ${ready("CLOUDFLARE_API_TOKEN")}`);
  console.log(`Cloudflare account selection   ${operatorConfig.cloudflare_account_id ? "READY" : "NOT CONFIGURED"}`);
  console.log(`Routing sync                   ${ready("CLOUDFLARE_ROUTING_READ_TOKEN")}`);
  console.log(`Mailbox auth                   ${ready("AUTH_PEPPER")}`);
  console.log("");
  console.log(`Outbound provider              ${providerLabel}`);
  console.log(`Outbound sending               ${sendingReady}`);
  console.log(`Delivery events                ${eventsReady}`);
}

async function applySecrets() {
  const operatorConfig = loadOperatorConfig();
  const provider = String(operatorConfig.outbound_provider || "none");
  if (!["none", "resend", "brevo", "cloudflare"].includes(provider)) fail("unknown_provider", `OUTBOUND_PROVIDER '${provider}' is invalid.`);
  // State gate: refuse to apply against an inconsistent operator state.
  try {
    const currentSha = await currentGitSha(runLocalCapture);
    validateOperatorState({ operatorConfig, setupState: loadSetupState(), generatedConfig: loadGeneratedConfig(), currentSha });
  } catch (error) {
    fail("operator_state_invalid", error.message);
  }
  const credentials = loadCredentials();
  const runtime = providerActiveCredentials(provider, credentials);
  for (const operatorLocal of OPERATOR_LOCAL_CREDENTIALS) {
    if (runtime[operatorLocal]) fail("operator_local_upload", `${operatorLocal} must never be uploaded.`);
  }
  const secretsJson = JSON.stringify(runtime, null, 2);
  const child = runWrangler(["secret", "bulk", "--config", GENERATED], { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.write(secretsJson);
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) fail("secret_apply_failed", "wrangler secret bulk failed.");
  for (const name of Object.keys(runtime)) console.log(`${name}: configured`);
  console.log(`credentials: applied ${Object.keys(runtime).length} persistent secrets (provider=${provider}).`);
}

// Phase 33: read-only capability probes. Never prints provider response
// bodies (they can echo sensitive fields), tokens, token prefixes/suffixes,
// hashes, or lengths, and never embeds Authorization headers in errors.

// Pure HTTP-class classifier shared by every provider probe. A 2xx with a
// provider contract success body is VALID; 401 is an invalid credential;
// 403 is forbidden; 429 is rate-limited; 5xx is a provider error; any
// other status is invalid.
export function classifyCredentialProbe({ status, contractSuccess }) {
  if (contractSuccess) return "VALID";
  if (status === 401) return "INVALID";
  if (status === 403) return "FORBIDDEN";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500 && status < 600) return "PROVIDER_ERROR";
  return "INVALID";
}

// Per-provider probe descriptors: how to authenticate the read-only probe
// request and what a 2xx "provider contract success" body looks like.
// Cloudflare: user token verify, success:true.
// Resend:     webhooks list, data:[].
// Brevo:      webhooks list, webhooks:[].
export const CREDENTIAL_PROBES = {
  CLOUDFLARE_API_TOKEN: {
    url: "https://api.cloudflare.com/client/v4/user/tokens/verify",
    buildHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
    contractSuccess: (body) => body?.success === true,
  },
  RESEND_SETUP_API_KEY: {
    url: "https://api.resend.com/webhooks",
    buildHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
    contractSuccess: (body) => Array.isArray(body?.data),
  },
  BREVO_SETUP_API_KEY: {
    url: "https://api.brevo.com/v3/webhooks",
    buildHeaders: (key) => ({ "api-key": key }),
    contractSuccess: (body) => Array.isArray(body?.webhooks),
  },
};

// One read-only probe. Network/connection failures (DNS, timeout, refused)
// classify as UNREACHABLE; a 2xx that fails the provider contract is
// INVALID; HTTP classes map through classifyCredentialProbe. Response
// bodies and credentials are never returned or logged.
export async function probeCredential(name, value, { fetchFn = globalThis.fetch } = {}) {
  const probe = CREDENTIAL_PROBES[name];
  if (!probe) throw new Error(`credential_probe_unknown: no probe for '${name}'.`);
  let response;
  try {
    response = await fetchFn(probe.url, { headers: probe.buildHeaders(value), signal: AbortSignal.timeout(15_000) });
  } catch {
    return "UNREACHABLE";
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const contractSuccess = Boolean(body) && probe.contractSuccess(body);
  return classifyCredentialProbe({ status: response.status, contractSuccess });
}

async function check() {
  const credentials = loadCredentials();
  const results = [];
  for (const name of ["CLOUDFLARE_API_TOKEN", "RESEND_SETUP_API_KEY", "BREVO_SETUP_API_KEY"]) {
    const value = credentials[name];
    if (!value) {
      results.push(`${name.padEnd(28)} NOT_CONFIGURED`);
      continue;
    }
    const verdict = await probeCredential(name, value);
    results.push(`${name.padEnd(28)} ${verdict}`);
  }
  for (const line of results) console.log(line);
}

// Phase 34: rotate a provider key through a journaled transaction.
//
//   prepared -> local_written -> remote_written -> converged (journal
//   cleared only at the end)
//
// AUTH_PEPPER rotation would invalidate existing password verifications,
// so it is refused. Operator-local keys rotate the local central store
// only — they never execute a Worker secret put. Any remote failure keeps
// the journal so `credentials:recover` can converge the Worker from the
// current local value (never re-asking the secret, never rolling back).
async function rotate() {
  const key = ARG.toUpperCase();
  if (key === "AUTH_PEPPER") {
    fail("pepper_rotation_refused", "rotating AUTH_PEPPER invalidates every existing password. Procedure: rotate each administrator password through the UI first, then rotate the pepper during a maintenance window.");
  }
  const entry = CREDENTIAL_SCHEMA.find((candidate) => candidate.key === key);
  if (!entry) fail("unknown_key", `unknown credential key '${key}'.`);
  assertNoCredentialRecoveryPending();
  const isOperatorLocal = entry.role === "operator-local";
  const value = await hiddenInput(`${key} (hidden input): `);
  if (!value) fail("empty_value", "no value entered; rotation aborted.");

  const workerName = String(loadOperatorConfig().worker_name || "");
  const journal = () => ({
    schema_version: CREDENTIAL_OPERATION_SCHEMA_VERSION,
    operation: "credential_rotate",
    key,
    phase: "",
    started_at: new Date().toISOString(),
    worker_name: workerName,
  });

  writeCredentialOperationJournal({ ...journal(), phase: "prepared" });
  setCredential(key, value);
  writeCredentialOperationJournal({ ...journal(), phase: "local_written" });
  console.log(`${key}: updated locally (atomic, 0600).`);

  if (isOperatorLocal) {
    // Operator-local keys never enter the Worker; nothing to converge.
    clearCredentialOperationJournal();
    console.log(`${key}: operator-local — no Worker secret update.`);
    return;
  }

  const child = runWrangler(["secret", "put", key, "--config", GENERATED], { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.write(value);
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) {
    console.error(`credentials: ${key} updated locally but the Worker update failed. Run \`npm run credentials:recover\` to converge the Worker from the local value.`);
    process.exit(1);
  }
  writeCredentialOperationJournal({ ...journal(), phase: "remote_written" });
  const stored = loadCredentials();
  if (stored[key] !== value) fail("local_verify_failed", `${key} no longer matches the rotated value locally; refusing to declare convergence.`);
  writeCredentialOperationJournal({ ...journal(), phase: "converged" });
  clearCredentialOperationJournal();
  console.log(`${key}: updated on the Worker.`);
}

// Continue a journaled rotation: converge the CURRENT central local value
// to the Worker. Never re-asks the secret and never rolls back to an
// unknown old value. Operator-local journals simply clear (no Worker step).
async function recoverCredentials() {
  const journal = readCredentialOperationJournal();
  if (!journal || !["prepared", "local_written", "remote_written"].includes(journal.phase)) {
    fail("no_credential_recovery_needed", "no pending credential rotation journal found.");
  }
  const key = journal.key;
  const entry = CREDENTIAL_SCHEMA.find((candidate) => candidate.key === key);
  if (!entry) fail("journal_key_unknown", `the journal references unknown key '${key}'.`);
  if (entry.role === "operator-local") {
    clearCredentialOperationJournal();
    console.log(`${key}: operator-local — no Worker secret to converge; journal cleared.`);
    return;
  }
  const value = loadCredentials()[key];
  if (!value) {
    clearCredentialOperationJournal();
    console.log(`${key}: no local value present; nothing to converge (journal cleared).`);
    return;
  }
  const child = runWrangler(["secret", "put", key, "--config", GENERATED], { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.write(value);
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) {
    fail("secret_put_failed", `${key} still not converged; fix the connection and run \`npm run credentials:recover\` again.`);
  }
  clearCredentialOperationJournal();
  console.log(`${key}: converged to the Worker from the central local store.`);
}

function assertNoCredentialRecoveryPending() {
  const journal = readCredentialOperationJournal();
  if (journal && ["prepared", "local_written", "remote_written"].includes(journal.phase)) {
    fail("credential_recovery_pending", `a ${journal.operation || "credential"} rotation for ${journal.key} is pending; run \`npm run credentials:recover\` first.`);
  }
}

function hiddenInput(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      process.stdout.write(question);
      const chunks = [];
      process.stdin.resume();
      process.stdin.on("data", (chunk) => chunks.push(chunk));
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
      return;
    }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdout.write(question);
    let value = "";
    const onKeypress = (str, key) => {
      if (key && key.ctrl && key.name === "c") {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        process.exit(130);
      }
      if (key && (key.name === "return" || key.name === "enter")) {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        process.stdin.removeListener("keypress", onKeypress);
        resolve(value);
      } else if (key && key.name === "backspace") {
        value = value.slice(0, -1);
      } else if (str) {
        value += str;
      }
    };
    process.stdin.on("keypress", onKeypress);
  });
}

// Local runner for NON-Wrangler commands only (git rev-parse HEAD).
function runLocalCapture(command, args) {
  return new Promise((resolve) => {
    const result = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    result.stdout.on("data", (chunk) => { stdout += chunk; });
    result.stderr.on("data", (chunk) => { stderr += chunk; });
    result.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}

async function main() {
  if (COMMAND === "status") return status();
  if (COMMAND === "apply") return applySecrets();
  if (COMMAND === "check") return check();
  if (COMMAND === "rotate") return rotate();
  if (COMMAND === "recover") return recoverCredentials();
  console.error("usage: node scripts/credentials.mjs <status|apply|check|rotate <KEY>|recover>");
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}