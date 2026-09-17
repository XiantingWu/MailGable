// credentials:status source column closure (Phase 22+).
//
// The loader reports provenance per key: file (central store, including a
// custom MAILBOX_CREDENTIALS_FILE), env (process environment wins), or
// absent. The status CLI shows READY/ABSENT + lifecycle role + source and
// is a secret canary: value, prefix, suffix, hash, and length never appear
// on stdout/stderr, and no file path leaks the user's directory layout.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { credentialSources } from "../scripts/config/credentials.mjs";

const ROOT = process.cwd();

test("credentialSources reports file/env/absent per key", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cred-src-"));
  const file = path.join(dir, "credentials.env");
  writeFileSync(file, 'AUTH_PEPPER="from-file"\nRESEND_API_KEY="re_file"\n', "utf8");
  try {
    const sources = credentialSources({
      env: { AUTH_PEPPER: "from-env", RESEND_SETUP_API_KEY: "re_env" },
      credentialsFile: file,
    });
    assert.equal(sources.AUTH_PEPPER, "env", "process env wins over the file");
    assert.equal(sources.RESEND_API_KEY, "file", "file-only key is file");
    assert.equal(sources.RESEND_SETUP_API_KEY, "env", "env-only key is env");
    assert.equal(sources.BREVO_API_KEY, "absent", "unset key is absent");
    assert.equal(sources.CLOUDFLARE_API_TOKEN, "absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credentialSources: MAILBOX_CREDENTIALS_FILE is reported as file, never as a path", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cred-src-custom-"));
  const custom = path.join(dir, "custom", "secrets", "credentials.env");
  mkdirSync(path.dirname(custom), { recursive: true });
  writeFileSync(custom, 'CLOUDFLARE_API_TOKEN="cf-custom"\n', "utf8");
  try {
    const sources = credentialSources({ env: { MAILBOX_CREDENTIALS_FILE: custom }, credentialsFile: "" });
    assert.equal(sources.CLOUDFLARE_API_TOKEN, "file", "custom file counts as file");
    const values = Object.values(sources).filter((value) => value === "file").length;
    assert.equal(values, 1);
    assert.ok(!JSON.stringify(sources).includes(custom), "the custom file path must never be reported");
    assert.ok(!JSON.stringify(sources).includes("custom"), "no directory fragment leaks");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credentials:status CLI prints source=file/env/absent and is a secret canary", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cred-status-"));
  const file = path.join(dir, "credentials.env");
  const secretValue = "re_secret_status_value_987654321";
  const secretPrefix = "re_secret";
  const secretHash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `CLOUDFLARE_API_TOKEN="${secretValue}"\nAUTH_PEPPER="${secretValue}"\nBREVO_API_KEY="${secretValue}"\n`, "utf8");
  const env = { ...process.env, MAILBOX_CREDENTIALS_FILE: file, CLOUDFLARE_ROUTING_READ_TOKEN: secretValue };
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/credentials.mjs"), "status"], {
    cwd: ROOT, encoding: "utf8", env, timeout: 60_000,
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(result.stdout, /CLOUDFLARE_API_TOKEN\s+READY\s+operator-local\s+source=file/);
    assert.match(result.stdout, /CLOUDFLARE_ROUTING_READ_TOKEN\s+READY\s+runtime-persistent\s+source=env/);
    assert.match(result.stdout, /RESEND_API_KEY\s+ABSENT\s+runtime-persistent\s+source=absent/);
    assert.ok(!output.includes(secretValue), "secret value never appears");
    assert.ok(!output.includes(secretPrefix), "secret prefix never appears");
    assert.ok(!output.includes(secretHash), "no hash of the secret appears");
    assert.ok(!output.includes(String(secretValue.length)), "secret length never appears");
    assert.ok(!output.includes(dir), "no credential file path leaks");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
