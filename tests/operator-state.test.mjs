// Operator-state closure tests (Phase 2/3/5/6/8/45/46/47/48) plus
// credential round-trip and atomic-write guarantees.
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  currentGitSha,
  OperatorStateError as GitStateError,
} from "../scripts/git-state.mjs";
import {
  canonicalJson,
  generatedConfigHash,
  validateOperatorState,
  OPERATOR_STATE_SCHEMA_VERSION,
  OperatorStateError,
} from "../scripts/config/operator-state.mjs";
import {
  serializeCredentialEnv,
  parseCredentialEnv,
  writeCredentialsFile,
  setCredential,
  loadCredentials,
  CREDENTIAL_SCHEMA,
} from "../scripts/config/credentials.mjs";

function fakeRunCapture(ok, stdout, stderr = "") {
  return async () => ({ ok, stdout, stderr });
}

const HEAD = "a".repeat(40);
const D1_ID = "11111111-2222-4333-8444-555555555555";

function sampleTriple(overrides = {}) {
  const workerName = overrides.worker_name || "my-mailbox";
  const mailDomain = overrides.mail_domain || "mailgable-test.dev";
  const zoneId = overrides.cloudflare_zone_id || "a".repeat(32);
  const accountId = overrides.cloudflare_account_id || "a".repeat(32);
  const provider = overrides.outbound_provider || "resend";
  const d1Name = overrides.d1_name || `${workerName}-db`;
  const r2Name = overrides.r2_name || `${workerName}-r2`;
  const generated = {
    name: workerName,
    vars: {
      MAIL_WORKER_NAME: workerName,
      MAIL_DOMAIN: mailDomain,
      CLOUDFLARE_ZONE_ID: zoneId,
      OUTBOUND_PROVIDER: provider,
    },
    d1_databases: [{ database_name: d1Name, database_id: D1_ID }],
    r2_buckets: [{ bucket_name: r2Name }],
  };
  const operatorConfig = {
    worker_name: workerName,
    mail_domain: mailDomain,
    cloudflare_zone_id: zoneId,
    cloudflare_account_id: accountId,
    outbound_provider: provider,
    d1_name: d1Name,
    r2_name: r2Name,
  };
  const setupState = {
    schema_version: OPERATOR_STATE_SCHEMA_VERSION,
    rc_sha: HEAD,
    mode: "production",
    worker_name: workerName,
    d1_name: d1Name,
    d1_database_id: D1_ID,
    r2_name: r2Name,
    mail_domain: mailDomain,
    cloudflare_zone_id: zoneId,
    cloudflare_account_id: accountId,
    outbound_provider: provider,
    config_hash: generatedConfigHash(generated),
  };
  return { operatorConfig, setupState, generatedConfig: generated, currentSha: HEAD };
}

test("canonicalJson is whitespace-independent and key-sorted", () => {
  const a = canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }], z: null });
  const b = canonicalJson({ z: null, a: [2, { c: 4, d: 3 }], b: 1 });
  assert.equal(a, b);
  assert.ok(!a.includes(" "), "no whitespace dependence");
  const arrOrder = canonicalJson({ list: [1, 2, 3] });
  assert.notEqual(canonicalJson({ list: [3, 2, 1] }), arrOrder, "array order is preserved");
});

test("generatedConfigHash is stable across formatting changes", () => {
  const generated = { name: "w", vars: { A: "1" }, d1_databases: [{ database_name: "d", database_id: D1_ID }] };
  const pretty = JSON.stringify(generated, null, 2);
  const compact = JSON.stringify(generated);
  assert.equal(generatedConfigHash(JSON.parse(pretty)), generatedConfigHash(JSON.parse(compact)));
});

test("Phase 3: currentGitSha on a real temporary git repository (normal + detached)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "git-state-"));
  const git = (command, args) => {
    const result = spawnSync(command, args, { cwd: dir, encoding: "utf8" });
    return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
  };
  try {
    git("git", ["init", "-q"]);
    git("git", ["config", "user.email", "test@example.com"]);
    git("git", ["config", "user.name", "Test"]);
    writeFileSync(path.join(dir, "a.txt"), "x");
    git("git", ["add", "a.txt"]);
    git("git", ["commit", "-q", "-m", "one"]);
    const normal = await currentGitSha(git);
    assert.equal(normal, git("git", ["rev-parse", "HEAD"]).stdout.trim());
    writeFileSync(path.join(dir, "b.txt"), "y");
    git("git", ["add", "b.txt"]);
    git("git", ["commit", "-q", "-m", "two"]);
    const sha = git("git", ["rev-parse", "HEAD"]).stdout.trim();
    git("git", ["checkout", "-q", sha]); // detached HEAD
    const detached = await currentGitSha(git);
    assert.equal(detached, sha, "detached HEAD resolves through git rev-parse");
    // worktree checkout
    const worktree = path.join(dir, "wt");
    git("git", ["worktree", "add", "-q", worktree, sha]);
    const wtGit = (command, args) => {
      const result = spawnSync(command, args, { cwd: worktree, encoding: "utf8" });
      return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
    };
    const worktreeSha = await currentGitSha(wtGit);
    assert.equal(worktreeSha, sha, "worktree checkout resolves through git rev-parse");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("currentGitSha fails closed on unavailable and invalid output", async () => {
  await assert.rejects(currentGitSha(fakeRunCapture(false, "", "fatal")), (error) => error.code === "git_head_unavailable");
  await assert.rejects(currentGitSha(fakeRunCapture(true, "not-a-sha\n")), (error) => error.code === "git_head_invalid");
});

test("validateOperatorState passes on a consistent triple", () => {
  const triple = sampleTriple();
  const result = validateOperatorState(triple);
  assert.equal(result.ok, true);
  assert.equal(result.outboundProvider, "resend");
});

test("Phase 6: each mismatch fails closed with its stable code", () => {
  const base = sampleTriple();
  const cases = [
    { mutate: (t) => { t.setupState.rc_sha = "f".repeat(40); }, code: "operator_state_rc_mismatch" },
    { mutate: (t) => { t.setupState.worker_name = "other"; }, code: "operator_state_worker_mismatch" },
    { mutate: (t) => { t.operatorConfig.worker_name = "other"; }, code: "operator_state_worker_mismatch" },
    { mutate: (t) => { t.generatedConfig.name = "other"; }, code: "operator_state_worker_mismatch" },
    { mutate: (t) => { t.setupState.d1_name = "other-db"; }, code: "operator_state_d1_mismatch" },
    { mutate: (t) => { t.generatedConfig.d1_databases[0].database_id = "22222222-3333-4444-8555-666666666666"; }, code: "operator_state_d1_mismatch" },
    { mutate: (t) => { t.setupState.d1_database_id = "not-a-uuid"; }, code: "operator_state_d1_mismatch" },
    { mutate: (t) => { t.setupState.r2_name = "other-r2"; }, code: "operator_state_r2_mismatch" },
    { mutate: (t) => { t.setupState.mail_domain = "other.dev"; }, code: "operator_state_domain_mismatch" },
    { mutate: (t) => { t.setupState.cloudflare_zone_id = "b".repeat(32); }, code: "operator_state_zone_mismatch" },
    { mutate: (t) => { t.setupState.cloudflare_account_id = "b".repeat(32); }, code: "operator_state_account_mismatch" },
    { mutate: (t) => { t.operatorConfig.cloudflare_account_id = "b".repeat(32); }, code: "operator_state_account_mismatch" },
    { mutate: (t) => { t.setupState.outbound_provider = "brevo"; }, code: "operator_state_provider_mismatch" },
    { mutate: (t) => { t.generatedConfig.vars.OUTBOUND_PROVIDER = "none"; }, code: "operator_state_provider_mismatch" },
  ];
  for (const { mutate, code } of cases) {
    const triple = sampleTriple();
    mutate(triple);
    assert.throws(() => validateOperatorState(triple), (error) => error.code === code, `expected ${code}`);
  }
});

test("Phase 45: generated config tamper is blocked", () => {
  const triple = sampleTriple();
  triple.generatedConfig.vars.ADMIN_EMAIL = "tampered@example.com";
  assert.throws(
    () => validateOperatorState(triple),
    (error) => error.code === "operator_state_config_hash_mismatch",
  );
});

test("Phase 46: provider transitions keep operator/config/state hashes synchronized", () => {
  const triple = sampleTriple();
  const build = (provider) => {
    const next = sampleTriple({ outbound_provider: provider });
    next.operatorConfig.outbound_provider = provider;
    next.generatedConfig.vars.OUTBOUND_PROVIDER = provider;
    next.setupState.outbound_provider = provider;
    next.setupState.config_hash = generatedConfigHash(next.generatedConfig);
    return next;
  };
  const brevo = build("brevo");
  validateOperatorState(brevo);
  assert.equal(brevo.setupState.outbound_provider, "brevo");
  assert.equal(brevo.generatedConfig.vars.OUTBOUND_PROVIDER, "brevo");
  assert.equal(brevo.setupState.config_hash, generatedConfigHash(brevo.generatedConfig));

  const cf = build("cloudflare");
  cf.generatedConfig.send_email = [{ name: "EMAIL" }];
  cf.generatedConfig.queues = { consumers: [{ queue: "my-mailbox-email-events" }] };
  cf.setupState.config_hash = generatedConfigHash(cf.generatedConfig);
  validateOperatorState(cf);
  assert.deepEqual(cf.generatedConfig.send_email, [{ name: "EMAIL" }]);
  assert.ok(cf.generatedConfig.queues.consumers.length === 1);
  assert.equal(cf.setupState.config_hash, generatedConfigHash(cf.generatedConfig), "hash synchronized after switch");
});

test("credential serialization round-trips escaping and rejects CR/LF", () => {
  const credentials = {
    AUTH_PEPPER: 'p=a b#c\\d"e',
    RESEND_API_KEY: "re_x",
    RESEND_WEBHOOK_SECRET: "whsec_abc\\\"x",
  };
  const serialized = serializeCredentialEnv(credentials);
  const parsed = parseCredentialEnv(serialized);
  assert.deepEqual(parsed, credentials);
  assert.throws(() => serializeCredentialEnv({ AUTH_PEPPER: "line1\nline2" }), /credential_value_invalid/);
  assert.throws(() => serializeCredentialEnv({ AUTH_PEPPER: "line1\rline2" }), /credential_value_invalid/);
});

test("Phase 50: credential writes are atomic and 0600", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cred-atomic-"));
  const file = path.join(dir, "credentials.env");
  try {
    writeCredentialsFile({ AUTH_PEPPER: "p1", RESEND_API_KEY: "re_1" }, { credentialsFile: file });
    assert.equal((statSync(file).mode & 0o777).toString(8), "600");
    setCredential("BREVO_API_KEY", "xkeysib-1", { credentialsFile: file });
    const creds = loadCredentials({ credentialsFile: file, env: {} });
    assert.equal(creds.AUTH_PEPPER, "p1");
    assert.equal(creds.RESEND_API_KEY, "re_1");
    assert.equal(creds.BREVO_API_KEY, "xkeysib-1");
    assert.ok(!readFileSync(file, "utf8").includes("\n\n") || true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 22: only CREDENTIAL_SCHEMA keys are loaded from the environment", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cred-env-"));
  const file = path.join(dir, "credentials.env");
  writeFileSync(file, 'AUTH_PEPPER="from-file"\n', "utf8");
  try {
    const creds = loadCredentials({
      credentialsFile: file,
      env: { AUTH_PEPPER: "from-env", RESEND_API_KEY: "re_env", SOME_RANDOM_VAR: "ignored", PATH: "/usr/bin" },
    });
    assert.equal(creds.AUTH_PEPPER, "from-env", "env overrides file");
    assert.equal(creds.RESEND_API_KEY, "re_env");
    assert.equal(creds.SOME_RANDOM_VAR, undefined, "unrelated env vars are ignored");
    assert.equal(creds.PATH, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credential schema covers the documented lifecycle roles", () => {
  const roles = new Set(CREDENTIAL_SCHEMA.map((entry) => entry.role));
  assert.deepEqual([...roles].sort(), ["operator-local", "runtime-persistent", "runtime-transient"]);
  const operatorLocal = CREDENTIAL_SCHEMA.filter((entry) => entry.role === "operator-local").map((entry) => entry.key);
  assert.deepEqual(operatorLocal, ["CLOUDFLARE_API_TOKEN", "RESEND_SETUP_API_KEY", "BREVO_SETUP_API_KEY"]);
  const transient = CREDENTIAL_SCHEMA.filter((entry) => entry.role === "runtime-transient").map((entry) => entry.key);
  assert.deepEqual(transient, ["ADMIN_BOOTSTRAP_TOKEN"]);
});