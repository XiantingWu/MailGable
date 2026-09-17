#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { loadCredentials, OPERATOR_LOCAL_CREDENTIALS, PROVIDER_RUNTIME_SECRETS } from "./config/credentials.mjs";
import { loadOperatorConfig } from "./config/operator-config.mjs";
import { currentGitSha } from "./git-state.mjs";
import { runWrangler, runCaptureWrangler, runInheritWrangler } from "./operator-runner.mjs";
import {
  writeSetupState,
  writeGeneratedConfig,
  loadSetupState,
  validateOperatorState,
  generatedConfigHash,
  OPERATOR_STATE_SCHEMA_VERSION,
  OperatorStateError,
} from "./config/operator-state.mjs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  buildGeneratedConfig,
  buildSecretPlan,
  buildSetupPlan,
  classifyD1State,
  classifyR2State,
  configHash,
  configInvariants,
  isKnownMailboxSchema,
  parseSetupArgs,
  r2Sentinel,
  strictOrigin,
  validateMode,
  validateProductionInputs,
} from "./setup-core.mjs";

const ROOT = process.cwd();
const TEMPLATE = path.join(ROOT, "wrangler.jsonc");
const GENERATED = path.join(ROOT, "wrangler.deploy.jsonc");
const STATE_FILE = path.join(ROOT, ".setup-state.json");
const R2_SENTINEL_KEY = "_mailbox/install.json";

function fail(code, message) {
  console.error(`setup: [${code}] ${message}`);
  process.exit(1);
}

// Local runner for NON-Wrangler commands only (git rev-parse HEAD). Every
// Cloudflare-authenticated Wrangler invocation below goes through
// runCaptureWrangler / runInheritWrangler / runWrangler so the central
// credential store is always injected.
function runLocalCapture(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return { ok: false, status: result.status, stderr: (result.stderr || "").trim() };
  }
  return { ok: true, stdout: (result.stdout || "").trim() };
}

function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function parseTemplate() {
  let raw;
  try {
    raw = readFileSync(TEMPLATE, "utf8");
  } catch {
    fail("template_missing", `wrangler template missing: ${TEMPLATE}`);
  }
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
  try {
    return JSON.parse(stripped);
  } catch {
    fail("template_invalid", "wrangler.jsonc is not valid JSON after comment stripping.");
  }
}

function loadArgs() {
  const args = parseSetupArgs(process.argv.slice(2));
  const modeCheck = validateMode(args.mode);
  if (!modeCheck.ok) fail("invalid_mode", "--mode must be 'dev' or 'production'.");
  const operator = loadOperatorConfig();
  if (args.mode === "production") {
    args.workerName ||= operator.worker_name || "";
    args.mailDomain ||= operator.mail_domain || "";
    args.adminEmail ||= operator.admin_email || "";
    args.appOrigin ||= operator.app_origin || "";
    args.zoneId ||= operator.cloudflare_zone_id || "";
    args.accountId ||= operator.cloudflare_account_id || "";
    args.outboundProvider = operator.outbound_provider || "none";
  }
  return args;
}

function preflight(args) {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor !== 22) {
    fail("runtime_unsupported", `canonical runtime is Node 22 (found ${process.versions.node}); use nvm use 22.`);
  }
  const template = parseTemplate();
  if (args.mode === "production") {
    const validation = validateProductionInputs(args);
    if (!validation.ok) {
      fail(validation.code, `production input invalid (${validation.detail || ""}). No resource was touched.`);
    }
  }
  return template;
}

function writeState(plan, config) {
  const rcSha = runLocalCapture("git", ["rev-parse", "HEAD"]).stdout?.trim?.() || "";
  writeSetupState({
    schema_version: OPERATOR_STATE_SCHEMA_VERSION,
    rc_sha: rcSha,
    mode: plan.mode,
    worker_name: plan.workerName,
    d1_name: plan.d1Name,
    d1_database_id: plan.databaseId,
    r2_name: plan.r2Name,
    mail_domain: plan.mailDomain,
    cloudflare_zone_id: plan.zoneId,
    cloudflare_account_id: plan.accountId,
    outbound_provider: plan.outboundProvider,
    config_hash: generatedConfigHash(config),
  });
}

function readState() {
  return loadSetupState();
}

function assertStateMatches(rcSha) {
  const operatorConfig = loadOperatorConfig();
  const setupState = readState();
  const generatedConfig = readJsonFile(GENERATED, null);
  try {
    validateOperatorState({ operatorConfig, setupState, generatedConfig, currentSha: rcSha });
  } catch (error) {
    if (error instanceof OperatorStateError) {
      fail(error.code, error.detail || "operator state validation failed.");
    }
    throw error;
  }
}

async function listD1() {
  const result = await runCaptureWrangler(["d1", "list", "--json", "--config", TEMPLATE]);
  if (!result.ok) return { ok: false, code: "d1_auth_or_api_error", stderr: result.stderr.slice(0, 200) };
  try {
    return { ok: true, listing: JSON.parse(result.stdout || "[]") };
  } catch {
    return { ok: false, code: "d1_list_parse_error" };
  }
}

async function listR2() {
  const result = await runCaptureWrangler(["r2", "bucket", "list", "--json", "--config", TEMPLATE]);
  if (!result.ok) return { ok: false, code: "r2_auth_or_api_error", stderr: result.stderr.slice(0, 200) };
  try {
    return { ok: true, listing: JSON.parse(result.stdout || "[]") };
  } catch {
    return { ok: false, code: "r2_list_parse_error" };
  }
}

async function d1Tables(databaseId) {
  const result = await runCaptureWrangler(["d1", "execute", "DB", `--database-id=${databaseId}`, "--remote", "--json",
    "--command", "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"]);
  if (!result.ok) return { ok: false, code: "d1_schema_query_error" };
  try {
    const rows = JSON.parse(result.stdout || "[]").flatMap((entry) => entry.results || []);
    return { ok: true, tables: rows };
  } catch {
    return { ok: false, code: "d1_schema_parse_error" };
  }
}

async function ensureD1(plan) {
  const list = await listD1();
  if (!list.ok) fail(list.code, `cannot discover D1 databases (${list.stderr || "unknown"}) — no mutation performed.`);
  const state = classifyD1State(list.listing, plan.d1Name);
  if (state.kind === "missing") {
    const created = await runCaptureWrangler(["d1", "create", plan.d1Name, "--json", "--config", TEMPLATE]);
    if (!created.ok) fail("d1_create_failed", "D1 creation failed.");
    try {
      const parsed = JSON.parse(created.stdout);
      const id = String(parsed.uuid || parsed.id || "");
      if (!id) fail("d1_create_no_id", "D1 creation returned no id.");
      console.log(`setup: created D1 '${plan.d1Name}'.`);
      return id;
    } catch {
      fail("d1_create_parse_error", "D1 creation returned invalid output.");
    }
  }
  const schema = await d1Tables(state.id);
  if (!schema.ok) fail(schema.code, "cannot read the existing D1 schema — no migration performed.");
  const known = isKnownMailboxSchema(schema.tables);
  if (!known.ok) {
    fail("existing_resource_not_mailbox", `D1 '${plan.d1Name}' contains unknown tables (${known.unknown.join(", ")}) and will not be adopted.`);
  }
  console.log(`setup: reused D1 '${plan.d1Name}' (${known.empty ? "empty" : "known Mailbox schema"}).`);
  return state.id;
}

async function ensureR2(plan) {
  const list = await listR2();
  if (!list.ok) fail(list.code, `cannot discover R2 buckets (${list.stderr || "unknown"}) — no mutation performed.`);
  const state = classifyR2State(list.listing, plan.r2Name);
  if (state.kind === "missing") {
    if (!(await runInheritWrangler(["r2", "bucket", "create", plan.r2Name, "--config", TEMPLATE]))) {
      fail("r2_create_failed", "R2 bucket creation failed.");
    }
    if (!(await runInheritWrangler(["r2", "object", "put", plan.r2Name, R2_SENTINEL_KEY, "--file", "-", "--config", TEMPLATE]))) {
      fail("r2_sentinel_failed", "R2 bucket was created but the ownership sentinel could not be written.");
    }
    console.log(`setup: created R2 '${plan.r2Name}' with ownership sentinel.`);
    return;
  }
  const probe = await runCaptureWrangler(["r2", "object", "get", plan.r2Name, R2_SENTINEL_KEY, "--config", TEMPLATE]);
  if (!probe.ok) {
    fail("existing_bucket_not_owned", `R2 '${plan.r2Name}' has no Mailbox sentinel and will not be adopted (use --adopt-empty-resources only with an explicitly empty bucket).`);
  }
  const sentinel = JSON.parse(probe.stdout || "{}");
  if (sentinel.schema !== "mailbox-r2-v1") fail("existing_bucket_not_owned", "R2 sentinel schema mismatch.");
  console.log(`setup: reused R2 '${plan.r2Name}' (owned).`);
}

async function applyMigrations(generated) {
  if (!(await runInheritWrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", generated]))) {
    fail("migration_failed", "D1 migrations failed.");
  }
}

async function deploy(generated) {
  if (!(await runInheritWrangler(["deploy", "--config", generated]))) {
    fail("deploy_failed", "Worker deployment failed.");
  }
}

function writeSecret(name, value, generated) {
  const child = runWrangler(["secret", "put", name, "--config", generated], { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.write(value);
  child.stdin.end();
  return new Promise((resolve) => {
    child.on("close", (code) => resolve(code === 0));
  });
}

async function configureSecrets(plan, generated, forceAll = false) {
  const credentials = loadCredentials();
  const provider = plan.mode === "production" ? plan.outboundProvider : "none";
  const names = [...new Set(["AUTH_PEPPER", "ADMIN_BOOTSTRAP_TOKEN", "CLOUDFLARE_ROUTING_READ_TOKEN", ...(PROVIDER_RUNTIME_SECRETS[provider] || [])])];
  for (const name of names) {
    const value = credentials[name];
    if (!value) {
      if (forceAll && (name === "AUTH_PEPPER" || name === "ADMIN_BOOTSTRAP_TOKEN")) {
        fail("secret_missing", `${name} must be provided (npm run configure) for this deployment.`);
      }
      console.log(`${name}: absent (${name === "RESEND_API_KEY" || name === "BREVO_API_KEY" ? "receive-only for this provider?" : "routing sync will degrade gracefully"})`);
      continue;
    }
    if (OPERATOR_LOCAL_CREDENTIALS.has(name)) fail("operator_local_upload", `${name} is operator-local and must never be installed into the Worker.`);
    if (!(await writeSecret(name, value, generated))) fail("secret_put_failed", `${name} could not be configured.`);
    console.log(`${name}: configured`);
  }
}

function printManualSteps(plan) {
  const host = plan.appOriginHost;
  const provider = plan.outboundProvider;
  const providerBlock = {
    none: `Outbound: receive-only
  No outbound provider setup required.`,
    resend: `Provider: Resend
  Webhook: https://${host}/webhooks/resend
  Webhook reconciliation: run 'npm run provider:set resend' with a setup key, or configure manually (docs/providers/RESEND.md).`,
    brevo: `Provider: Brevo
  Webhook: https://${host}/webhooks/brevo
  Webhook reconciliation: run 'npm run provider:set brevo' with a setup key, or configure manually (docs/providers/BREVO.md).`,
    cloudflare: `Provider: Cloudflare Email Service
  Event queue: ${plan.workerName}-email-events
  Event subscription: run 'npm run provider:set cloudflare' (Queue Event Subscription for email.sending)
  No public provider webhook.`,
  }[provider] || "Outbound: receive-only";
  console.log(`
setup: deployment complete.
  Admin:   https://${host}/admin/mail/
  Health:  https://${host}/healthz
  ${providerBlock}

Remaining manual operations:
  1. Cloudflare dashboard -> Email -> Email Routing: enable, verify a destination.
  2. Routing rules: mailbox addresses -> Send to a Worker -> ${plan.workerName}.
  3. After first sign-in: npm run setup:remove-bootstrap
`);
}

function help() {
  console.log(`MailGable cross-platform setup
Usage:
  npm run setup                      dev mode (workers.dev on, local defaults)
  npm run setup -- --mode production \\
      --worker-name <name> --mail-domain <domain> --admin-email <admin@domain> \\
      --zone-id <32-hex> --app-origin https://mail.<domain> \\
      [--d1-name <name>] [--r2-name <name>] [--adopt-empty-resources]
  npm run setup -- --mode production --dry-run ...
  npm run setup:migrate              apply migrations only (uses generated config, RC-bound)
  npm run setup:deploy               deploy only (uses generated config, RC-bound)
  npm run setup:remove-bootstrap     delete the one-time bootstrap secret from the PRODUCTION Worker

Options:
  --mode dev|production
  --app-origin https://<host>       production: required, strict https:// origin
  --worker-name / --mail-domain / --admin-email / --zone-id
  --d1-name / --r2-name             defaults derived from --worker-name
  --dry-run                          validate and print the plan; ZERO remote mutation
  --adopt-empty-resources            allow adopting an explicitly empty D1/R2

Safety:
  production mode performs remote mutation only after every deterministic
  validation passes; auth/API failures during discovery never become
  'create'; unknown existing resources are never adopted; secrets are
  written to the remote Worker via stdin and never logged or stored.
`);
}

async function main() {
  const args = loadArgs();
  if (args.dryRun) {
    preflight(args);
    const template = parseTemplate();
    const plan = buildSetupPlan(template, args, "(discovery)", buildSecretPlan(loadCredentials()));
  plan.outboundProvider = args.outboundProvider || "none";
  if (args.mode === "production") {
    console.log(`  MAIL_DOMAIN:         ${plan.mailDomain}`);
    console.log(`  ADMIN_EMAIL:         ${plan.adminEmail}`);
    console.log(`  CLOUDFLARE_ZONE_ID:  ${plan.zoneId ? "configured" : "MISSING (would fail)"}`);
  }
    console.log(`setup: DRY RUN (mode=${plan.mode}) — no resource was created or modified.`);
    console.log(`  planned Worker name: ${plan.workerName}`);
    console.log(`  planned D1 binding:  ${plan.d1Name}`);
    console.log(`  planned R2 binding:  ${plan.r2Name}`);
    console.log(`  workers.dev enabled: ${plan.workersDev}`);
    console.log(`  APP_ORIGIN:          ${plan.mode === "production" ? plan.appOrigin : "dev auto-inferred (loopback only)"}`);
    console.log(`  required secrets:    ${plan.secrets.requiredPresent ? "present" : "MISSING (would fail)"}`);
    const provider = plan.outboundProvider === "cloudflare" ? "queue event subscription" : plan.outboundProvider === "none" ? "no outbound provider" : `${plan.outboundProvider} webhook`;
    console.log(`  remaining manual:    Email Routing, domain verification, ${provider}`);
    return;
  }

  const template = preflight(args);
  const rcSha = await currentGitSha(runLocalCapture);

  if (args.deployOnly || args.migrateOnly) {
    assertStateMatches(rcSha);
    if (!existsSync(GENERATED)) fail("generated_missing", "wrangler.deploy.jsonc is missing; run the full setup first.");
    if (args.deployOnly) await deploy(GENERATED);
    if (args.migrateOnly) await applyMigrations(GENERATED);
    return;
  }

  rmSync(GENERATED, { force: true });
  const plan = buildSetupPlan(template, args, "", buildSecretPlan(loadCredentials()));
  plan.outboundProvider = args.outboundProvider || "none";
  const databaseId = await ensureD1(plan);
  await ensureR2(plan);
  plan.databaseId = databaseId;
  const config = buildGeneratedConfig(template, plan);
  const invariants = configInvariants(config);
  if (invariants.length) fail("config_invariant", invariants.join("; "));
  writeGeneratedConfig(config);
  writeState(plan, config);
  console.log(`setup: generated ${path.basename(GENERATED)} (mode=${plan.mode}, worker=${plan.workerName}).`);

  await applyMigrations(GENERATED);
  await configureSecrets(plan, GENERATED, true);
  await deploy(GENERATED);
  printManualSteps(plan);
}

async function removeBootstrap() {
  const rcSha = await currentGitSha(runLocalCapture);
  assertStateMatches(rcSha);
  if (!existsSync(GENERATED)) fail("generated_missing", "wrangler.deploy.jsonc is missing; run the full setup first.");
  const state = readState();
  if (state?.mode !== "production") {
    fail("bootstrap_delete_dev_target", "refusing to delete ADMIN_BOOTSTRAP_TOKEN from a non-production generated config.");
  }
  if (!(await runInheritWrangler(["secret", "delete", "ADMIN_BOOTSTRAP_TOKEN", "--config", GENERATED]))) {
    fail("bootstrap_delete_failed", "could not delete ADMIN_BOOTSTRAP_TOKEN from the production Worker.");
  }
  console.log("setup: ADMIN_BOOTSTRAP_TOKEN deleted from the production Worker.");
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  help();
} else if (argv.includes("--remove-bootstrap")) {
  await removeBootstrap();
} else {
  await main();
}