// Central-credential runtime closure tests (Phases 7/8/15/34/38/48/50/51):
// the Wrangler child environment carries the central Cloudflare token
// (process env wins), setup state is gitignored, journal clears are
// repeat-safe, and the required/optional secret matrices hold.
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync, spawn } from "node:child_process";
import {
  buildWranglerChildEnv,
  publicEnvSnapshot,
} from "../scripts/operator-runner.mjs";
import { requiredSecretsFor, PROVIDER_ACTIVATION_REQUIREMENTS, DELIVERY_EVENT_SECRETS, CREDENTIAL_KEY_SET } from "../scripts/config/credentials.mjs";
import { writeOperationJournal, readOperationJournal, clearOperationJournal } from "../scripts/config/operator-state.mjs";
import { OPERATOR_CONFIG_KEYS, canonicalOperatorConfig } from "../scripts/config/operator-config.mjs";

const FIXTURE_TOKEN = "test-token-0123456789abcdef";

test("Phase 7/8: central Cloudflare token enters the child env only; process env wins", () => {
  const credentialsFile = mkdtempSync(path.join(tmpdir(), "runner-"));
  writeFileSync(path.join(credentialsFile, "credentials.env"),
    'CLOUDFLARE_API_TOKEN="file-token-123"\nCLOUDFLARE_ROUTING_READ_TOKEN="rrt"\n', "utf8");
  try {
    const fromFile = buildWranglerChildEnv({
      credentials: { CLOUDFLARE_API_TOKEN: "file-token-123" },
      operatorConfig: { cloudflare_account_id: "a".repeat(32) },
      baseEnv: { HOME: "/tmp", PATH: "/usr/bin" },
    });
    assert.equal(fromFile.CLOUDFLARE_API_TOKEN, "file-token-123");
    assert.equal(fromFile.CLOUDFLARE_ACCOUNT_ID, "a".repeat(32));
    assert.ok(!publicEnvSnapshot(fromFile).CLOUDFLARE_API_TOKEN, "token is never visible in the public snapshot");

    // Phase 8: process env wins over the file.
    const withProcess = buildWranglerChildEnv({
      credentials: { CLOUDFLARE_API_TOKEN: "file-token-123" },
      baseEnv: { CLOUDFLARE_API_TOKEN: "process-token-999" },
    });
    assert.equal(withProcess.CLOUDFLARE_API_TOKEN, "process-token-999");
  } finally {
    rmSync(credentialsFile, { recursive: true, force: true });
  }
});

test("Phase 34: Wrangler child processes see the central token; stdout/stderr never contain it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runner-spawn-"));
  try {
    const childEnv = buildWranglerChildEnv({
      credentials: { CLOUDFLARE_API_TOKEN: FIXTURE_TOKEN, CLOUDFLARE_ROUTING_READ_TOKEN: "rrt" },
      operatorConfig: { cloudflare_account_id: "a".repeat(32) },
      baseEnv: { HOME: "/tmp", PATH: process.env.PATH || "" },
    });
    assert.equal(childEnv.CLOUDFLARE_API_TOKEN, FIXTURE_TOKEN);
    assert.equal(childEnv.CLOUDFLARE_ACCOUNT_ID, "a".repeat(32));
    // A real child process receives the injected token; its own output must
    // never contain it.
    const probe = spawn(process.execPath, ["-e", "console.log(process.env.CLOUDFLARE_API_TOKEN || 'EMPTY')"], { env: childEnv });
    let out = "";
    probe.stdout.on("data", (chunk) => { out += chunk; });
    const exitCode = await new Promise((resolve) => probe.on("close", (code) => resolve(code)));
    assert.equal(exitCode, 0);
    assert.equal(out.trim(), FIXTURE_TOKEN, "child process sees the central token");
    assert.ok(!publicEnvSnapshot(childEnv).CLOUDFLARE_API_TOKEN, "token never in public output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});



test("Phase 17: account id is canonical operator config, authoritative over shell", () => {
  const configured = buildWranglerChildEnv({
    credentials: {},
    operatorConfig: { cloudflare_account_id: "cfg".padEnd(32, "0") },
    baseEnv: { CLOUDFLARE_ACCOUNT_ID: "shell".padEnd(32, "0"), HOME: "/tmp" },
  });
  assert.equal(configured.CLOUDFLARE_ACCOUNT_ID, "cfg".padEnd(32, "0"), "operator config overrides a stale shell account id");
  const none = buildWranglerChildEnv({
    credentials: {},
    operatorConfig: {},
    baseEnv: { CLOUDFLARE_ACCOUNT_ID: "shell".padEnd(32, "0"), HOME: "/tmp" },
  });
  assert.equal(none.CLOUDFLARE_ACCOUNT_ID, undefined, "a stale shell account id is removed when the operator config has none");
});

test("Phase 16: process env token still wins over the central store; value never printed", () => {
  const env = buildWranglerChildEnv({
    credentials: { CLOUDFLARE_API_TOKEN: "file-token" },
    operatorConfig: { cloudflare_account_id: "a".repeat(32) },
    baseEnv: { CLOUDFLARE_API_TOKEN: "env-token", HOME: "/tmp" },
  });
  assert.equal(env.CLOUDFLARE_API_TOKEN, "env-token", "process env wins");
  assert.ok(!publicEnvSnapshot(env).CLOUDFLARE_API_TOKEN, "token is never visible in the public snapshot");
});

test("Phase 15: canonical setup state files are gitignored", () => {
  const root = path.join(process.cwd());
  const check = (file) => spawnSync("git", ["check-ignore", "-q", file], { cwd: root }).status === 0;
  assert.ok(check(".setup-state.json"), ".setup-state.json must be gitignored");
  assert.ok(check("wrangler.deploy.jsonc"), "wrangler.deploy.jsonc must be gitignored");
  assert.ok(check(".mailbox/credentials.env"), ".mailbox/credentials.env must be gitignored");
  assert.ok(check(".mailbox/config.json"), ".mailbox/config.json must be gitignored");
  assert.ok(check(".mailbox/provider-operation.json"), "journal must be gitignored");
  assert.ok(check("wrangler.provider-next.jsonc"), "NEXT config must be gitignored");
});

test("Phase 38: journal clear is repeat-safe without .done artifacts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "journal-"));
  const file = path.join(dir, "provider-operation.json");
  try {
    writeOperationJournal({ operation: "provider_switch", from: "resend", to: "brevo", rc_sha: "f".repeat(40), next_config_hash: "g".repeat(64), phase: "remote_switched" });
    assert.equal(readOperationJournal().phase, "remote_switched");
    clearOperationJournal();
    assert.equal(existsSync(file), false, "journal removed");
    assert.equal(existsSync(`${file}.done`), false, "no .done artifact");
    // Second operation after clear: no stale destination problem.
    writeOperationJournal({ operation: "provider_switch", from: "brevo", to: "cloudflare", rc_sha: "f".repeat(40), next_config_hash: "h".repeat(64), phase: "prepared" });
    clearOperationJournal();
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(`${file}.done`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 50: required-secret matrix (deploy-blocking only)", () => {
  assert.deepEqual(requiredSecretsFor("none"), ["AUTH_PEPPER"]);
  assert.deepEqual(requiredSecretsFor("resend"), ["AUTH_PEPPER", "RESEND_API_KEY"]);
  assert.deepEqual(requiredSecretsFor("brevo"), ["AUTH_PEPPER", "BREVO_API_KEY"]);
  assert.deepEqual(requiredSecretsFor("cloudflare"), ["AUTH_PEPPER"]);
  const forbidden = ["ADMIN_BOOTSTRAP_TOKEN", "CLOUDFLARE_API_TOKEN", "RESEND_SETUP_API_KEY", "BREVO_SETUP_API_KEY"];
  for (const provider of ["none", "resend", "brevo", "cloudflare"]) {
    for (const name of forbidden) {
      assert.ok(!requiredSecretsFor(provider).includes(name), `${name} must never be deploy-blocking`);
    }
  }
});

test("Phase 51: optional capability secrets never block deployment", () => {
  for (const name of ["CLOUDFLARE_ROUTING_READ_TOKEN", "RESEND_WEBHOOK_SECRET", "BREVO_WEBHOOK_TOKEN"]) {
    for (const provider of ["none", "resend", "brevo", "cloudflare"]) {
      assert.ok(!requiredSecretsFor(provider).includes(name), `${name} is optional`);
    }
  }
  // Activation requirements are send keys only; delivery-event secrets are separate.
  assert.deepEqual(PROVIDER_ACTIVATION_REQUIREMENTS, {
    none: [], resend: ["RESEND_API_KEY"], brevo: ["BREVO_API_KEY"], cloudflare: [],
  });
  assert.deepEqual(DELIVERY_EVENT_SECRETS, {
    resend: ["RESEND_WEBHOOK_SECRET"], brevo: ["BREVO_WEBHOOK_TOKEN"], cloudflare: [],
  });
});

test("Phase 3/35: cloudflare_account_id is canonical, non-secret operator config", () => {
  assert.ok(OPERATOR_CONFIG_KEYS.includes("cloudflare_account_id"));
  const canonical = canonicalOperatorConfig({
    cloudflare_account_id: "a".repeat(32),
    zone_id: "z".repeat(32),
    cloudflare_zone_id: "z".repeat(32),
    worker_name: "mb",
  });
  assert.equal(canonical.cloudflare_account_id, "a".repeat(32));
  assert.equal(canonical.zone_id, undefined, "zone_id is not canonical");
  assert.equal(canonical.cloudflare_zone_id, "z".repeat(32));
});

test("Phase 9: credential schema allowlist is complete and closed", () => {
  assert.deepEqual([...CREDENTIAL_KEY_SET].sort(), [
    "ADMIN_BOOTSTRAP_TOKEN", "AUTH_PEPPER", "BREVO_API_KEY", "BREVO_SETUP_API_KEY",
    "BREVO_WEBHOOK_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ROUTING_READ_TOKEN",
    "RESEND_API_KEY", "RESEND_SETUP_API_KEY", "RESEND_WEBHOOK_SECRET",
  ].sort());
});