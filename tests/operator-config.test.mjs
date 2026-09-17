// Single-operator-config-loader closure (Phase 1/2/17/35):
//   - the only parser lives in scripts/config/operator-config.mjs
//   - MAILBOX_CONFIG_FILE overrides the default .mailbox/config.json
//   - ENOENT loads as {}; malformed JSON and I/O errors hard-fail
//   - canonicalOperatorConfig drops unknown keys
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  loadOperatorConfig,
  canonicalOperatorConfig,
  validateOperatorConfig,
  OPERATOR_CONFIG_KEYS,
} from "../scripts/config/operator-config.mjs";

const ROOT = process.cwd();

function writeFixture(fields = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "operator-config-"));
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify({
    mode: "production",
    worker_name: "mb-test",
    mail_domain: "mailgable-test.dev",
    admin_email: "admin@mailgable-test.dev",
    app_origin: "https://mail.mailgable-test.dev",
    cloudflare_zone_id: "a".repeat(32),
    cloudflare_account_id: "a".repeat(32),
    outbound_provider: "resend",
    ...fields,
  }, null, 2), "utf8");
  return { dir, file };
}

test("loadOperatorConfig reads MAILBOX_CONFIG_FILE override", () => {
  const { dir, file } = writeFixture();
  try {
    const config = loadOperatorConfig({ env: { MAILBOX_CONFIG_FILE: file } });
    assert.equal(config.worker_name, "mb-test");
    assert.equal(config.outbound_provider, "resend");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOperatorConfig honors an explicit configFile over env and default", () => {
  const { dir, file } = writeFixture({ worker_name: "explicit-name" });
  try {
    const config = loadOperatorConfig({ env: { MAILBOX_CONFIG_FILE: "/nonexistent/other.json" }, configFile: file });
    assert.equal(config.worker_name, "explicit-name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOperatorConfig default .mailbox/config.json resolves from cwd", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "operator-config-default-"));
  try {
    mkdirSync(path.join(dir, ".mailbox"), { recursive: true });
    writeFileSync(path.join(dir, ".mailbox", "config.json"), JSON.stringify({ worker_name: "default-name", mode: "dev" }), "utf8");
    const probe = `
      import { loadOperatorConfig } from ${JSON.stringify(`file://${path.join(ROOT, "scripts/config/operator-config.mjs")}`)};
      const config = loadOperatorConfig();
      console.log(JSON.stringify(config));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(config.worker_name, "default-name", "the default .mailbox/config.json is read with no override");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOperatorConfig ENOENT loads an empty object", () => {
  const config = loadOperatorConfig({ configFile: "/nonexistent/operator/config.json" });
  assert.deepEqual(config, {});
});

test("loadOperatorConfig malformed JSON hard-fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "operator-config-badjson-"));
  const file = path.join(dir, "config.json");
  writeFileSync(file, "{ not valid json !!!", "utf8");
  try {
    assert.throws(() => loadOperatorConfig({ configFile: file }), SyntaxError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOperatorConfig I/O error (directory path) hard-fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "operator-config-iodir-"));
  try {
    assert.throws(() => loadOperatorConfig({ configFile: dir }), (error) => error.code === "EISDIR" || error.code === "EACCES");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOperatorConfig unreadable file (non-ENOENT) hard-fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "operator-config-eacces-"));
  const file = path.join(dir, "config.json");
  writeFileSync(file, '{"worker_name":"x"}', "utf8");
  try {
    if (process.getuid && process.getuid() !== 0) {
      chmodSync(file, 0o000);
      try {
        assert.throws(() => loadOperatorConfig({ configFile: file }));
      } finally {
        chmodSync(file, 0o600);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonicalOperatorConfig drops unknown keys and keeps schema keys", () => {
  const canonical = canonicalOperatorConfig({
    mode: "production",
    worker_name: "mb",
    mail_domain: "mailgable-test.dev",
    admin_email: "a@b.dev",
    app_origin: "https://mail.mailgable-test.dev",
    cloudflare_zone_id: "a".repeat(32),
    cloudflare_account_id: "a".repeat(32),
    outbound_provider: "resend",
    d1_name: "mb-db",
    r2_name: "mb-r2",
    zone_id: "stale-legacy",
    database_id: "stale-legacy",
    some_unknown_key: "must-vanish",
  });
  assert.deepEqual(Object.keys(canonical).sort(), [...OPERATOR_CONFIG_KEYS].sort());
  assert.equal(canonical.zone_id, undefined, "legacy zone_id must be dropped");
  assert.equal(canonical.database_id, undefined, "resource state must be dropped");
  assert.equal(canonical.some_unknown_key, undefined);
});

test("validateOperatorConfig requires cloudflare_account_id in production", () => {
  const base = {
    mode: "production",
    worker_name: "mb",
    mail_domain: "mailgable-test.dev",
    admin_email: "a@b.dev",
    app_origin: "https://mail.mailgable-test.dev",
    cloudflare_zone_id: "a".repeat(32),
    outbound_provider: "resend",
  };
  assert.equal(validateOperatorConfig({ ...base, cloudflare_account_id: "a".repeat(32) }).ok, true);
  assert.equal(validateOperatorConfig({ ...base }).ok, false, "production without account id fails");
  assert.equal(validateOperatorConfig({ ...base, cloudflare_account_id: "0".repeat(32) }).ok, false, "all-zero account id fails");
  assert.equal(validateOperatorConfig({ ...base, cloudflare_account_id: "z".repeat(32) }).ok, false, "non-hex account id fails");
  const dev = validateOperatorConfig({ mode: "dev", worker_name: "mb", mail_domain: "mailgable-test.dev", admin_email: "a@b.dev", app_origin: "https://mail.mailgable-test.dev", cloudflare_zone_id: "a".repeat(32) });
  assert.equal(dev.ok, true, "dev mode does not require the account id");
});
