#!/usr/bin/env node
// Provider management:
//
//   node scripts/provider.mjs set <resend|brevo|cloudflare|none>
//   node scripts/provider.mjs remove <resend|brevo|cloudflare> [--force]
//   node scripts/provider.mjs recover
//   node scripts/provider.mjs status
//
// set is a single-controlled-point switch (Phase 13):
//   1. validate CURRENT triple (operator config, setup state, generated)
//   2. validate current HEAD
//   3. validate target credentials
//   4. build NEXT generated config      -> wrangler.provider-next.jsonc
//   5. build NEXT operator config       -> .mailbox/config.next.json
//   6. build NEXT setup state           -> .setup-state.next.json
//   7. validate the NEXT triple
//   8. wrangler deploy --dry-run NEXT
//   9. install target secrets using the CURRENT worker config
//  10. reconcile target provider remote resources
//  11. deploy NEXT                       <- the only remote switch point
//  12. commit local NEXT files (atomic renames)
//  13. final validate of the new CURRENT triple
//
// A journal (.mailbox/provider-operation.json, no secrets) survives a
// local-write failure after a successful remote deploy; provider:recover
// repairs local metadata from the validated NEXT files.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  loadCredentials,
  providerActiveCredentials,
  setCredential,
  PROVIDER_ACTIVATION_REQUIREMENTS,
  DELIVERY_EVENT_SECRETS,
  CREDENTIAL_KEYS,
  PROVIDER_RUNTIME_SECRETS,
} from "./config/credentials.mjs";
import { runInheritWrangler, runCaptureWrangler, runWrangler } from "./operator-runner.mjs";
import { loadOperatorConfig, canonicalOperatorConfig, validateOperatorConfig } from "./config/operator-config.mjs";
import {
  buildSetupPlan,
  buildGeneratedConfig,
  parseSetupArgs,
  validateProductionInputs,
} from "./setup-core.mjs";
import { currentGitSha, OperatorStateError as GitStateError } from "./git-state.mjs";
import {
  validateOperatorState,
  loadSetupState,
  loadGeneratedConfig,
  generatedConfigHash,
  writeGeneratedConfig,
  writeSetupState,
  writeOperatorConfig,
  writeOperationJournal,
  clearOperationJournal,
  readOperationJournal,
  OPERATOR_STATE_SCHEMA_VERSION,
  OperatorStateError,
} from "./config/operator-state.mjs";
import {
  reconcileResend,
  reconcileBrevo,
  reconcileCloudflare,
  deleteResendWebhook,
  deleteBrevoWebhook,
  deleteCloudflareSubscription,
} from "./reconcile.mjs";

const COMMAND = process.argv[2] || "status";
const PROVIDER_ARG = process.argv[3] || "";
const FORCE = process.argv.includes("--force");
const ROOT = process.cwd();
const GENERATED = path.join(ROOT, "wrangler.deploy.jsonc");
const NEXT = path.join(ROOT, "wrangler.provider-next.jsonc");
const NEXT_CONFIG = path.join(ROOT, ".mailbox", "config.next.json");
const NEXT_STATE = path.join(ROOT, ".setup-state.next.json");
const TEMPLATE = path.join(ROOT, "wrangler.jsonc");
const VALID_PROVIDERS = ["none", "resend", "brevo", "cloudflare"];

function fail(code, message) {
  console.error(`provider: [${code}] ${message}`);
  process.exit(1);
}

function loadConfig() {
  return loadOperatorConfig();
}

// Local runner for NON-Wrangler commands only (git rev-parse HEAD). Every
// Cloudflare-authenticated Wrangler invocation goes through the Wrangler
// runners in operator-runner.mjs so the central credential store is always
// injected; never pass this generic runner to a Wrangler path.
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

// Phase 48: any mutation command refuses to run while a
// remote_switched journal exists.
function assertNoRecoveryPending() {
  const journal = readOperationJournal();
  if (journal && journal.phase === "remote_switched") {
    fail("operator_recovery_required", "a provider switch reached the remote deploy; run `npm run provider:recover` to repair local state.");
  }
}

// Phase 11: validate the CURRENT state before anything else.
async function validateCurrentState() {
  const currentSha = await currentGitSha(runLocalCapture);
  const operatorConfig = loadConfig();
  const setupState = loadSetupState();
  const generatedConfig = loadGeneratedConfig();
  try {
    const validated = validateOperatorState({ operatorConfig, setupState, generatedConfig, currentSha });
    return { currentSha, operatorConfig, setupState, generatedConfig, validated };
  } catch (error) {
    if (error instanceof OperatorStateError || error instanceof GitStateError) {
      fail(error.code, error.detail || "current operator state validation failed.");
    }
    throw error;
  }
}

async function writeSecret(name, value) {
  setCredential(name, value);
  const child = runWrangler(["secret", "put", name, "--config", GENERATED], { stdio: ["pipe", "inherit"] });
  child.stdin.write(value);
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) fail("secret_put_failed", `${name} could not be configured.`);
  console.log(`${name}: configured`);
}

// Phase 9 (L): secrets are always uploaded against the CURRENT active
// deployment config — adding a secret must never activate the target
// provider's bindings/OUTBOUND_PROVIDER early.
async function applySecrets(provider, credentials) {
  const runtime = providerActiveCredentials(provider, credentials);
  const secretsJson = JSON.stringify(runtime, null, 2);
  const child = runWrangler(["secret", "bulk", "--config", GENERATED], { stdio: ["pipe", "inherit"] });
  child.stdin.write(secretsJson);
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) fail("secret_apply_failed", "wrangler secret bulk failed.");
  for (const name of Object.keys(runtime)) console.log(`${name}: configured`);
  console.log(`provider: applied ${Object.keys(runtime).length} persistent secrets for ${provider}.`);
}

// Inactive-provider Worker secret minimization: after the NEXT provider is
// deployed and local state is recoverable, remove the PREVIOUS provider's
// runtime secrets (RESEND_API_KEY/RESEND_WEBHOOK_SECRET, or
// BREVO_API_KEY/BREVO_WEBHOOK_TOKEN) from the Worker so only the active
// provider's runtime secrets remain. The local central store keeps them
// for a future switch-back (re-upload, never re-enter). Common secrets
// (AUTH_PEPPER, CLOUDFLARE_ROUTING_READ_TOKEN) are never touched.
function staleRuntimeSecrets(fromProvider, toProvider) {
  const from = PROVIDER_RUNTIME_SECRETS[fromProvider] || [];
  const to = PROVIDER_RUNTIME_SECRETS[toProvider] || [];
  return from.filter((name) => !to.includes(name));
}

async function removeWorkerSecrets(names) {
  if (names.length === 0) return;
  const secrets = {};
  for (const name of names) secrets[name] = null;
  const child = runWrangler(["secret", "bulk", "--config", GENERATED], { stdio: ["pipe", "inherit"] });
  child.stdin.write(JSON.stringify(secrets));
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) throw new Error(`wrangler secret bulk failed while removing ${names.join(", ")}.`);
  for (const name of names) console.log(`${name}: removed from the Worker (inactive provider)`);
  console.log(`provider: removed ${names.length} inactive-provider Worker secret(s).`);
}

// One immutable credential snapshot per provider transaction. loadCredentials()
// is read exactly once at the start of set/remove so validation, secret
// upload, and reconcile all see the same values even if the central store
// changes mid-operation.
function buildNextPackage(current, provider, currentSha, credentials) {
  const { operatorConfig, setupState, generatedConfig } = current;
  const missing = (PROVIDER_ACTIVATION_REQUIREMENTS[provider] || []).filter((name) => !credentials[name]);
  if (missing.length > 0) {
    fail("provider_credentials_missing", `${provider} requires ${missing.join(", ")} — run \`npm run configure\` to add them.`);
  }
  const nextOperator = { ...operatorConfig, outbound_provider: provider };
  const validation = validateOperatorConfig(nextOperator);
  if (!validation.ok) fail("operator_config_invalid", validation.errors.join("; "));

  const args = {
    ...parseSetupArgs([]),
    mode: "production",
    workerName: nextOperator.worker_name || "",
    mailDomain: nextOperator.mail_domain || "",
    adminEmail: nextOperator.admin_email || "",
    zoneId: nextOperator.cloudflare_zone_id || "",
    appOrigin: nextOperator.app_origin || "",
    outboundProvider: provider,
    d1Name: nextOperator.d1_name || setupState.d1_name,
    r2Name: nextOperator.r2_name || setupState.r2_name,
    accountId: nextOperator.cloudflare_account_id || "",
  };
  const validated = validateProductionInputs(args);
  if (!validated.ok) fail(validated.code, `invalid production configuration (${validated.detail || ""})`);
  if (!setupState.d1_database_id) fail("operator_state_missing", "no D1 database id in .setup-state.json; run the full setup first.");

  const template = JSON.parse(readFileSync(TEMPLATE, "utf8"));
  const plan = buildSetupPlan(template, args, setupState.d1_database_id, {});
  const nextGenerated = buildGeneratedConfig(template, plan);
  const nextState = {
    schema_version: OPERATOR_STATE_SCHEMA_VERSION,
    rc_sha: currentSha,
    mode: "production",
    worker_name: plan.workerName,
    d1_name: plan.d1Name,
    d1_database_id: setupState.d1_database_id,
    r2_name: plan.r2Name,
    mail_domain: plan.mailDomain,
    cloudflare_zone_id: plan.zoneId,
    cloudflare_account_id: plan.accountId,
    outbound_provider: provider,
    config_hash: generatedConfigHash(nextGenerated),
  };
  // NEXT triple self-validation.
  validateOperatorState({ operatorConfig: nextOperator, setupState: nextState, generatedConfig: nextGenerated, currentSha });
  return { nextOperator, nextGenerated, nextState, plan };
}

async function setProvider() {
  const provider = PROVIDER_ARG;
  if (!VALID_PROVIDERS.includes(provider)) fail("invalid_provider", `provider must be one of ${VALID_PROVIDERS.join(", ")}`);
  assertNoRecoveryPending();
  const credentials = loadCredentials();
  const current = await validateCurrentState();
  const currentSha = current.currentSha;
  const { nextOperator, nextGenerated, nextState, plan } = buildNextPackage(current, provider, currentSha, credentials);

  // Phase 14: journal before the remote deploy.
  writeOperationJournal({
    operation: "provider_switch",
    from: current.setupState.outbound_provider || "none",
    to: provider,
    rc_sha: currentSha,
    next_config_hash: nextState.config_hash,
    phase: "prepared",
  });

  // Validate NEXT with wrangler before any remote mutation.
  writeFileSync(NEXT, JSON.stringify(nextGenerated, null, 2), "utf8");
  const dry = await runCaptureWrangler(["deploy", "--dry-run", "--config", NEXT, "--outdir", path.join(ROOT, ".wrangler-dry-run", "provider-next")]);
  if (!dry.ok) {
    rmSync(NEXT, { force: true });
    clearOperationJournal();
    fail("provider_next_config_invalid", "the NEXT provider config failed wrangler validation; nothing was changed.");
  }
  console.log(`provider: NEXT config for OUTBOUND_PROVIDER=${provider} validated (wrangler dry-run).`);

  await applySecrets(provider, credentials);
  const report = await reconcileFor(provider, plan, current.operatorConfig, credentials);
  if (report && report.status === "manual") console.log(`provider: webhook reconciliation: MANUAL REQUIRED — ${report.message}`);
  else if (report) console.log(`provider: webhook reconciliation: ${report.status.toUpperCase()} — ${report.message}`);

  // Phase 13 step 11: the ONLY remote active-provider switch point.
  if (!(await runInheritWrangler(["deploy", "--config", NEXT]))) {
    clearOperationJournal();
    fail("deploy_failed", "deploying the NEXT provider config failed; the previous provider remains active and all local files are unchanged.");
  }
  writeOperationJournal({ ...readOperationJournal(), phase: "remote_switched" });

  // Phase 13 step 12: commit local NEXT files (atomic).
  try {
    writeGeneratedConfig(nextGenerated);
    writeSetupState(nextState);
    writeOperatorConfig(nextOperator);
  } catch (error) {
    console.error(`provider: remote switch succeeded but local write failed (${error.message}). Run \`npm run provider:recover\`.`);
    process.exit(1);
  }

  // Inactive-provider Worker secret minimization: ONLY after the NEXT
  // provider is deployed and the local state is committed (recoverable) do
  // we remove the previous provider's runtime secrets. A cleanup failure
  // keeps the journal + NEXT files so provider:recover retries it; the
  // switch itself is already committed and must never be rolled back.
  const fromProvider = current.setupState.outbound_provider || "none";
  const stale = staleRuntimeSecrets(fromProvider, provider);
  try {
    await removeWorkerSecrets(stale);
  } catch (error) {
    console.error(`provider: switch committed but inactive-provider cleanup failed (${error.message}). Run \`npm run provider:recover\` to retry the cleanup.`);
    process.exit(1);
  }
  rmSync(NEXT, { force: true });
  rmSync(NEXT_CONFIG, { force: true });
  rmSync(NEXT_STATE, { force: true });
  clearOperationJournal();

  // Phase 13 step 13: final validation of the new CURRENT triple.
  try {
    validateOperatorState({ operatorConfig: nextOperator, setupState: nextState, generatedConfig: nextGenerated, currentSha });
  } catch (error) {
    fail("operator_state_inconsistent", `post-switch validation failed (${error.message}); run \`npm run provider:recover\`.`);
  }
  console.log(`provider: OUTBOUND_PROVIDER=${provider} committed (single switch point: the NEXT deploy).`);
  printCompletion(provider, plan, current.operatorConfig);
}

async function reconcileFor(provider, plan, config, credentials) {
  const appOrigin = plan.appOrigin || config.app_origin || "";
  if (!appOrigin) return null;
  if (provider === "resend") return reconcileResend({ appOrigin, credentials, writeSecret });
  if (provider === "brevo") return reconcileBrevo({ appOrigin, credentials, writeSecret });
  if (provider === "cloudflare") {
    return reconcileCloudflare({
      workerName: plan.workerName,
      mailDomain: plan.mailDomain,
      zoneId: plan.zoneId,
      runCaptureWrangler,
      runInheritWrangler,
    });
  }
  return null;
}

function printCompletion(provider, plan, config) {
  const host = plan.appOriginHost || (config.app_origin ? new URL(config.app_origin).hostname : "");
  if (provider === "none") {
    console.log("\nOutbound: receive-only\nNo outbound provider setup required.");
    return;
  }
  if (provider === "resend") {
    console.log(`\nProvider: Resend\nWebhook: https://${host}/webhooks/resend\nWebhook reconciliation: reconciled above (MANUAL REQUIRED if no setup key).`);
    return;
  }
  if (provider === "brevo") {
    console.log(`\nProvider: Brevo\nWebhook: https://${host}/webhooks/brevo\nWebhook reconciliation: reconciled above (MANUAL REQUIRED if no setup key).`);
    return;
  }
  console.log(`\nProvider: Cloudflare Email Service\nEvent queue: ${plan.workerName}-email-events\nEvent subscription: reconciled above (MANUAL REQUIRED if no zone/domain).\nNo public provider webhook.`);
}

// Phase 15: repair local metadata from the validated NEXT files after a
// remote switch. Never resends mail, never rolls back the provider.
async function recover() {
  const journal = readOperationJournal();
  if (!journal || journal.phase !== "remote_switched") {
    fail("no_recovery_needed", "no remote_switched journal found; nothing to recover.");
  }
  const currentSha = await currentGitSha(runLocalCapture);
  if (journal.rc_sha !== currentSha) {
    fail("recovery_rc_mismatch", `the journal was created at ${journal.rc_sha}; refusing to recover at ${currentSha}.`);
  }
  if (!existsSync(NEXT)) {
    fail("recovery_next_missing", `${NEXT} is missing; re-run \`npm run setup\` to regenerate, then switch providers again.`);
  }
  const nextGenerated = JSON.parse(readFileSync(NEXT, "utf8"));
  const nextOperator = { ...loadConfig(), outbound_provider: nextGenerated.vars?.OUTBOUND_PROVIDER };
  const nextState = {
    schema_version: OPERATOR_STATE_SCHEMA_VERSION,
    rc_sha: currentSha,
    mode: "production",
    worker_name: nextGenerated.name,
    d1_name: nextGenerated.d1_databases?.[0]?.database_name,
    d1_database_id: nextGenerated.d1_databases?.[0]?.database_id,
    r2_name: nextGenerated.r2_buckets?.[0]?.bucket_name,
    mail_domain: nextGenerated.vars?.MAIL_DOMAIN,
    cloudflare_zone_id: nextGenerated.vars?.CLOUDFLARE_ZONE_ID,
    // The generated config never carries the account id (it is operator
    // config, not a Worker var); recover it from the operator config so the
    // recovered triple stays self-consistent.
    cloudflare_account_id: nextOperator.cloudflare_account_id || "",
    outbound_provider: nextGenerated.vars?.OUTBOUND_PROVIDER,
    config_hash: generatedConfigHash(nextGenerated),
  };
  validateOperatorState({ operatorConfig: nextOperator, setupState: nextState, generatedConfig: nextGenerated, currentSha });
  writeGeneratedConfig(nextGenerated);
  writeSetupState(nextState);
  writeOperatorConfig(nextOperator);
  // Complete any pending inactive-provider Worker secret minimization. The
  // journal records the from/to providers; the switch is already deployed,
  // so this only removes the previous provider's runtime secrets.
  const fromProvider = journal.from || "none";
  const stale = staleRuntimeSecrets(fromProvider, nextState.outbound_provider);
  try {
    await removeWorkerSecrets(stale);
  } catch (error) {
    fail("cleanup_retry_failed", `inactive-provider cleanup still failing (${error.message}); run \`npm run provider:recover\` again.`);
  }
  rmSync(NEXT, { force: true });
  clearOperationJournal();
  console.log(`provider: recovered local state for OUTBOUND_PROVIDER=${nextState.outbound_provider}.`);
}

async function countRetryable(provider) {
  const check = await runCaptureWrangler([
    "d1", "execute", "DB", "--remote", "--config", GENERATED, "--json",
    "--command",
    `SELECT COUNT(*) AS n FROM mail_messages WHERE outbound_provider='${provider}' AND status IN ('sending','retryable_failed')`,
  ]);
  if (!check.ok) return null;
  try {
    const rows = JSON.parse(check.stdout);
    const count = rows?.[0]?.results?.[0]?.n;
    return typeof count === "number" ? count : null;
  } catch {
    return null;
  }
}

// Phase 43: remove is fully state-gated; only inactive providers may be
// removed, and their credentials/resources are deleted deliberately.
async function removeProvider() {
  const provider = PROVIDER_ARG;
  if (!["resend", "brevo", "cloudflare"].includes(provider)) fail("invalid_provider", "remove requires resend|brevo|cloudflare");
  assertNoRecoveryPending();
  const current = await validateCurrentState();
  if (current.setupState.outbound_provider === provider) {
    fail("provider_active", `switch away from ${provider} with 'provider:set' before removing its credential.`);
  }
  const count = await countRetryable(provider);
  if (count === null) {
    fail("d1_check_unavailable", "cannot verify D1 retryable rows; run from the project root with the generated config deployed, or use --force deliberately.");
  }
  if (count > 0 && !FORCE) {
    fail("retryable_messages", `D1 has ${count} ${provider} message(s) in sending/retryable_failed state; use --force only after verifying the provider records.`);
  }
  if (count === 0) console.log(`provider: D1 has no retryable ${provider} rows; removal is safe.`);
  const credentials = loadCredentials();
  const appOrigin = current.operatorConfig.app_origin || "";
  let cleanup = null;
  if (provider === "resend") cleanup = await deleteResendWebhook({ appOrigin, credentials });
  if (provider === "brevo") cleanup = await deleteBrevoWebhook({ appOrigin, credentials });
  if (provider === "cloudflare") {
    cleanup = await deleteCloudflareSubscription({
      workerName: current.operatorConfig.worker_name || "",
      mailDomain: current.operatorConfig.mail_domain || "",
      zoneId: current.operatorConfig.cloudflare_zone_id || "",
      runCaptureWrangler,
      runInheritWrangler,
    });
  }
  if (cleanup && cleanup.status === "manual") console.log(`provider: remote cleanup: MANUAL REQUIRED — ${cleanup.message}`);
  else if (cleanup) console.log(`provider: remote cleanup: ${cleanup.status.toUpperCase()} — ${cleanup.message}`);
  const names = { resend: ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"], brevo: ["BREVO_API_KEY", "BREVO_WEBHOOK_TOKEN"], cloudflare: [] }[provider];
  const secrets = {};
  for (const name of names) secrets[name] = null;
  const child = runWrangler(["secret", "bulk", "--config", GENERATED], { stdio: ["pipe", "inherit"] });
  child.stdin.write(JSON.stringify(secrets));
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) fail("secret_remove_failed", "wrangler secret bulk failed.");
  console.log(`provider: removed ${provider} runtime secrets.`);
}

async function status() {
  const config = loadConfig();
  const credentials = loadCredentials();
  const state = loadSetupState();
  console.log(`OUTBOUND_PROVIDER  ${config.outbound_provider || "none"}`);
  console.log("Capabilities:");
  console.log("  Resend:     webhook events | idempotency 24h | app retry 23h | attachments+cc/bcc+threading");
  console.log("  Brevo:      webhook events | idempotency ~30m | app retry 25m | attachments+cc/bcc, no threading headers");
  console.log("  Cloudflare: queue events | no assumed idempotency | 5 MiB max | attachments+cc/bcc+threading | Workers Paid/Beta");
  const provider = config.outbound_provider || "none";
  const sendReady = PROVIDER_ACTIVATION_REQUIREMENTS[provider] || [];
  const missingSend = sendReady.filter((name) => !credentials[name]);
  console.log(`Send: ${missingSend.length === 0 ? "CONFIGURED" : `NOT CONFIGURED (missing ${missingSend.join(", ")})`}`);
  const eventSecrets = DELIVERY_EVENT_SECRETS[provider] || [];
  const missingEvents = eventSecrets.filter((name) => !credentials[name]);
  console.log(`Delivery events: ${missingEvents.length === 0 ? "CONFIGURED" : "MANUAL REQUIRED / NOT CONFIGURED (send-only)"}`);
  console.log(`Routing sync: ${credentials.CLOUDFLARE_ROUTING_READ_TOKEN ? "CONFIGURED" : "NOT CONFIGURED (manual Email Routing)"}`);
  console.log(`Credentials: ${CREDENTIAL_KEYS.filter((k) => credentials[k]).length}/${CREDENTIAL_KEYS.length} schema keys present`);
  console.log(`Setup state: ${state ? `present (${state.worker_name || "?"} @ ${(state.rc_sha || "").slice(0, 7) || "?"}, d1=${state.d1_database_id ? "configured" : "MISSING"})` : "MISSING (.setup-state.json)"}`);
}

switch (COMMAND) {
  case "set":
    await setProvider();
    break;
  case "remove":
    await removeProvider();
    break;
  case "recover":
    await recover();
    break;
  case "status":
    await status();
    break;
  default:
    console.error("usage: node scripts/provider.mjs <set|remove|recover|status> [provider] [--force]");
    process.exit(2);
}