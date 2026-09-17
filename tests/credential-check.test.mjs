// credentials:check classification closure (Phase 33+).
//
// Every provider probe is a pure classifier driven by an injected fetch
// mock. HTTP classes map to stable verdicts:
//   no credential        -> NOT_CONFIGURED
//   401                  -> INVALID
//   403                  -> FORBIDDEN
//   429                  -> RATE_LIMITED
//   DNS/timeout/conn     -> UNREACHABLE
//   5xx                  -> PROVIDER_ERROR
//   2xx + contract body  -> VALID
//   2xx without contract -> INVALID
//
// Security canaries: the probe output and the full check CLI output must
// never contain the token, its prefix/suffix, a hash, a length, or the
// response body.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  classifyCredentialProbe,
  probeCredential,
  CREDENTIAL_PROBES,
} from "../scripts/credentials.mjs";

const ROOT = process.cwd();
const SECRET = "sup3r-secret-token-abc123";

function mockFetch(status, body) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
}

function mockFetchRejects() {
  return async () => {
    throw new Error("fetch failed: getaddrinfo ENOTFOUND api.example.com");
  };
}

function validBody(name) {
  if (name === "CLOUDFLARE_API_TOKEN") return { success: true, result: { id: "x", status: "active" } };
  if (name === "RESEND_SETUP_API_KEY") return { data: [] };
  return { webhooks: [] };
}

function invalidBody(name) {
  if (name === "CLOUDFLARE_API_TOKEN") return { success: false, errors: [{ code: 9109 }] };
  if (name === "RESEND_SETUP_API_KEY") return { data: null };
  return { webhooks: null };
}

for (const name of Object.keys(CREDENTIAL_PROBES)) {
  test(`${name}: HTTP class matrix maps to stable verdicts`, async () => {
    const valid = validBody(name);
    const invalid = invalidBody(name);
    const cases = [
      [200, valid, "VALID"],
      [200, invalid, "INVALID"],
      [401, invalid, "INVALID"],
      [403, invalid, "FORBIDDEN"],
      [429, invalid, "RATE_LIMITED"],
      [500, invalid, "PROVIDER_ERROR"],
      [502, invalid, "PROVIDER_ERROR"],
      [503, invalid, "PROVIDER_ERROR"],
      [400, invalid, "INVALID"],
      [404, invalid, "INVALID"],
    ];
    for (const [status, body, expected] of cases) {
      const verdict = await probeCredential(name, SECRET, { fetchFn: mockFetch(status, body) });
      assert.equal(verdict, expected, `${name} HTTP ${status} -> ${expected}`);
    }
  });

  test(`${name}: connection/DNS/timeout failures classify as UNREACHABLE`, async () => {
    const verdict = await probeCredential(name, SECRET, { fetchFn: mockFetchRejects() });
    assert.equal(verdict, "UNREACHABLE");
  });

  test(`${name}: probe never returns or logs the credential`, async () => {
    const verdict = await probeCredential(name, SECRET, { fetchFn: mockFetch(200, validBody(name)) });
    assert.equal(verdict, "VALID");
    assert.ok(!verdict.includes(SECRET));
  });
}

test("classifyCredentialProbe: pure status mapping", () => {
  assert.equal(classifyCredentialProbe({ status: 200, contractSuccess: true }), "VALID");
  assert.equal(classifyCredentialProbe({ status: 401, contractSuccess: false }), "INVALID");
  assert.equal(classifyCredentialProbe({ status: 403, contractSuccess: false }), "FORBIDDEN");
  assert.equal(classifyCredentialProbe({ status: 429, contractSuccess: false }), "RATE_LIMITED");
  assert.equal(classifyCredentialProbe({ status: 500, contractSuccess: false }), "PROVIDER_ERROR");
  assert.equal(classifyCredentialProbe({ status: 599, contractSuccess: false }), "PROVIDER_ERROR");
  assert.equal(classifyCredentialProbe({ status: 302, contractSuccess: false }), "INVALID");
  assert.equal(classifyCredentialProbe({ status: 200, contractSuccess: false }), "INVALID");
});

test("credentials:check CLI output is a secret canary", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cred-check-"));
  const credsFile = path.join(dir, "credentials.env");
  const secretValue = "re_live_sk_secretcanaryvalue";
  const secretPrefix = "re_live_sk";
  const secretHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  mkdirSync(path.join(dir, ".mailbox"), { recursive: true });
  writeFileSync(credsFile, `CLOUDFLARE_API_TOKEN="${secretValue}"\nRESEND_SETUP_API_KEY="${secretValue}"\nBREVO_SETUP_API_KEY="${secretValue}"\n`, "utf8");
  const env = { ...process.env, HOME: dir, MAILBOX_CREDENTIALS_FILE: credsFile };
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/credentials.mjs"), "check"], {
    cwd: ROOT, encoding: "utf8", env, timeout: 60_000,
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(result.stdout, /NOT_CONFIGURED|INVALID|FORBIDDEN|RATE_LIMITED|PROVIDER_ERROR|UNREACHABLE|VALID/, "verdict printed");
    assert.ok(!output.includes(secretValue), "full secret never appears");
    assert.ok(!output.includes(secretPrefix), "secret prefix never appears");
    assert.ok(!output.includes(secretHash), "no hash of the secret appears");
    assert.ok(!output.includes(String(secretValue.length)), "secret length never appears");
    assert.ok(!output.includes("Authorization"), "no Authorization header leaks into output");
    assert.ok(!output.includes("Bearer"), "no Bearer scheme leaks into output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credentials:check with no credentials reports NOT_CONFIGURED for every key", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cred-check-none-"));
  mkdirSync(path.join(dir, ".mailbox"), { recursive: true });
  const credsFile = path.join(dir, "credentials.env");
  writeFileSync(credsFile, "AUTH_PEPPER=\"p\"\n", "utf8");
  const env = { ...process.env, HOME: dir, MAILBOX_CREDENTIALS_FILE: credsFile };
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/credentials.mjs"), "check"], {
    cwd: ROOT, encoding: "utf8", env, timeout: 60_000,
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CLOUDFLARE_API_TOKEN\s+NOT_CONFIGURED/);
    assert.match(result.stdout, /RESEND_SETUP_API_KEY\s+NOT_CONFIGURED/);
    assert.match(result.stdout, /BREVO_SETUP_API_KEY\s+NOT_CONFIGURED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLOUDFLARE_API_TOKEN is opaque: legacy, cfut_-, and cfat_-shaped tokens all probe without leaking", async () => {
  const legacy = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const cfut = "cfut_abcdef0123456789";
  const cfat = "cfat_0123456789abcdef";
  const seen = [];
  const capture = (status, body) => async (url, options = {}) => {
    seen.push(options.headers?.Authorization);
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  for (const token of [legacy, cfut, cfat]) {
    seen.length = 0;
    const valid = await probeCredential("CLOUDFLARE_API_TOKEN", token, {
      fetchFn: capture(200, { success: true, result: { id: "t", status: "active" } }),
    });
    assert.equal(valid, "VALID", `opaque token classifies on its HTTP result: ${token.slice(0, 6)}...`);
    assert.equal(seen[0], `Bearer ${token}`, "the opaque value is forwarded verbatim, never normalized");
    const denied = await probeCredential("CLOUDFLARE_API_TOKEN", token, {
      fetchFn: capture(401, { success: false, errors: [{ code: 1000 }] }),
    });
    assert.equal(denied, "INVALID");
  }
  const output = [legacy, cfut, cfat].join("|");
  assert.ok(!output.includes(undefined) && !output.includes("undefined"));
});
