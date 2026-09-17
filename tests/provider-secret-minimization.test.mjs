// INACTIVE-PROVIDER WORKER SECRET MINIMIZATION (Phase 52+).
//
// After a successful provider switch (resend<->brevo<->cloudflare/none),
// the PREVIOUS provider's runtime secrets are deleted from the Worker so
// only the ACTIVE provider's runtime secrets remain. The local central
// store keeps the inactive keys for a future switch-back (re-upload, never
// re-enter). Common secrets (AUTH_PEPPER, CLOUDFLARE_ROUTING_READ_TOKEN)
// are never touched. Deletion happens ONLY after the NEXT provider is
// deployed and local state is committed/recoverable; a cleanup failure
// keeps the journal + NEXT files so provider:recover retries cleanup.
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { OPERATOR_STATE_SCHEMA_VERSION, generatedConfigHash } from "../scripts/config/operator-state.mjs";

const ROOT = process.cwd();
const ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
const ZONE_ID = "a".repeat(32);
const WORKER_NAME = "minimize-mailbox";
const MAIL_DOMAIN = "minimize-test.dev";
const D1_ID = "11111111-2222-4333-8444-555555555555";

const FAKE_NPX = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const join = args.join(" ");
if (process.env.FAKE_NPX_LOG) fs.appendFileSync(process.env.FAKE_NPX_LOG, JSON.stringify({ args }) + "\\n");
if (args.includes("secret")) {
  const input = fs.readFileSync(0, "utf8");
  if (process.env.FAKE_BULK_LOG && args.includes("bulk")) {
    try {
      const parsed = JSON.parse(input);
      fs.appendFileSync(process.env.FAKE_BULK_LOG, JSON.stringify(parsed) + "\\n");
      const isDeletion = Object.values(parsed).some((v) => v === null);
      if (isDeletion && process.env.FAKE_FAIL_DELETE === "1") process.exit(1);
    } catch {}
  }
}
if (/^wrangler queues list/.test(join) || /^wrangler queues subscription list/.test(join)
  || /^wrangler r2 bucket list/.test(join) || /^wrangler d1 list/.test(join)) {
  process.stdout.write("[]\\n");
  process.exit(0);
}
if (/^wrangler d1 create/.test(join)) {
  process.stdout.write(JSON.stringify({ uuid: "${D1_ID}" }) + "\\n");
  process.exit(0);
}
if (/^wrangler d1 execute/.test(join)) {
  process.stdout.write('[{"results":[{"n":0}]}]\\n');
  process.exit(0);
}
process.exit(0);
`;

// Fetch mock for webhook reconciliation inside provider:set.
const FETCH_MOCK = `globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  const method = options.method || "GET";
  if (u.includes("api.resend.com")) {
    if (method === "POST") return { ok: true, status: 200, json: async () => ({ id: "wh_min", status: "enabled", events: [], signing_secret: "whsec_min" }) };
    if (u.endsWith("/webhooks")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    return { ok: true, status: 200, json: async () => ({ id: "wh_min", signing_secret: "whsec_min" }) };
  }
  if (u.includes("api.brevo.com")) {
    if (method === "POST") return { ok: true, status: 201, json: async () => ({ id: "bw_min" }) };
    return { ok: true, status: 200, json: async () => ({ webhooks: [] }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
`;

function fixtureDir(provider) {
  const dir = mkdtempSync(path.join(tmpdir(), "minimize-"));
  mkdirSync(path.join(dir, ".mailbox"), { recursive: true });
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "seed.txt"), "x");
  git(["add", "seed.txt"]);
  git(["commit", "-q", "-m", "seed"]);
  const npxPath = path.join(dir, "bin", "npx");
  writeFileSync(npxPath, FAKE_NPX, "utf8");
  chmodSync(npxPath, 0o755);
  writeFileSync(path.join(dir, "wrangler.jsonc"), JSON.stringify({
    name: WORKER_NAME,
    main: "src/index.ts",
    compatibility_date: "2025-01-01",
    d1_databases: [{ binding: "DB", database_name: `${WORKER_NAME}-db`, database_id: D1_ID, migrations_dir: "migrations" }],
    r2_buckets: [{ binding: "MAIL_R2", bucket_name: `${WORKER_NAME}-r2` }],
    vars: {},
  }), "utf8");
  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  const generated = {
    name: WORKER_NAME,
    vars: { MAIL_WORKER_NAME: WORKER_NAME, MAIL_DOMAIN: MAIL_DOMAIN, CLOUDFLARE_ZONE_ID: ZONE_ID, OUTBOUND_PROVIDER: provider },
    d1_databases: [{ database_name: `${WORKER_NAME}-db`, database_id: D1_ID }],
    r2_buckets: [{ bucket_name: `${WORKER_NAME}-r2` }],
  };
  writeFileSync(path.join(dir, "wrangler.deploy.jsonc"), JSON.stringify(generated, null, 2), "utf8");
  writeFileSync(path.join(dir, ".mailbox", "config.json"), JSON.stringify({
    mode: "production",
    worker_name: WORKER_NAME,
    mail_domain: MAIL_DOMAIN,
    admin_email: `admin@${MAIL_DOMAIN}`,
    app_origin: `https://mail.${MAIL_DOMAIN}`,
    cloudflare_zone_id: ZONE_ID,
    cloudflare_account_id: ACCOUNT_ID,
    outbound_provider: provider,
    d1_name: `${WORKER_NAME}-db`,
    r2_name: `${WORKER_NAME}-r2`,
  }, null, 2), "utf8");
  writeFileSync(path.join(dir, ".setup-state.json"), JSON.stringify({
    schema_version: OPERATOR_STATE_SCHEMA_VERSION,
    rc_sha: head,
    mode: "production",
    worker_name: WORKER_NAME,
    d1_name: `${WORKER_NAME}-db`,
    d1_database_id: D1_ID,
    r2_name: `${WORKER_NAME}-r2`,
    mail_domain: MAIL_DOMAIN,
    cloudflare_zone_id: ZONE_ID,
    cloudflare_account_id: ACCOUNT_ID,
    outbound_provider: provider,
    config_hash: generatedConfigHash(generated),
  }, null, 2), "utf8");
  writeFileSync(path.join(dir, ".mailbox", "credentials.env"),
    'AUTH_PEPPER="p"\nCLOUDFLARE_ROUTING_READ_TOKEN="rrt"\n'
    + 'RESEND_API_KEY="re_1"\nRESEND_WEBHOOK_SECRET="whsec_1"\n'
    + 'BREVO_API_KEY="xkeysib_1"\nBREVO_WEBHOOK_TOKEN="wh_token_1"\n', "utf8");
  const fetchMockFile = path.join(dir, "fetch-mock.cjs");
  writeFileSync(fetchMockFile, FETCH_MOCK, "utf8");
  return { dir, fetchMockFile };
}

function run(dir, args, extraEnv) {
  const env = { ...process.env, HOME: dir, PATH: `${path.join(dir, "bin")}:${process.env.PATH || ""}` };
  delete env.MAILBOX_CREDENTIALS_FILE;
  delete env.MAILBOX_CONFIG_FILE;
  env.NODE_OPTIONS = `--require=${dir}/fetch-mock.cjs`;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [path.join(ROOT, "scripts", "provider.mjs"), ...args], {
    cwd: dir, encoding: "utf8", env, timeout: 90_000,
  });
}

function bulkCalls(bulkLog) {
  if (!existsSync(bulkLog)) return [];
  return readFileSync(bulkLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("switch resend -> brevo deletes the inactive Resend Worker secrets, keeping the local store", () => {
  const { dir } = fixtureDir("resend");
  const bulkLog = path.join(dir, "bulk.log");
  try {
    const result = run(dir, ["set", "brevo"], { FAKE_NPX_LOG: path.join(dir, "npx.log"), FAKE_BULK_LOG: bulkLog });
    assert.equal(result.status, 0, `switch failed:\n${result.stdout}\n${result.stderr}`);
    const calls = bulkCalls(bulkLog);
    const deletion = calls[calls.length - 1];
    assert.ok(deletion, "a secret bulk call must exist");
    assert.equal(deletion.RESEND_API_KEY, null, "inactive RESEND_API_KEY removed from the Worker");
    assert.equal(deletion.RESEND_WEBHOOK_SECRET, null, "inactive RESEND_WEBHOOK_SECRET removed from the Worker");
    assert.equal(deletion.BREVO_API_KEY, undefined, "active provider secrets are never nulled");
    assert.equal(deletion.AUTH_PEPPER, undefined, "common secrets are never touched");
    assert.equal(deletion.CLOUDFLARE_ROUTING_READ_TOKEN, undefined, "routing token never touched");
    const creds = readFileSync(path.join(dir, ".mailbox", "credentials.env"), "utf8");
    assert.ok(creds.includes("RESEND_API_KEY"), "local central store keeps the inactive Resend key");
    assert.ok(creds.includes("RESEND_WEBHOOK_SECRET"), "local central store keeps the inactive Resend webhook secret");
    const config = JSON.parse(readFileSync(path.join(dir, ".mailbox", "config.json"), "utf8"));
    assert.equal(config.outbound_provider, "brevo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("switch brevo -> resend deletes the inactive Brevo Worker secrets", () => {
  const { dir } = fixtureDir("brevo");
  const bulkLog = path.join(dir, "bulk.log");
  try {
    const result = run(dir, ["set", "resend"], { FAKE_NPX_LOG: path.join(dir, "npx.log"), FAKE_BULK_LOG: bulkLog });
    assert.equal(result.status, 0, `switch failed:\n${result.stdout}\n${result.stderr}`);
    const deletion = bulkCalls(bulkLog).pop();
    assert.equal(deletion.BREVO_API_KEY, null, "inactive BREVO_API_KEY removed");
    assert.equal(deletion.BREVO_WEBHOOK_TOKEN, null, "inactive BREVO_WEBHOOK_TOKEN removed");
    assert.equal(deletion.RESEND_API_KEY, undefined, "active Resend key never nulled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("switch resend -> cloudflare deletes all inactive Resend runtime/event secrets", () => {
  const { dir } = fixtureDir("resend");
  const bulkLog = path.join(dir, "bulk.log");
  try {
    const result = run(dir, ["set", "cloudflare"], { FAKE_NPX_LOG: path.join(dir, "npx.log"), FAKE_BULK_LOG: bulkLog });
    assert.equal(result.status, 0, `switch failed:\n${result.stdout}\n${result.stderr}`);
    const deletion = bulkCalls(bulkLog).pop();
    assert.equal(deletion.RESEND_API_KEY, null);
    assert.equal(deletion.RESEND_WEBHOOK_SECRET, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("switch to 'none' also clears the inactive provider's Worker secrets", () => {
  const { dir } = fixtureDir("brevo");
  const bulkLog = path.join(dir, "bulk.log");
  try {
    const result = run(dir, ["set", "none"], { FAKE_NPX_LOG: path.join(dir, "npx.log"), FAKE_BULK_LOG: bulkLog });
    assert.equal(result.status, 0, `switch failed:\n${result.stdout}\n${result.stderr}`);
    const deletion = bulkCalls(bulkLog).pop();
    assert.equal(deletion.BREVO_API_KEY, null);
    assert.equal(deletion.BREVO_WEBHOOK_TOKEN, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup failure keeps the journal + NEXT files and provider:recover retries the cleanup", () => {
  const { dir } = fixtureDir("resend");
  const bulkLog = path.join(dir, "bulk.log");
  const journal = path.join(dir, ".mailbox", "provider-operation.json");
  try {
    const failed = run(dir, ["set", "brevo"], { FAKE_NPX_LOG: path.join(dir, "npx.log"), FAKE_BULK_LOG: bulkLog, FAKE_FAIL_DELETE: "1" });
    assert.notEqual(failed.status, 0, "cleanup failure must fail the command");
    assert.match(failed.stdout + failed.stderr, /provider:recover/, "hints provider:recover");
    assert.equal(existsSync(journal), true, "journal kept so recovery can complete cleanup");
    assert.equal(existsSync(path.join(dir, "wrangler.provider-next.jsonc")), true, "NEXT files kept for recovery");
    // The switch itself was committed locally.
    const config = JSON.parse(readFileSync(path.join(dir, ".mailbox", "config.json"), "utf8"));
    assert.equal(config.outbound_provider, "brevo", "the switch is already committed and never rolled back");

    // provider:recover retries the inactive-provider cleanup and clears.
    const recover = run(dir, ["recover"]);
    assert.equal(recover.status, 0, `recover failed:\n${recover.stdout}\n${recover.stderr}`);
    assert.match(recover.stdout, /removed .* inactive-provider Worker secret/);
    assert.equal(existsSync(journal), false, "journal cleared after recovery cleanup");
    assert.equal(existsSync(path.join(dir, "wrangler.provider-next.jsonc")), false, "NEXT files removed after recovery");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inactive keys are never deleted BEFORE the switch deploy (no premature removal)", () => {
  const { dir } = fixtureDir("resend");
  const bulkLog = path.join(dir, "bulk.log");
  try {
    // The deletion must be the LAST secret bulk call (after deploy). Assert
    // no null-valued bulk happens before the apply bulk.
    const result = run(dir, ["set", "brevo"], { FAKE_NPX_LOG: path.join(dir, "npx.log"), FAKE_BULK_LOG: bulkLog });
    assert.equal(result.status, 0, result.stderr);
    const calls = bulkCalls(bulkLog);
    const nullIdx = calls.findIndex((call) => Object.values(call).some((v) => v === null));
    assert.ok(nullIdx !== -1, "a deletion call exists");
    assert.equal(nullIdx, calls.length - 1, "the deletion is the LAST secret bulk call (after the apply)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
