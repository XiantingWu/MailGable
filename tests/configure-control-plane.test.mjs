// Configure control-plane semantics (Phase 1/2/5/19/35):
//   - in production mode CLOUDFLARE_API_TOKEN is ALWAYS collected/kept,
//     for every outbound provider (resend/brevo/cloudflare/none) — it is
//     a Cloudflare deployment/operator control-plane credential, not an
//     outbound-provider credential
//   - cloudflare_account_id / cloudflare_zone_id are required in production
//     regardless of outbound provider
//   - configure is idempotent: an already-stored credential is retained
//     without prompting; only --replace re-enters values, and it never
//     deletes keys the operator did not re-enter
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  credentialAction,
  secretCollectionOrder,
  collectSecrets,
} from "../scripts/configure.mjs";

const ROOT = process.cwd();
const ACCOUNT_ID = "a".repeat(32);
const ZONE_ID = "b".repeat(32);

function fixtureDir(provider) {
  const dir = mkdtempSync(path.join(tmpdir(), "configure-cp-"));
  mkdirSync(path.join(dir, ".mailbox"), { recursive: true });
  writeFileSync(path.join(dir, ".mailbox", "config.json"), JSON.stringify({
    mode: "production",
    worker_name: "cp-test",
    mail_domain: "mailgable-test.dev",
    admin_email: "admin@mailgable-test.dev",
    app_origin: "https://mail.mailgable-test.dev",
    cloudflare_account_id: ACCOUNT_ID,
    cloudflare_zone_id: ZONE_ID,
    outbound_provider: provider,
  }, null, 2), "utf8");
  return dir;
}

function childEnv(dir) {
  const env = { ...process.env, HOME: dir };
  delete env.MAILBOX_CREDENTIALS_FILE;
  delete env.MAILBOX_CONFIG_FILE;
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.RESEND_API_KEY;
  delete env.BREVO_API_KEY;
  return env;
}

function readCredentials(dir) {
  const file = path.join(dir, ".mailbox", "credentials.env");
  if (!existsSync(file)) return null;
  const entries = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)="(.*)"$/);
    if (match) entries[match[1]] = match[2].replace(/\\(["\\])/g, "$1");
  }
  return entries;
}

test("secretCollectionOrder always includes CLOUDFLARE_API_TOKEN in production", () => {
  for (const provider of ["resend", "brevo", "cloudflare", "none"]) {
    const order = secretCollectionOrder({ mode: "production", outbound_provider: provider });
    assert.ok(order.includes("CLOUDFLARE_API_TOKEN"), `control-plane token collected for outbound=${provider}`);
    assert.equal(order[0], "CLOUDFLARE_API_TOKEN", "control-plane token is asked first");
  }
  assert.ok(!secretCollectionOrder({ mode: "dev", outbound_provider: "none" }).includes("CLOUDFLARE_API_TOKEN"),
    "dev mode does not require the control-plane token");
});

test("collectSecrets asks CLOUDFLARE_API_TOKEN for every production provider and stores it", async () => {
  for (const provider of ["resend", "brevo", "cloudflare", "none"]) {
    const credentials = {};
    const asked = [];
    await collectSecrets({
      config: { mode: "production", outbound_provider: provider },
      credentials,
      prompt: async (name) => { asked.push(name); return `tok-${provider}-${name}`; },
    });
    assert.equal(credentials.CLOUDFLARE_API_TOKEN, `tok-${provider}-CLOUDFLARE_API_TOKEN`,
      `control-plane token collected for outbound=${provider}`);
  }
});

test("collectSecrets is idempotent: present credentials are kept without prompting", async () => {
  const credentials = { CLOUDFLARE_API_TOKEN: "existing", AUTH_PEPPER: "p" };
  const asked = [];
  await collectSecrets({
    config: { mode: "production", outbound_provider: "none" },
    credentials,
    prompt: async (name) => { asked.push(name); return "should-not-be-used"; },
  });
  assert.deepEqual(asked, ["CLOUDFLARE_ROUTING_READ_TOKEN", "ADMIN_BOOTSTRAP_TOKEN"],
    "only absent keys are prompted; PRESENT keys are kept without re-entry");
  assert.equal(credentials.CLOUDFLARE_API_TOKEN, "existing");
  assert.equal(credentials.AUTH_PEPPER, "p");
});

test("credentialAction: absent asks, present keeps, --replace re-asks", () => {
  const credentials = { AUTH_PEPPER: "p" };
  assert.equal(credentialAction("AUTH_PEPPER", credentials), "keep");
  assert.equal(credentialAction("AUTH_PEPPER", credentials, { replace: true }), "ask");
  assert.equal(credentialAction("BREVO_API_KEY", credentials), "ask");
  assert.equal(credentialAction("BREVO_API_KEY", credentials, { replace: true }), "ask");
});

test("collectSecrets --replace re-enters only answered keys and never deletes the rest", async () => {
  const credentials = {
    CLOUDFLARE_API_TOKEN: "old-token",
    AUTH_PEPPER: "old-pepper",
    CLOUDFLARE_ROUTING_READ_TOKEN: "old-rrt",
    ADMIN_BOOTSTRAP_TOKEN: "old-bootstrap",
  };
  const asked = [];
  await collectSecrets({
    config: { mode: "production", outbound_provider: "none" },
    credentials,
    replace: true,
    prompt: async (name) => {
      asked.push(name);
      return name === "CLOUDFLARE_API_TOKEN" ? "new-token" : "";
    },
  });
  assert.equal(credentials.CLOUDFLARE_API_TOKEN, "new-token", "--replace updates the answered key");
  assert.equal(credentials.AUTH_PEPPER, "old-pepper", "--replace keeps keys not re-entered");
  assert.equal(credentials.CLOUDFLARE_ROUTING_READ_TOKEN, "old-rrt", "--replace keeps optional keys not re-entered");
  assert.equal(credentials.ADMIN_BOOTSTRAP_TOKEN, "old-bootstrap", "--replace keeps transient keys not re-entered");
});

test("configure non-interactive requires cloudflare_account_id and cloudflare_zone_id", () => {
  const dir = fixtureDir("none");
  try {
    const bad = JSON.parse(readFileSync(path.join(dir, ".mailbox", "config.json"), "utf8"));
    delete bad.cloudflare_account_id;
    writeFileSync(path.join(dir, ".mailbox", "config.json"), JSON.stringify(bad), "utf8");
    const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/configure.mjs"), "--non-interactive"], {
      cwd: dir, encoding: "utf8", env: childEnv(dir),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cloudflare_account_id/, "missing account id reported in production");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configure non-interactive: dev mode does not require the account id", () => {
  const dir = fixtureDir("none");
  try {
    const dev = JSON.parse(readFileSync(path.join(dir, ".mailbox", "config.json"), "utf8"));
    dev.mode = "dev";
    delete dev.cloudflare_account_id;
    delete dev.cloudflare_zone_id;
    writeFileSync(path.join(dir, ".mailbox", "config.json"), JSON.stringify(dev), "utf8");
    writeFileSync(path.join(dir, ".mailbox", "credentials.env"), 'AUTH_PEPPER="dev-pepper"\n', "utf8");
    const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/configure.mjs"), "--non-interactive"], {
      cwd: dir, encoding: "utf8", env: childEnv(dir),
    });
    assert.equal(result.status, 0, `dev non-interactive configure failed:\n${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
