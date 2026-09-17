#!/usr/bin/env node
// Live-validation evidence runner. Automates the steps that do not require
// an external human mailbox, records PASS/FAIL into a sanitized report, and
// NEVER prints or stores credentials, tokens, resource IDs, or account
// identifiers. Manual evidence is recorded through the allowlisted `record`
// command — never by hand-editing the JSON.
//
// The qualified object is the immutable Git commit SHA on the single
// `main` branch; no PR number, draft state, or feature branch is bound.
//
//   EXPECTED_RELEASE_SHA=<sha> node scripts/live-validation.mjs preflight
//   node scripts/live-validation.mjs setup1
//   node scripts/live-validation.mjs setup2
//   node scripts/live-validation.mjs boundary
//   node scripts/live-validation.mjs record <step> PASS [--code <code>]
//   node scripts/live-validation.mjs finalize
//   node scripts/live-validation.mjs report
//
// EXPECTED_RC_SHA is accepted as a deprecated alias and normalized to
// EXPECTED_RELEASE_SHA.
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const STEP = process.argv[2] || "report";
const REPORT_DIR = path.join(process.cwd(), "live-validation");
const REPORT_FILE = path.join(REPORT_DIR, "evidence.json");
const EXPECTED_RELEASE_SHA = process.env.EXPECTED_RELEASE_SHA || process.env.EXPECTED_RC_SHA || "";
const ORIGIN = process.env.APP_ORIGIN || "";
const SCHEMA_VERSION = 2;

const REQUIRED_STEPS = [
  "setup1", "setup2", "boundary",
  "inbound_text", "inbound_html", "attachment", "duplicate", "threading",
  "send", "reply", "reply_all", "forward", "webhook", "idempotency",
  "receive_only", "routing_auth",
  "folder_lifecycle", "hard_delete_d1", "hard_delete_r2", "retention",
  "backup", "fresh_restore", "d1_time_travel",
];

function run(command, args, capture = false) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  return { status: result.status ?? 1, stdout: result.stdout || "" };
}

function git(args) {
  return run("git", args, true).stdout.trim();
}

async function loadReport() {
  try {
    const parsed = JSON.parse(await readFile(REPORT_FILE, "utf8"));
    if (parsed.schema_version !== SCHEMA_VERSION) {
      throw new Error(`incompatible evidence schema ${parsed.schema_version} (expected ${SCHEMA_VERSION}); start fresh evidence.`);
    }
    return parsed;
  } catch (error) {
    if (error.code !== "ENOENT") fail("evidence_schema_incompatible", error.message);
    return { schema_version: SCHEMA_VERSION, expected_release_sha: "", actual_release_sha: "", remote_main_sha: "", providers_exercised: [], mode: "production", created_at: new Date().toISOString(), steps: {} };
  }
}

async function saveReport(report) {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function fail(code, message) {
  console.error(`live-validation: [${code}] ${message}`);
  process.exit(1);
}

async function currentSnapshot() {
  const head = git(["rev-parse", "HEAD"]);
  const remote = git(["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0] || "";
  const dirty = git(["status", "--porcelain"]).length > 0;
  return { head, remote, dirty };
}

function assertReleaseBound(report, snapshot) {
  if (!EXPECTED_RELEASE_SHA) fail("expected_release_missing", "EXPECTED_RELEASE_SHA must be set to the exact commit being qualified.");
  if (snapshot.head !== EXPECTED_RELEASE_SHA) fail("evidence_release_mismatch", `HEAD ${snapshot.head} != EXPECTED ${EXPECTED_RELEASE_SHA}`);
  if (report.expected_release_sha && report.expected_release_sha !== EXPECTED_RELEASE_SHA) {
    fail("evidence_release_mismatch", `evidence was started for ${report.expected_release_sha}; do not mix commits.`);
  }
}

async function preflight() {
  const snapshot = await currentSnapshot();
  if (snapshot.dirty) fail("worktree_dirty", "working tree must be clean.");
  if (snapshot.head !== EXPECTED_RELEASE_SHA) fail("head_mismatch", `HEAD ${snapshot.head} != EXPECTED_RELEASE_SHA ${EXPECTED_RELEASE_SHA}`);
  if (snapshot.remote !== EXPECTED_RELEASE_SHA) fail("remote_mismatch", `origin/main ${snapshot.remote || "(none)"} != EXPECTED_RELEASE_SHA`);

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor !== 22) fail("runtime_unsupported", `canonical runtime is Node 22 (found ${process.versions.node}).`);
  if (!ORIGIN || !/^https:\/\//.test(ORIGIN)) fail("origin_missing", "APP_ORIGIN (https://...) is required.");
  try {
    const url = new URL(ORIGIN);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      fail("origin_invalid", "APP_ORIGIN must be a canonical https origin.");
    }
  } catch {
    fail("origin_invalid", "APP_ORIGIN must be a canonical https origin.");
  }
  const ignored = run("git", ["check-ignore", "live-validation/"], true).status === 0;
  if (!ignored) fail("evidence_not_ignored", "live-validation/ must stay gitignored.");

  const report = await loadReport();
  const reportToUse = {
    ...report,
    schema_version: SCHEMA_VERSION,
    expected_release_sha: EXPECTED_RELEASE_SHA,
    actual_release_sha: snapshot.head,
    remote_main_sha: snapshot.remote,
    mode: "production",
    created_at: report.created_at || new Date().toISOString(),
  };
  await saveReport(reportToUse);
  console.log("live-validation: preflight PASS (HEAD == EXPECTED_RELEASE_SHA == origin/main).");
}

async function requirePreflight(report) {
  const snapshot = await currentSnapshot();
  assertReleaseBound(report, snapshot);
}

async function runSetup(label, extraArgs = []) {
  const report = await loadReport();
  await requirePreflight(report);
  const result = run("node", ["scripts/setup.mjs", "--mode", "production", ...extraArgs]);
  report.steps[label] = { pass: result.status === 0, recorded_at: new Date().toISOString() };
  await saveReport(report);
  console.log(`live-validation: ${label} = ${result.status === 0 ? "PASS" : "FAIL"}`);
  if (result.status !== 0) process.exit(result.status);
}

// Provider-aware boundary checks. Only real runtime ingress is probed:
// Resend and Brevo expose HTTP webhooks; Cloudflare Email Service uses a
// Queue consumer with no HTTP endpoint, so its malformed-input rejection is
// covered by the unit contract tests (tests/provider-contract.test.mjs).
async function boundary() {
  const report = await loadReport();
  await requirePreflight(report);
  const checks = [];
  const health = await fetch(`${ORIGIN}/healthz`);
  checks.push({ check: "healthz_public_200", pass: health.status === 200 && JSON.stringify(await health.json()) === JSON.stringify({ ok: true }) });

  const resend = await fetch(`${ORIGIN}/webhooks/resend`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "svix-id": "x", "svix-timestamp": "0", "svix-signature": "v1,fake" },
    body: JSON.stringify({ type: "email.delivered" }),
  });
  checks.push({ check: "resend_unsigned_webhook_rejected", pass: resend.status >= 400 });

  const brevo = await fetch(`${ORIGIN}/webhooks/brevo`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer invalid-token" },
    body: JSON.stringify({ event: "delivered", "message-id": "m", email: "a@example.net" }),
  });
  checks.push({ check: "brevo_invalid_auth_webhook_rejected", pass: brevo.status >= 400 });

  for (const adminPath of ["/api/admin/mail/config", "/api/admin/mail/mailboxes", "/api/admin/mail/threads"]) {
    const response = await fetch(`${ORIGIN}${adminPath}`);
    checks.push({ check: `admin_401_${adminPath.split("/").at(-1)}`, pass: response.status === 401 });
  }

  const pass = checks.every((item) => item.pass);
  report.steps.boundary = { pass, checks, recorded_at: new Date().toISOString() };
  await saveReport(report);
  for (const item of checks) console.log(`  ${item.check}: ${item.pass ? "PASS" : "FAIL"}`);
  console.log(`live-validation: boundary = ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exit(1);
}

async function record() {
  const step = process.argv[3];
  const outcome = process.argv[4];
  if (!REQUIRED_STEPS.includes(step)) fail("unknown_step", `step must be one of the allowlist (${REQUIRED_STEPS.join(", ")})`);
  if (outcome !== "PASS" && outcome !== "FAIL") fail("invalid_outcome", "outcome must be PASS or FAIL.");
  const codeIndex = process.argv.indexOf("--code");
  const code = codeIndex >= 0 ? process.argv[codeIndex + 1] : "";
  if (code && !/^[a-z0-9_]{1,64}$/i.test(code)) fail("invalid_code", "--code must be a stable sanitized error code (no raw logs).");

  const report = await loadReport();
  await requirePreflight(report);
  report.steps[step] = { pass: outcome === "PASS", recorded_at: new Date().toISOString(), ...(code ? { code } : {}) };
  await saveReport(report);
  console.log(`live-validation: ${step} = ${outcome}${code ? ` (code ${code})` : ""}`);
}

async function finalize() {
  const report = await loadReport();
  const snapshot = await currentSnapshot();
  assertReleaseBound(report, snapshot);
  if (snapshot.dirty) fail("worktree_dirty", "working tree must be clean.");
  const missing = REQUIRED_STEPS.filter((step) => !report.steps[step]);
  const failed = REQUIRED_STEPS.filter((step) => report.steps[step]?.pass !== true);
  if (missing.length || failed.length) {
    console.log(`live-validation: NOT VERIFIED (${failed.length} failed, ${missing.length} not recorded).`);
    if (missing.length) console.log(`  missing: ${missing.join(", ")}`);
    if (failed.length) console.log(`  failed: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log("REAL-WORLD RELEASE VALIDATION: PASS");
}

async function report() {
  const data = await loadReport();
  const flag = (key) => (data.steps[key]?.pass === true ? "PASS" : data.steps[key]?.pass === false ? "FAIL" : "NOT RUN");
  console.log(`schema_version       ${data.schema_version}`);
  console.log(`EXPECTED_RELEASE_SHA ${data.expected_release_sha || "(unset)"}`);
  console.log(`actual_release_sha   ${data.actual_release_sha || "(none)"}`);
  console.log(`remote_main_sha      ${data.remote_main_sha || "(none)"}`);
  console.log(`providers_exercised  ${(data.providers_exercised || []).join(", ") || "(none recorded)"}`);
  for (const step of REQUIRED_STEPS) console.log(`${step.padEnd(22)} ${flag(step)}`);
  console.log(`\nEvidence file: ${REPORT_FILE} (sanitized; no secrets stored)`);
}

switch (STEP) {
  case "preflight":
    await preflight();
    break;
  case "setup1":
    await runSetup("setup1");
    break;
  case "setup2":
    await runSetup("setup2");
    break;
  case "boundary":
    await boundary();
    break;
  case "record":
    await record();
    break;
  case "finalize":
    await finalize();
    break;
  case "report":
    await report();
    break;
  default:
    console.error("usage: node scripts/live-validation.mjs <preflight|setup1|setup2|boundary|record|finalize|report>");
    process.exit(2);
}
