import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, stat, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadCredentials,
  parseCredentialsEnv,
  providerActiveCredentials,
  setCredentialsFilePermissions,
  setCredential,
  serializeCredentialEnv,
  OPERATOR_LOCAL_CREDENTIALS,
} from "../scripts/config/credentials.mjs";

test("parseCredentialsEnv parses KEY=\"value\" lines, rejects unknown keys, malformed, duplicate", () => {
  assert.deepEqual(
    parseCredentialsEnv('AUTH_PEPPER="1"\nRESEND_API_KEY="two words"\n# comment\nBREVO_API_KEY=\n'),
    { AUTH_PEPPER: "1", RESEND_API_KEY: "two words", BREVO_API_KEY: "" },
  );
  assert.throws(() => parseCredentialsEnv("UNKNOWN_TOKEN=x\n"), /credential_key_unknown/);
  assert.throws(() => parseCredentialsEnv("AUTH_PEPPER=1\nnot-a-key=x\n"), /malformed/);
  assert.throws(() => parseCredentialsEnv("AUTH_PEPPER=1\nAUTH_PEPPER=2\n"), /duplicate/);
});

test("setCredential and serialize reject unknown keys", () => {
  assert.throws(() => setCredential("UNKNOWN_TOKEN", "x"), /credential_key_unknown/);
  assert.throws(() => serializeCredentialEnv({ UNKNOWN_TOKEN: "x" }), /credential_key_unknown/);
});

test("loadCredentials precedence: process env overrides file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mailbox-cred-"));
  const file = path.join(dir, "credentials.env");
  await writeFile(file, 'AUTH_PEPPER="from-file"\nRESEND_API_KEY="file-key"\n');
  try {
    const fromFile = loadCredentials({ env: {}, credentialsFile: file });
    assert.equal(fromFile.AUTH_PEPPER, "from-file");
    const overridden = loadCredentials({ env: { AUTH_PEPPER: "from-env" }, credentialsFile: file });
    assert.equal(overridden.AUTH_PEPPER, "from-env");
    assert.equal(overridden.RESEND_API_KEY, "file-key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing credentials file loads empty without error", () => {
  assert.deepEqual(loadCredentials({ env: {}, credentialsFile: "/nonexistent/creds.env" }), {});
});

test("credential file is created with 0600 permissions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mailbox-cred-mode-"));
  const file = path.join(dir, "credentials.env");
  await writeFile(file, "AUTH_PEPPER=x\n");
  await chmod(file, 0o644);
  try {
    setCredentialsFilePermissions(file);
    const mode = (await stat(file)).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("providerActiveCredentials selects common + active provider only", () => {
  const credentials = {
    AUTH_PEPPER: "p",
    CLOUDFLARE_ROUTING_READ_TOKEN: "r",
    RESEND_API_KEY: "rk",
    RESEND_WEBHOOK_SECRET: "rs",
    BREVO_API_KEY: "bk",
    BREVO_WEBHOOK_TOKEN: "bt",
    CLOUDFLARE_API_TOKEN: "setup-token",
  };
  const resend = providerActiveCredentials("resend", credentials);
  assert.deepEqual(Object.keys(resend).sort(), ["AUTH_PEPPER", "CLOUDFLARE_ROUTING_READ_TOKEN", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"]);
  assert.equal(resend.BREVO_API_KEY, undefined);
  const brevo = providerActiveCredentials("brevo", credentials);
  assert.deepEqual(Object.keys(brevo).sort(), ["AUTH_PEPPER", "BREVO_API_KEY", "BREVO_WEBHOOK_TOKEN", "CLOUDFLARE_ROUTING_READ_TOKEN"]);
  const none = providerActiveCredentials("none", credentials);
  assert.deepEqual(Object.keys(none).sort(), ["AUTH_PEPPER", "CLOUDFLARE_ROUTING_READ_TOKEN"]);
  const cloudflare = providerActiveCredentials("cloudflare", credentials);
  assert.deepEqual(Object.keys(cloudflare).sort(), ["AUTH_PEPPER", "CLOUDFLARE_ROUTING_READ_TOKEN"]);
  assert.ok(!("CLOUDFLARE_API_TOKEN" in none), "operator-local credentials are never runtime secrets");
});

test("operator-local credentials are never runtime-uploaded", () => {
  assert.deepEqual([...OPERATOR_LOCAL_CREDENTIALS].sort(), ["BREVO_SETUP_API_KEY", "CLOUDFLARE_API_TOKEN", "RESEND_SETUP_API_KEY"]);
});

test("setCredential ENOENT: missing file is an empty store, new credential written normally", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mailbox-set-absent-"));
  const file = path.join(dir, "credentials.env");
  try {
    setCredential("BREVO_API_KEY", "xkeysib-new", { credentialsFile: file });
    const creds = loadCredentials({ env: {}, credentialsFile: file });
    assert.equal(creds.BREVO_API_KEY, "xkeysib-new");
    assert.equal(creds.AUTH_PEPPER, undefined, "no phantom keys from an absent store");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setCredential malformed store: throws and the original file is byte-for-byte unchanged", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mailbox-set-malformed-"));
  const file = path.join(dir, "credentials.env");
  const broken = 'AUTH_PEPPER="p"\nTHIS IS NOT A CREDENTIAL LINE\n';
  await writeFile(file, broken, "utf8");
  try {
    assert.throws(() => setCredential("BREVO_API_KEY", "xkeysib-new", { credentialsFile: file }), /refusing to modify/);
    const after = await readFile(file, "utf8");
    assert.equal(after, broken, "malformed store must never be overwritten");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setCredential duplicate key store: throws and the original file is unchanged", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mailbox-set-dup-"));
  const file = path.join(dir, "credentials.env");
  const broken = 'AUTH_PEPPER="1"\nAUTH_PEPPER="2"\n';
  await writeFile(file, broken, "utf8");
  try {
    assert.throws(() => setCredential("BREVO_API_KEY", "xkeysib-new", { credentialsFile: file }), /refusing to modify/);
    const after = await readFile(file, "utf8");
    assert.equal(after, broken, "duplicate-key store must never be overwritten");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setCredential unknown key: throws before any read or write", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mailbox-set-unknown-"));
  const file = path.join(dir, "credentials.env");
  const original = 'AUTH_PEPPER="p"\n';
  await writeFile(file, original, "utf8");
  try {
    assert.throws(() => setCredential("SECRET_DB_PASSWORD", "x", { credentialsFile: file }), /credential_key_unknown/);
    const after = await readFile(file, "utf8");
    assert.equal(after, original, "unknown key must not touch the store");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setCredential read error (non-ENOENT): throws and never falls back to an empty store", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mailbox-set-readerr-"));
  try {
    const file = path.join(dir, "credentials.env");
    await writeFile(file, 'AUTH_PEPPER="p"\n', "utf8");
    await chmod(file, 0o000);
    try {
      assert.throws(() => setCredential("BREVO_API_KEY", "xkeysib-new", { credentialsFile: file }), /refusing to modify/);
    } finally {
      await chmod(file, 0o600);
    }
    const after = await readFile(file, "utf8");
    assert.equal(after, 'AUTH_PEPPER="p"\n', "unreadable store must be preserved");
    assert.ok(!(await readFile(file, "utf8")).includes("xkeysib-new"), "no partial write to an unreadable store");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setCredential read error on a directory path: hard-fails, never an empty store", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mailbox-set-eisdir-"));
  try {
    assert.throws(() => setCredential("BREVO_API_KEY", "xkeysib-new", { credentialsFile: dir }), /refusing to modify/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setCredential update keeps every other key identical (round-trip)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mailbox-set-multi-"));
  const file = path.join(dir, "credentials.env");
  const seeded = {
    AUTH_PEPPER: "pepper-1",
    CLOUDFLARE_API_TOKEN: "cf-1",
    RESEND_API_KEY: "re_1",
    RESEND_WEBHOOK_SECRET: "whsec_1",
    BREVO_API_KEY: "xkeysib-1",
    BREVO_WEBHOOK_TOKEN: "wh-token-1",
    CLOUDFLARE_ROUTING_READ_TOKEN: "rrt-1",
  };
  await writeFile(file, serializeCredentialEnv(seeded), "utf8");
  try {
    setCredential("BREVO_API_KEY", "xkeysib-rotated", { credentialsFile: file });
    const rotated = loadCredentials({ env: {}, credentialsFile: file });
    assert.equal(rotated.BREVO_API_KEY, "xkeysib-rotated", "the updated key carries the new value");
    for (const [key, value] of Object.entries(seeded)) {
      if (key !== "BREVO_API_KEY") {
        assert.equal(rotated[key], value, `${key} must be preserved verbatim`);
      }
    }
    const serialized = await readFile(file, "utf8");
    const reparsed = parseCredentialsEnv(serialized);
    for (const [key, value] of Object.entries(seeded)) {
      if (key !== "BREVO_API_KEY") assert.equal(reparsed[key], value, `${key} round-trips identically`);
    }
    assert.equal(reparsed.BREVO_API_KEY, "xkeysib-rotated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});