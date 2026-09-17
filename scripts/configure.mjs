#!/usr/bin/env node
// Interactive configuration wizard (configure once).
//
//   npm run configure                        interactive (hidden secret input)
//   npm run configure -- --all-providers     store all three providers' credentials
//   npm run configure -- --non-interactive   CI/headless: read env + files
//
// Writes gitignored .mailbox/config.json (non-secret) and
// .mailbox/credentials.env (secrets, 0600, atomic). Generated values are
// reported as "generated"/"stored" only. Existing credentials are never
// re-prompted: each entry shows PRESENT and asks "Keep existing? [Y/n]".
import { createInterface } from "node:readline/promises";
import readline from "node:readline";
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  loadCredentials,
  writeCredentialsFile,
} from "./config/credentials.mjs";
import { loadOperatorConfig, validateOperatorConfig, canonicalOperatorConfig, OUTBOUND_PROVIDERS } from "./config/operator-config.mjs";

const OUTBOUND_PROVIDERS_LIST = OUTBOUND_PROVIDERS;
const NON_INTERACTIVE = process.argv.includes("--non-interactive");
const ALL_PROVIDERS = process.argv.includes("--all-providers");
const REPLACE = process.argv.includes("--replace");

// Readline is created lazily so importing this module (e.g. from tests
// that drive the pure collection logic) never holds stdin open.
let rl = null;
function getRl() {
  if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}

// Prompt hints are kept here so the interactive CLI and the pure
// collection driver agree on every key's role.
const SECRET_HINTS = {
  CLOUDFLARE_API_TOKEN: "operator-local; control-plane provisioning/reconcile",
  RESEND_SETUP_API_KEY: "operator-local; Resend management (Full Access)",
  RESEND_API_KEY: "runtime sending",
  RESEND_WEBHOOK_SECRET: "real whsec_... from Resend, or leave empty for provider:set reconcile",
  BREVO_API_KEY: "runtime sending; also management unless overridden",
  BREVO_SETUP_API_KEY: "optional advanced isolation override; empty = use BREVO_API_KEY",
  CLOUDFLARE_ROUTING_READ_TOKEN: "Worker runtime, routing sync only",
  AUTH_PEPPER: "runtime; do not lose",
  ADMIN_BOOTSTRAP_TOKEN: "runtime transient; removed after first sign-in",
};

function generateSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

// Pure decision: whether the wizard re-asks a key or keeps the stored
// value. Only a missing value, or an explicit --replace, re-prompts.
export function credentialAction(name, credentials, { replace = false } = {}) {
  if (!credentials[name]) return "ask";
  if (replace) return "ask";
  return "keep";
}

// Pure ordering of the secrets configure collects for a config. In
// production mode CLOUDFLARE_API_TOKEN is ALWAYS collected: it is the
// Cloudflare deployment/operator control plane, independent of the
// outbound provider (resend/brevo/cloudflare/none).
export function secretCollectionOrder({ mode, outbound_provider: provider, allProviders = false }) {
  const order = [];
  if (mode === "production") order.push("CLOUDFLARE_API_TOKEN");
  const wants = (name) => allProviders || provider === name;
  if (wants("resend")) order.push("RESEND_SETUP_API_KEY", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET");
  if (wants("brevo")) order.push("BREVO_API_KEY", "BREVO_SETUP_API_KEY");
  order.push("CLOUDFLARE_ROUTING_READ_TOKEN", "AUTH_PEPPER", "ADMIN_BOOTSTRAP_TOKEN");
  return order;
}

// Injectable credential-collection driver shared by the interactive CLI
// and the tests. `prompt(name)` returns the entered value (or ""). An
// already-stored value is kept WITHOUT prompting unless `replace` is set;
// when a replace prompt comes back empty the stored value is also kept.
export async function collectSecrets({ config, credentials, prompt, replace = false, allProviders = false }) {
  for (const name of secretCollectionOrder({ ...config, allProviders })) {
    const action = credentialAction(name, credentials, { replace });
    if (action === "keep") {
      console.log(`${name}: PRESENT — keeping existing`);
      continue;
    }
    const value = await prompt(name);
    if (value) credentials[name] = value;
    else if (credentials[name]) console.log(`${name}: PRESENT — keeping existing`);
  }
}

// Persistent non-TTY stdin reader. A single 'data'/'end' listener keeps a
// module-level buffer and resolves one line per pending question, so a
// whole stdin buffer arriving in one chunk is never lost between prompts
// and a pre-closed pipe never leaves a pending read unsettled.
const nonTtyState = { buffer: "", pending: [], ended: false, started: false };

function ensureNonTtyReader() {
  if (nonTtyState.started) return;
  nonTtyState.started = true;
  process.stdin.on("data", (chunk) => {
    nonTtyState.buffer += chunk.toString("utf8");
    flushAnswers();
  });
  process.stdin.on("end", () => {
    nonTtyState.ended = true;
    flushAnswers();
  });
  process.stdin.resume();
}

function flushAnswers() {
  while (nonTtyState.pending.length > 0) {
    const idx = nonTtyState.buffer.indexOf("\n");
    const resolve = nonTtyState.pending[0];
    if (idx === -1) {
      if (nonTtyState.ended) {
        nonTtyState.pending.shift();
        const rest = nonTtyState.buffer;
        nonTtyState.buffer = "";
        resolve(rest.replace(/\r$/, ""));
      }
      break;
    }
    nonTtyState.pending.shift();
    const line = nonTtyState.buffer.slice(0, idx).replace(/\r$/, "");
    nonTtyState.buffer = nonTtyState.buffer.slice(idx + 1);
    resolve(line);
  }
}

// One question. On a non-TTY stdin (CI, pipes, tests) reads a line directly
// through the persistent reader; on a TTY delegates to the lazy readline
// interface.
function readAnswer(question) {
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      ensureNonTtyReader();
      nonTtyState.pending.push(resolve);
      flushAnswers();
      return;
    }
    getRl().question(question).then(resolve).catch(reject);
  });
}

// Phase 18: hidden secret prompt. Characters are not echoed (raw TTY);
// Ctrl+C exits safely; Enter completes. On a non-TTY stdin falls back to
// readAnswer so tests and scripts can drive it.
function secretPrompt(question) {
  if (!process.stdin.isTTY) return readAnswer(question);
  return new Promise((resolve) => {
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

// Interactive secret collection through the shared injectable driver.
// The prompt text mirrors the original per-key prompt wording so CLI
// behavior is unchanged.
async function collectInteractiveSecrets(config, credentials) {
  await collectSecrets({
    config,
    credentials,
    replace: REPLACE,
    allProviders: ALL_PROVIDERS,
    prompt: async (name) => {
      const hint = SECRET_HINTS[name] || "";
      const isOptional = name === "BREVO_SETUP_API_KEY";
      const suffix = isOptional ? "; leave empty to skip" : "";
      const replaceSuffix = REPLACE && credentials[name] ? "; replace existing" : "";
      return secretPrompt(`${name} (${hint}${suffix}${replaceSuffix}; hidden input): `);
    },
  });
  if (config.outbound_provider === "brevo" && !credentials.BREVO_WEBHOOK_TOKEN) {
    credentials.BREVO_WEBHOOK_TOKEN = generateSecret(32);
    console.log("BREVO_WEBHOOK_TOKEN: generated, stored (Bearer auth for the delivery webhook)");
  }
}

// Phase 20: non-interactive configuration from environment +
// MAILBOX_CREDENTIALS_FILE / MAILBOX_CONFIG_FILE. Fails listing the missing
// field names without printing any value.
async function main() {
  const operator = loadOperatorConfig({ env: process.env });
  const credentials = loadCredentials({ env: process.env });

  if (NON_INTERACTIVE) {
    const config = canonicalOperatorConfig(operator);
    config.mode = config.mode || "production";
    const provider = config.outbound_provider || "none";
    const wanted = ["worker_name", "mail_domain", "admin_email", "app_origin", "cloudflare_zone_id", "cloudflare_account_id"];
    if (config.mode === "production") {
      const missingConfig = wanted.filter((key) => !config[key]);
      if (missingConfig.length > 0) {
        console.error(`configure: missing required non-secret fields (from MAILBOX_CONFIG_FILE/env): ${missingConfig.join(", ")}`);
        process.exit(2);
      }
    }
    const missingSecrets = [];
    if (credentials.AUTH_PEPPER === undefined) missingSecrets.push("AUTH_PEPPER");
    if (provider === "resend" && !credentials.RESEND_API_KEY) missingSecrets.push("RESEND_API_KEY");
    if (provider === "brevo" && !credentials.BREVO_API_KEY) missingSecrets.push("BREVO_API_KEY");
    if (missingSecrets.length > 0) {
      console.error(`configure: missing required credentials (from MAILBOX_CREDENTIALS_FILE/env): ${missingSecrets.join(", ")}`);
      process.exit(2);
    }
    console.log(`configure: non-interactive mode; using ${Object.keys(credentials).filter((k) => credentials[k]).length} credential entries and ${config.mode || "production"} config.`);
    return;
  }

  const config = { mode: "production", outbound_provider: "none", ...canonicalOperatorConfig(operator) };

  const mode = (await readAnswer(`Deployment mode [production]: `)).trim();
  if (mode) config.mode = mode;
  if (config.mode !== "production" && config.mode !== "dev") {
    console.error("configure: mode must be production or dev.");
    process.exit(2);
  }

  const askOrKeep = async (question, key) => {
    const current = config[key];
    const answer = (await readAnswer(`${question}${current ? ` [${current}]` : ""}: `)).trim();
    if (answer) config[key] = answer;
  };

  await askOrKeep("Worker name", "worker_name");
  await askOrKeep("Mail domain", "mail_domain");
  await askOrKeep("Administrator email", "admin_email");
  await askOrKeep("APP_ORIGIN (https://...)", "app_origin");
  await askOrKeep("Cloudflare Account ID (32 hex)", "cloudflare_account_id");
  await askOrKeep("Cloudflare Zone ID (32 hex)", "cloudflare_zone_id");

  const provider = (await readAnswer(`Outbound provider (${OUTBOUND_PROVIDERS_LIST.join(" / ")}) [${config.outbound_provider || "none"}]: `)).trim().toLowerCase();
  if (provider && OUTBOUND_PROVIDERS_LIST.includes(provider)) config.outbound_provider = provider;

  const validation = validateOperatorConfig(config);
  if (!validation.ok) {
    console.error(`configure: ${validation.errors.join("; ")}`);
    process.exit(2);
  }

  // Phase 23: per-role collection through the shared injectable driver.
  // Operator-local keys never enter the Worker.
  await collectInteractiveSecrets(config, credentials);

  writeCredentialsFile(credentials);
  const canonical = canonicalOperatorConfig(config);
  const { writeOperatorConfig } = await import("./config/operator-state.mjs");
  writeOperatorConfig(canonical);
  const finalProvider = String(canonical.outbound_provider || "none");
  const providerLabel = { none: "none", resend: "Resend", brevo: "Brevo", cloudflare: "Cloudflare" }[finalProvider] || finalProvider;
  const capReady = (name) => (credentials[name] ? "ready" : "not configured");
  const sendingCap = {
    none: "n/a (receive-only)",
    resend: capReady("RESEND_API_KEY"),
    brevo: capReady("BREVO_API_KEY"),
    cloudflare: "ready (EMAIL binding)",
  }[finalProvider];
  const eventsCap = {
    none: "n/a (receive-only)",
    resend: capReady("RESEND_WEBHOOK_SECRET"),
    brevo: capReady("BREVO_WEBHOOK_TOKEN"),
    cloudflare: "ready (queue events)",
  }[finalProvider];
  const mgmtCap = {
    none: "n/a",
    resend: capReady("RESEND_SETUP_API_KEY"),
    brevo: capReady("BREVO_SETUP_API_KEY") === "ready" || capReady("BREVO_API_KEY") === "ready" ? "ready" : "not configured",
    cloudflare: capReady("CLOUDFLARE_API_TOKEN"),
  }[finalProvider];
  console.log("Operator configuration: stored");
  console.log("Credentials: stored (0600)");
  console.log(`Cloudflare operator auth: ${capReady("CLOUDFLARE_API_TOKEN")}`);
  console.log(`Outbound provider: ${providerLabel}`);
  console.log(`Sending capability: ${sendingCap}`);
  console.log(`Delivery events: ${eventsCap}`);
  console.log(`Management/reconcile: ${mgmtCap}`);
  console.log("configure: credentials are entered once on your machine and never sent to the MailGable maintainers.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
  if (rl) getRl().close();
}