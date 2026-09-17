// Phase 47/48: provider:set failure paths — nothing mutates before the
// single controlled switch point, and a post-deploy local failure leaves
// a recoverable journal. Runs the real scripts/provider.mjs CLI against a
// fixture operator state.
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { OPERATOR_STATE_SCHEMA_VERSION, generatedConfigHash } from "../scripts/config/operator-state.mjs";

const ROOT = process.cwd();

function fixtureDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "provider-fail-"));
  mkdirSync(path.join(dir, ".mailbox"), { recursive: true });
  // Real git repository so currentGitSha resolves; its HEAD sha becomes the
  // state's rc_sha.
  const init = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  init(["init", "-q"]);
  init(["config", "user.email", "test@example.com"]);
  init(["config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "seed.txt"), "x");
  init(["add", "seed.txt"]);
  init(["commit", "-q", "-m", "seed"]);
  return dir;
}

function writeTriple(dir, provider) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  const workerName = "my-mailbox";
  const mailDomain = "mailgable-test.dev";
  const zoneId = "a".repeat(32);
  const generated = {
    name: workerName,
    vars: {
      MAIL_WORKER_NAME: workerName,
      MAIL_DOMAIN: mailDomain,
      CLOUDFLARE_ZONE_ID: zoneId,
      OUTBOUND_PROVIDER: provider,
    },
    d1_databases: [{ database_name: `${workerName}-db`, database_id: "11111111-2222-4333-8444-555555555555" }],
    r2_buckets: [{ bucket_name: `${workerName}-r2` }],
  };
  writeFileSync(path.join(dir, "wrangler.jsonc"), JSON.stringify({ name: workerName }), "utf8");
  writeFileSync(path.join(dir, "wrangler.deploy.jsonc"), JSON.stringify(generated, null, 2), "utf8");
  writeFileSync(path.join(dir, ".mailbox", "config.json"), JSON.stringify({
    worker_name: workerName, mail_domain: mailDomain, cloudflare_zone_id: zoneId,
    outbound_provider: provider, app_origin: `https://mail.${mailDomain}`, d1_name: `${workerName}-db`, r2_name: `${workerName}-r2`,
  }, null, 2), "utf8");
  writeFileSync(path.join(dir, ".setup-state.json"), JSON.stringify({
    schema_version: OPERATOR_STATE_SCHEMA_VERSION,
    rc_sha: head, mode: "production", worker_name: workerName,
    d1_name: `${workerName}-db`, d1_database_id: "11111111-2222-4333-8444-555555555555",
    r2_name: `${workerName}-r2`, mail_domain: mailDomain, cloudflare_zone_id: zoneId,
    outbound_provider: provider, config_hash: generatedConfigHash(generated),
  }, null, 2), "utf8");
  writeFileSync(path.join(dir, ".mailbox", "credentials.env"),
    'AUTH_PEPPER="p"\nRESEND_API_KEY="re_dummy_fixture_key"\n', "utf8");
  return { generated };
}

function runProvider(dir, args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "provider.mjs"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, HOME: dir },
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function snapshots(dir) {
  const files = [".mailbox/config.json", ".setup-state.json", "wrangler.deploy.jsonc"];
  const snap = {};
  for (const file of files) {
    try {
      snap[file] = readFileSync(path.join(dir, file), "utf8");
    } catch {
      snap[file] = null; // file absent (e.g. intentionally removed)
    }
  }
  return snap;
}

test("Phase 47: missing setup state blocks provider:set with zero mutation", () => {
  const dir = fixtureDir();
  try {
    writeTriple(dir, "resend");
    const before = snapshots(dir);
    rmSync(path.join(dir, ".setup-state.json"));
    const result = runProvider(dir, ["set", "brevo"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /operator_state_missing/);
    const after = snapshots(dir);
    assert.equal(after[".setup-state.json"], null, "state file stays absent");
    assert.equal(after[".mailbox/config.json"], before[".mailbox/config.json"], "operator config unchanged");
    assert.equal(after["wrangler.deploy.jsonc"], before["wrangler.deploy.jsonc"], "generated config unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 47: missing target credentials block the switch", () => {
  const dir = fixtureDir();
  try {
    writeTriple(dir, "resend");
    const before = snapshots(dir);
    const result = runProvider(dir, ["set", "brevo"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /provider_credentials_missing/);
    assert.deepEqual(snapshots(dir), before, "all three files unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 47: tampered generated config blocks provider:set", () => {
  const dir = fixtureDir();
  try {
    writeTriple(dir, "resend");
    const generatedPath = path.join(dir, "wrangler.deploy.jsonc");
    const generated = JSON.parse(readFileSync(generatedPath, "utf8"));
    generated.vars.ADMIN_EMAIL = "tampered@example.com";
    writeFileSync(generatedPath, JSON.stringify(generated, null, 2), "utf8");
    const before = snapshots(dir);
    const result = runProvider(dir, ["set", "resend"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /operator_state_config_hash_mismatch/);
    assert.deepEqual(snapshots(dir), before, "all three files unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 48: remote_switched journal blocks every mutation until recover", () => {
  const dir = fixtureDir();
  try {
    writeTriple(dir, "resend");
    writeFileSync(path.join(dir, ".mailbox", "provider-operation.json"), JSON.stringify({
      operation: "provider_switch", from: "resend", to: "brevo",
      rc_sha: spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim(),
      next_config_hash: "f".repeat(64), phase: "remote_switched",
    }), "utf8");
    const before = snapshots(dir);
    const setResult = runProvider(dir, ["set", "resend"]);
    assert.notEqual(setResult.status, 0);
    assert.match(setResult.stdout + setResult.stderr, /operator_recovery_required/);
    const removeResult = runProvider(dir, ["remove", "brevo"]);
    assert.notEqual(removeResult.status, 0);
    assert.match(removeResult.stdout + removeResult.stderr, /operator_recovery_required/);
    assert.deepEqual(snapshots(dir), before, "nothing mutated while recovery is pending");
    // recover without NEXT files fails closed too
    const recoverResult = runProvider(dir, ["recover"]);
    assert.notEqual(recoverResult.status, 0);
    assert.match(recoverResult.stdout + recoverResult.stderr, /recovery_|recover/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});