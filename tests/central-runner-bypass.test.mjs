// CENTRAL-CREDENTIAL RUNTIME CLOSURE — bypass regression tests.
//
// Real-user scenario: the shell environment has NO Cloudflare token
// (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID absent), the operator
// credential store (.mailbox/credentials.env) holds the token, and the
// operator config (.mailbox/config.json) holds the account id. A fake
// `npx` on PATH impersonates wrangler and logs the credential env of every
// invocation, proving that every authenticated operator command injects
// the central token + account id into EVERY Cloudflare subprocess:
//
//   provider:set cloudflare        queue list/create, subscription
//                                  list/create, secret bulk, deploy
//   provider:remove cloudflare     subscription list/delete, d1 execute,
//                                  secret removal
//   db:migrate:remote              d1 migrations apply --remote
//   setup (production, Node 22)    d1 list/create, r2 list/create, sentinel
//                                  put, migrations, secret put, deploy
//
// A bypass (a generic spawn runner reaching a Cloudflare path) would make
// the fake `npx` see no token and fail the assertions below.
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { OPERATOR_STATE_SCHEMA_VERSION, generatedConfigHash } from "../scripts/config/operator-state.mjs";

const ROOT = process.cwd();
const TEST_TOKEN = "test-central-token-0123456789abcdef";
const TEST_ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
const ZONE_ID = "a".repeat(32);
const WORKER_NAME = "my-mailbox";
const MAIL_DOMAIN = "mailgable-test.dev";
const D1_ID = "11111111-2222-4333-8444-555555555555";
const NODE_MAJOR = Number.parseInt(process.versions.node.split(".")[0], 10);

// Fake `npx`/wrangler shim. Plain CommonJS (the fixture dir has no
// package.json), logs { args, token, accountId } for every call, drains
// secret stdin, and responds like wrangler for the command sequences the
// operator commands produce.
const FAKE_NPX = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const entry = JSON.stringify({
  args,
  token: process.env.CLOUDFLARE_API_TOKEN || null,
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID || null,
});
if (process.env.FAKE_NPX_LOG) fs.appendFileSync(process.env.FAKE_NPX_LOG, entry + "\\n");
if (args.includes("secret")) {
  try { fs.readFileSync(0, "utf8"); } catch {}
}
const cmd = (n) => (args[n] || "");
const isQueueList = cmd(0) === "wrangler" && cmd(1) === "queues" && cmd(2) === "list";
const isQueueSubList = cmd(0) === "wrangler" && cmd(1) === "queues" && cmd(2) === "subscription" && cmd(3) === "list";
const isD1Execute = cmd(0) === "wrangler" && cmd(1) === "d1" && cmd(2) === "execute";
const isD1List = cmd(0) === "wrangler" && cmd(1) === "d1" && cmd(2) === "list";
const isD1Create = cmd(0) === "wrangler" && cmd(1) === "d1" && cmd(2) === "create";
const isR2List = cmd(0) === "wrangler" && cmd(1) === "r2" && cmd(2) === "bucket" && cmd(3) === "list";
if (isQueueList || isQueueSubList || isD1List || isR2List) {
  if (isQueueSubList && process.env.FAKE_NPX_SUBS_MODE === "owned") {
    process.stdout.write(JSON.stringify([{
      id: "s1",
      source: "email.sending",
      domain: process.env.FAKE_NPX_DOMAIN || "mail.example.com",
      zone_id: process.env.FAKE_NPX_ZONE || "${ZONE_ID}",
    }]) + "\\n");
  } else {
    process.stdout.write("[]\\n");
  }
  process.exit(0);
}
if (isD1Create) {
  process.stdout.write(JSON.stringify({ uuid: "${D1_ID}" }) + "\\n");
  process.exit(0);
}
if (isD1Execute) {
  process.stdout.write('[{"results":[{"n":0}]}]\\n');
  process.exit(0);
}
process.exit(0);
`;

function fixtureDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "central-runner-"));
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

function writeTriple(dir, provider) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  const generated = {
    name: WORKER_NAME,
    vars: {
      MAIL_WORKER_NAME: WORKER_NAME,
      MAIL_DOMAIN: MAIL_DOMAIN,
      CLOUDFLARE_ZONE_ID: ZONE_ID,
      OUTBOUND_PROVIDER: provider,
    },
    d1_databases: [{ database_name: `${WORKER_NAME}-db`, database_id: D1_ID }],
    r2_buckets: [{ bucket_name: `${WORKER_NAME}-r2` }],
  };
  // Minimal-but-real template: provider:set JSON.parses it and rebuilds the
  // generated config from it.
  writeFileSync(path.join(dir, "wrangler.jsonc"), JSON.stringify({
    name: WORKER_NAME,
    main: "src/index.ts",
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
    cloudflare_account_id: TEST_ACCOUNT_ID,
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
    cloudflare_account_id: TEST_ACCOUNT_ID,
    outbound_provider: provider,
    config_hash: generatedConfigHash(generated),
  }, null, 2), "utf8");
  // Central credential store: the token lives ONLY here, never in the shell env.
  writeFileSync(path.join(dir, ".mailbox", "credentials.env"),
    `CLOUDFLARE_API_TOKEN="${TEST_TOKEN}"\nAUTH_PEPPER="p"\nADMIN_BOOTSTRAP_TOKEN="bootstrap"\n`, "utf8");
}

function runOperator(dir, script, args, { subsMode = "empty", extraEnv = {} } = {}) {
  const logFile = path.join(dir, "npx-calls.log");
  const env = { ...process.env, HOME: dir, PATH: `${path.join(dir, "bin")}:${process.env.PATH || ""}` };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  delete env.CLOUDFLARE_ROUTING_READ_TOKEN;
  delete env.MAILBOX_CREDENTIALS_FILE;
  delete env.MAILBOX_CONFIG_FILE;
  env.FAKE_NPX_LOG = logFile;
  env.FAKE_NPX_SUBS_MODE = subsMode;
  env.FAKE_NPX_DOMAIN = MAIL_DOMAIN;
  env.FAKE_NPX_ZONE = ZONE_ID;
  Object.assign(env, extraEnv);
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    cwd: dir,
    encoding: "utf8",
    env,
    timeout: 90_000,
  });
  const calls = [];
  try {
    for (const line of readFileSync(logFile, "utf8").trim().split("\n")) {
      if (line) calls.push(JSON.parse(line));
    }
  } catch {
    // no calls recorded
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

function assertAllCallsCarryCentralCredentials(calls, { message }) {
  assert.ok(calls.length > 0, `${message}: fake npx recorded no invocations`);
  for (const call of calls) {
    assert.equal(call.token, TEST_TOKEN, `${message}: '${call.args.join(" ")}' did not receive the central CLOUDFLARE_API_TOKEN`);
    assert.equal(call.accountId, TEST_ACCOUNT_ID, `${message}: '${call.args.join(" ")}' did not receive CLOUDFLARE_ACCOUNT_ID`);
  }
}

test("provider:set cloudflare — every Cloudflare subprocess receives the central token + account id", () => {
  const dir = fixtureDir();
  try {
    writeTriple(dir, "none");
    const result = runOperator(dir, "provider.mjs", ["set", "cloudflare"]);
    assert.equal(result.status, 0, `provider:set cloudflare failed:\n${result.stdout}\n${result.stderr}`);
    const { calls } = result;
    assertAllCallsCarryCentralCredentials(calls, { message: "provider:set cloudflare" });

    const isSubList = (call) => call.args.includes("queues") && call.args.includes("subscription") && call.args.includes("list");
    const isSubCreate = (call) => call.args.includes("queues") && call.args.includes("subscription") && call.args.includes("create");
    const queueList = calls.filter((call) => call.args.includes("queues") && call.args.includes("list") && !isSubList(call));
    const queueCreate = calls.filter((call) => call.args.includes("queues") && call.args.includes("create") && !isSubCreate(call));
    const subList = calls.filter(isSubList);
    const subCreate = calls.filter(isSubCreate);
    const deploys = calls.filter((call) => call.args.includes("deploy"));
    const secretBulk = calls.filter((call) => call.args.includes("secret") && call.args.includes("bulk"));

    assert.equal(queueList.length, 1, "queue list ran exactly once");
    assert.equal(queueCreate.length, 1, "queue create ran exactly once");
    assert.equal(subList.length, 1, "subscription list ran exactly once");
    assert.equal(subCreate.length, 1, "subscription create ran exactly once");
    assert.equal(secretBulk.length, 1, "secret bulk ran exactly once");
    assert.ok(deploys.length >= 2, "dry-run + real deploy both ran");

    // The single remote switch point (the real NEXT deploy) also carries the token.
    const realDeploy = deploys.find((call) => !call.args.includes("--dry-run"));
    assert.ok(realDeploy, "the real provider-switch deploy ran");
    assert.equal(realDeploy.token, TEST_TOKEN, "the switch deploy carries the central token");
    assert.equal(realDeploy.accountId, TEST_ACCOUNT_ID, "the switch deploy carries the account id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider:remove cloudflare — subscription list/delete still receive the central credentials", () => {
  const dir = fixtureDir();
  try {
    writeTriple(dir, "none");
    const result = runOperator(dir, "provider.mjs", ["remove", "cloudflare"], { subsMode: "owned" });
    assert.equal(result.status, 0, `provider:remove cloudflare failed:\n${result.stdout}\n${result.stderr}`);
    const { calls } = result;
    assertAllCallsCarryCentralCredentials(calls, { message: "provider:remove cloudflare" });

    const subList = calls.filter((call) => call.args.includes("queues") && call.args.includes("subscription") && call.args.includes("list"));
    const subDelete = calls.filter((call) => call.args.includes("queues") && call.args.includes("subscription") && call.args.includes("delete"));
    const d1Execute = calls.filter((call) => call.args.includes("d1") && call.args.includes("execute"));
    const secretBulk = calls.filter((call) => call.args.includes("secret") && call.args.includes("bulk"));

    assert.equal(d1Execute.length, 1, "the D1 retryable check ran once");
    assert.equal(subList.length, 1, "subscription list ran exactly once");
    assert.equal(subDelete.length, 1, "the owned MailGable subscription was deleted once");
    assert.equal(secretBulk.length, 1, "secret removal ran once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("db:migrate:remote — D1 remote migrations run through the central runner with full state gate", () => {
  const dir = fixtureDir();
  try {
    writeTriple(dir, "none");
    const result = runOperator(dir, "db-remote.mjs", ["migrate"]);
    assert.equal(result.status, 0, `db:migrate:remote failed:\n${result.stdout}\n${result.stderr}`);
    const { calls } = result;
    assertAllCallsCarryCentralCredentials(calls, { message: "db:migrate:remote" });
    assert.equal(calls.length, 1, "exactly one Wrangler invocation: d1 migrations apply --remote");
    assert.ok(calls[0].args.includes("d1") && calls[0].args.includes("migrations") && calls[0].args.includes("apply") && calls[0].args.includes("--remote"),
      `unexpected argv: ${calls[0].args.join(" ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("db:migrate:remote — tampered generated config fails the state gate with zero Wrangler calls", () => {
  const dir = fixtureDir();
  try {
    writeTriple(dir, "none");
    const generatedPath = path.join(dir, "wrangler.deploy.jsonc");
    const generated = JSON.parse(readFileSync(generatedPath, "utf8"));
    generated.vars.ADMIN_EMAIL = "tampered@example.com";
    writeFileSync(generatedPath, JSON.stringify(generated, null, 2), "utf8");
    const result = runOperator(dir, "db-remote.mjs", ["migrate"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /operator_state_config_hash_mismatch/);
    assert.equal(result.calls.length, 0, "no Wrangler invocation before the state gate passes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// setup.mjs enforces the canonical Node 22 runtime. On a local non-22 dev
// node the probe is skipped (informational); run the suite on Node 22 for
// the full assertion.
test("setup (production) — D1/R2 discovery, migrations, secret put, and deploy all receive central credentials",
  { skip: NODE_MAJOR !== 22 },
  () => {
    const dir = fixtureDir();
    try {
      writeTriple(dir, "none");
      const result = runOperator(dir, "setup.mjs", ["--mode", "production"]);
      assert.equal(result.status, 0, `setup failed:\n${result.stdout}\n${result.stderr}`);
      const { calls } = result;
      assertAllCallsCarryCentralCredentials(calls, { message: "setup" });

      const d1List = calls.filter((call) => call.args.includes("d1") && call.args.includes("list"));
      const d1Create = calls.filter((call) => call.args.includes("d1") && call.args.includes("create"));
      const r2List = calls.filter((call) => call.args.includes("r2") && call.args.includes("list"));
      const r2Create = calls.filter((call) => call.args.includes("r2") && call.args.includes("create"));
      const migrations = calls.filter((call) => call.args.includes("d1") && call.args.includes("migrations") && call.args.includes("apply"));
      const secretPuts = calls.filter((call) => call.args.includes("secret") && call.args.includes("put"));
      const deploys = calls.filter((call) => call.args.includes("deploy") && !call.args.includes("--dry-run"));

      assert.equal(d1List.length, 1, "d1 discovery ran once");
      assert.equal(d1Create.length, 1, "missing D1 was created once");
      assert.equal(r2List.length, 1, "r2 discovery ran once");
      assert.equal(r2Create.length, 1, "missing R2 was created once");
      assert.equal(migrations.length, 1, "remote migrations applied once");
      assert.equal(secretPuts.length, 2, "AUTH_PEPPER + ADMIN_BOOTSTRAP_TOKEN uploaded once each");
      assert.equal(deploys.length, 1, "the Worker was deployed once");
      assert.ok(!calls.some((call) => call.args.includes("secret") && call.args.includes("bulk")), "setup uploads via secret put, never bulk");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
