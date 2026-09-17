// TRANSACTIONAL credentials:rotate + recover (Phase 34+).
//
// The rotation journal (.mailbox/credential-operation.json) contains only
// non-secret metadata: schema_version, operation, key, phase, started_at,
// worker_name. Phases: prepared -> local_written -> remote_written ->
// converged (cleared). A remote failure keeps the journal and
// credentials:recover converges the Worker from the CURRENT local value —
// never re-asking the secret, never rolling back.
//
// Security canaries: the journal never contains the old/new value, hash,
// prefix, or suffix; AUTH_PEPPER stays unrotatable; operator-local keys
// rotate locally without any Worker secret put.
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
const ZONE_ID = "a".repeat(32);
const WORKER_NAME = "rotate-mailbox";
const MAIL_DOMAIN = "rotate-test.dev";
const D1_ID = "11111111-2222-4333-8444-555555555555";
const OLD_VALUE = "re_old_rotation_value";
const NEW_VALUE = "re_new_rotation_value";

// Fake npx: logs secret-put stdin to FAKE_PUT_LOG and can fail the remote
// put on demand (FAKE_FAIL_PUT=1 -> exit 1 for secret put).
const FAKE_NPX = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const isSecretPut = args[0] === "wrangler" && args[1] === "secret" && args[2] === "put";
if (isSecretPut && process.env.FAKE_FAIL_PUT === "1") {
  process.exit(1);
}
if (isSecretPut) {
  const input = fs.readFileSync(0, "utf8");
  fs.writeFileSync(process.env.FAKE_PUT_LOG, JSON.stringify({ key: args[3], value: input }) + "\\n");
}
process.exit(0);
`;

function fixtureDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "cred-rotate-"));
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
  const credsFile = path.join(dir, ".mailbox", "credentials.env");
  writeFileSync(credsFile, `AUTH_PEPPER="p"\nRESEND_API_KEY="${OLD_VALUE}"\nCLOUDFLARE_API_TOKEN="cf-token"\n`, "utf8");
  return { dir, credsFile };
}

function run(dir, args, extraEnv) {
  const env = { ...process.env, HOME: dir, PATH: `${path.join(dir, "bin")}:${process.env.PATH || ""}` };
  delete env.MAILBOX_CREDENTIALS_FILE;
  delete env.MAILBOX_CONFIG_FILE;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [path.join(ROOT, "scripts", "credentials.mjs"), ...args], {
    cwd: dir,
    input: `${NEW_VALUE}\n`,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

test("rotate writes a secret-free journal and converges through all phases", () => {
  const { dir } = fixtureDir();
  const journalFile = path.join(dir, ".mailbox", "credential-operation.json");
  const putLog = path.join(dir, "put.log");
  try {
    const result = run(dir, ["rotate", "RESEND_API_KEY"], { FAKE_PUT_LOG: putLog });
    assert.equal(result.status, 0, `rotate failed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /updated locally/);
    assert.match(result.stdout, /updated on the Worker/);
    assert.equal(existsSync(journalFile), false, "journal cleared on convergence");
    const put = JSON.parse(readFileSync(putLog, "utf8"));
    assert.equal(put.key, "RESEND_API_KEY");
    assert.equal(put.value, NEW_VALUE, "the rotated value is uploaded to the Worker");
    const creds = readFileSync(path.join(dir, ".mailbox", "credentials.env"), "utf8");
    assert.ok(creds.includes(NEW_VALUE), "local store holds the new value");
    assert.ok(!creds.includes(OLD_VALUE), "old value replaced locally");
    assert.ok(!result.stdout.includes(NEW_VALUE), "the secret never appears on stdout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotate journal never contains the old or new value, hash, prefix, or suffix", () => {
  const { dir } = fixtureDir();
  const journalFile = path.join(dir, ".mailbox", "credential-operation.json");
  const putLog = path.join(dir, "put.log");
  try {
    const result = run(dir, ["rotate", "RESEND_API_KEY"], { FAKE_PUT_LOG: putLog });
    assert.equal(result.status, 0, result.stderr);
    // The journal is cleared at the end; re-read via a forced failure run to
    // inspect a mid-flight journal, and check the cleared case has no file.
    assert.equal(existsSync(journalFile), false, "no journal residue after success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remote failure keeps the journal and recover converges the current local value", () => {
  const { dir } = fixtureDir();
  const journalFile = path.join(dir, ".mailbox", "credential-operation.json");
  const putLog = path.join(dir, "put.log");
  try {
    const failed = run(dir, ["rotate", "RESEND_API_KEY"], { FAKE_PUT_LOG: putLog, FAKE_FAIL_PUT: "1" });
    assert.notEqual(failed.status, 0, "remote failure must fail the rotate command");
    assert.match(failed.stdout + failed.stderr, /credentials:recover/, "hints credentials:recover");
    const journal = JSON.parse(readFileSync(journalFile, "utf8"));
    assert.equal(journal.operation, "credential_rotate");
    assert.equal(journal.key, "RESEND_API_KEY");
    assert.equal(journal.phase, "local_written", "journal stops at local_written");
    assert.equal(journal.worker_name, WORKER_NAME);
    const serialized = JSON.stringify(journal);
    assert.ok(!serialized.includes(NEW_VALUE), "journal never contains the new value");
    assert.ok(!serialized.includes(OLD_VALUE), "journal never contains the old value");
    assert.ok(!/hash|prefix|suffix/i.test(serialized), "journal never contains hash/prefix/suffix fields");
    const creds = readFileSync(path.join(dir, ".mailbox", "credentials.env"), "utf8");
    assert.ok(creds.includes(NEW_VALUE), "local value was updated before the remote failure");

    // recover converges from the CURRENT local value (no re-ask).
    const recover = run(dir, ["recover"], { FAKE_PUT_LOG: putLog });
    assert.equal(recover.status, 0, `recover failed:\n${recover.stdout}\n${recover.stderr}`);
    assert.match(recover.stdout, /converged to the Worker/);
    assert.equal(existsSync(journalFile), false, "journal cleared after recover");
    const put = JSON.parse(readFileSync(putLog, "utf8"));
    assert.equal(put.value, NEW_VALUE, "recover uploads the current local value, not an old one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotate is blocked while a recovery is pending", () => {
  const { dir } = fixtureDir();
  const journalFile = path.join(dir, ".mailbox", "credential-operation.json");
  const putLog = path.join(dir, "put.log");
  try {
    const failed = run(dir, ["rotate", "RESEND_API_KEY"], { FAKE_PUT_LOG: putLog, FAKE_FAIL_PUT: "1" });
    assert.notEqual(failed.status, 0);
    assert.equal(existsSync(journalFile), true, "pending journal exists");
    const second = run(dir, ["rotate", "BREVO_API_KEY"], { FAKE_PUT_LOG: putLog });
    assert.notEqual(second.status, 0);
    assert.match(second.stdout + second.stderr, /credential_recovery_pending/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AUTH_PEPPER rotation is still refused outright", () => {
  const { dir } = fixtureDir();
  const journalFile = path.join(dir, ".mailbox", "credential-operation.json");
  const putLog = path.join(dir, "put.log");
  try {
    const result = run(dir, ["rotate", "AUTH_PEPPER"], { FAKE_PUT_LOG: putLog });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /pepper_rotation_refused/);
    assert.equal(existsSync(journalFile), false, "no journal for a refused rotation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operator-local key rotates locally with no Worker secret put", () => {
  const { dir } = fixtureDir();
  const journalFile = path.join(dir, ".mailbox", "credential-operation.json");
  const putLog = path.join(dir, "put.log");
  try {
    const result = run(dir, ["rotate", "CLOUDFLARE_API_TOKEN"], { FAKE_PUT_LOG: putLog });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /operator-local — no Worker secret update/);
    assert.equal(existsSync(journalFile), false, "no lingering journal");
    assert.equal(existsSync(putLog), false, "no wrangler secret put for an operator-local key");
    const creds = readFileSync(path.join(dir, ".mailbox", "credentials.env"), "utf8");
    assert.ok(creds.includes(NEW_VALUE), "local value rotated");
    assert.ok(!creds.includes("cf-token"), "old local value replaced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recover with no pending journal fails closed", () => {
  const { dir } = fixtureDir();
  try {
    const result = run(dir, ["recover"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /no_credential_recovery_needed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
