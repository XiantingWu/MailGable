// IMMUTABLE CREDENTIAL SNAPSHOT DURING A PROVIDER TRANSACTION (Phase 50+).
//
// provider:set loads credentials exactly once at the start of the
// transaction. Even if the underlying .mailbox/credentials.env is modified
// mid-transaction (here: the fake npx rewrites it to KEY_B during the
// dry-run deploy), the validation, the secret upload, and the reconcile of
// THIS transaction must all keep using the original KEY_A snapshot. Only
// the next independent command (provider:status) may observe KEY_B.
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { OPERATOR_STATE_SCHEMA_VERSION, generatedConfigHash } from "../scripts/config/operator-state.mjs";

const ROOT = process.cwd();
const ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
const ZONE_ID = "a".repeat(32);
const WORKER_NAME = "snapshot-mailbox";
const MAIL_DOMAIN = "snapshot-test.dev";
const D1_ID = "11111111-2222-4333-8444-555555555555";
const KEY_A = "re_key_A_snapshot";
const KEY_B = "re_key_B_rewritten";

const FAKE_NPX = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const cmd = (n) => (args[n] || "");
const credsPath = process.env.FAKE_CREDS_FILE;
const log = process.env.FAKE_NPX_LOG;
// During the FIRST wrangler invocation (the dry-run deploy) rewrite the
// central store so a stale re-read would pick up KEY_B and lose AUTH_PEPPER.
if (process.env.FAKE_MUTATE_ONCE === "1" && args[0] === "wrangler" && args[1] === "deploy" && args.includes("--dry-run")) {
  fs.writeFileSync(credsPath, 'RESEND_API_KEY="${KEY_B}"\\nCLOUDFLARE_ROUTING_READ_TOKEN="rrt"\\n', "utf8");
  process.env.FAKE_MUTATE_ONCE = "0";
}
if (args.includes("secret")) {
  const input = fs.readFileSync(0, "utf8");
  if (log && args.includes("bulk")) {
    fs.writeFileSync(process.env.FAKE_SNAPSHOT_LOG, input, "utf8");
  }
}
if (cmd(0) === "wrangler" && cmd(1) === "d1" && cmd(2) === "execute") {
  process.stdout.write('[{"results":[{"n":0}]}]\\n');
}
if (log) {
  fs.appendFileSync(log, JSON.stringify({ args }) + "\\n");
}
process.exit(0);
`;

function fixtureDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "cred-snapshot-"));
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
  return dir;
}

function writeTriple() {
  const dir = fixtureDir();
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  const generated = {
    name: WORKER_NAME,
    vars: { MAIL_WORKER_NAME: WORKER_NAME, MAIL_DOMAIN: MAIL_DOMAIN, CLOUDFLARE_ZONE_ID: ZONE_ID, OUTBOUND_PROVIDER: "none" },
    d1_databases: [{ database_name: `${WORKER_NAME}-db`, database_id: D1_ID }],
    r2_buckets: [{ bucket_name: `${WORKER_NAME}-r2` }],
  };
  writeFileSync(path.join(dir, "wrangler.jsonc"), JSON.stringify({
    name: WORKER_NAME,
    main: "src/index.ts",
    compatibility_date: "2025-01-01",
    d1_databases: [{ binding: "DB", database_name: `${WORKER_NAME}-db`, database_id: D1_ID, migrations_dir: "migrations" }],
    r2_buckets: [{ binding: "MAIL_R2", bucket_name: `${WORKER_NAME}-r2` }],
    vars: {},
  }), "utf8");
  writeFileSync(path.join(dir, "wrangler.deploy.jsonc"), JSON.stringify(generated, null, 2), "utf8");
  writeFileSync(path.join(dir, ".mailbox", "config.json"), JSON.stringify({
    mode: "production",
    worker_name: WORKER_NAME,
    mail_domain: MAIL_DOMAIN,
    admin_email: `admin@${MAIL_DOMAIN}`,
    app_origin: `https://mail.${MAIL_DOMAIN}`,
    cloudflare_zone_id: ZONE_ID,
    cloudflare_account_id: ACCOUNT_ID,
    outbound_provider: "none",
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
    outbound_provider: "none",
    config_hash: generatedConfigHash(generated),
  }, null, 2), "utf8");
  const credsFile = path.join(dir, ".mailbox", "credentials.env");
  writeFileSync(credsFile, `AUTH_PEPPER="p"\nRESEND_API_KEY="${KEY_A}"\nCLOUDFLARE_ROUTING_READ_TOKEN="rrt"\n`, "utf8");
  return { dir, credsFile };
}

function run(dir, script, args, extraEnv) {
  const env = { ...process.env, HOME: dir, PATH: `${path.join(dir, "bin")}:${process.env.PATH || ""}` };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  delete env.MAILBOX_CREDENTIALS_FILE;
  delete env.MAILBOX_CONFIG_FILE;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    cwd: dir,
    encoding: "utf8",
    env,
    timeout: 90_000,
  });
}

test("provider:set uses ONE immutable credential snapshot even when the store changes mid-transaction", () => {
  const { dir, credsFile } = writeTriple();
  const snapshotLog = path.join(dir, "secret-snapshot.json");
  try {
    const result = run(dir, "provider.mjs", ["set", "resend"], {
      FAKE_NPX_LOG: path.join(dir, "npx.log"),
      FAKE_CREDS_FILE: credsFile,
      FAKE_SNAPSHOT_LOG: snapshotLog,
      FAKE_MUTATE_ONCE: "1",
    });
    assert.equal(result.status, 0, `provider:set failed:\n${result.stdout}\n${result.stderr}`);
    const uploaded = JSON.parse(readFileSync(snapshotLog, "utf8"));
    assert.equal(uploaded.RESEND_API_KEY, KEY_A, "secret upload uses the ORIGINAL snapshot (KEY_A), not the rewritten KEY_B");
    assert.equal(uploaded.AUTH_PEPPER, "p");
    const stored = readFileSync(credsFile, "utf8");
    assert.match(stored, new RegExp(KEY_B), "the underlying store now holds KEY_B after the mid-transaction rewrite");
    assert.ok(!stored.includes("AUTH_PEPPER"), "the rewrite also removed AUTH_PEPPER from the store");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the next independent command reads the NEW credential value", () => {
  const { dir, credsFile } = writeTriple();
  try {
    const set = run(dir, "provider.mjs", ["set", "resend"], {
      FAKE_NPX_LOG: path.join(dir, "npx.log"),
      FAKE_CREDS_FILE: credsFile,
      FAKE_SNAPSHOT_LOG: path.join(dir, "secret-snapshot.json"),
      FAKE_MUTATE_ONCE: "1",
    });
    assert.equal(set.status, 0, set.stderr);
    const status = run(dir, "provider.mjs", ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Send: CONFIGURED/, "the provider sees a send key after the switch");
    assert.match(status.stdout, /Credentials: 2\/10 schema keys present/,
      "the next command re-reads the store: AUTH_PEPPER (removed mid-transaction) is gone, proving it is NOT a stale snapshot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
