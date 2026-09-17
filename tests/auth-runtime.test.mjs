import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import * as lib from "../.test-build/src/lib.js";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = await readFile("src/auth.ts", "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
});
const loaded = { exports: {} };
new Function("module", "exports", "require", transpiled.outputText)(loaded, loaded.exports, (request) => {
  if (request === "./lib" || request === "./lib.js") return lib;
  return require(request);
});
const { authStatus, bootstrap, changePassword, getSession, login, requireSession, passwordDigest, legacyPasswordDigest, normalizePassword } = loaded.exports;

class Prepared {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Prepared(this.database, this.sql, values);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) || null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class D1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new Prepared(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

async function testEnvironment() {
  const database = new DatabaseSync(":memory:");
  database.exec(await readFile("migrations/0001_mailbox.sql", "utf8"));
  database.exec(await readFile("migrations/0002_mailbox_hardening.sql", "utf8"));
  database.exec(await readFile("migrations/0003_mailbox_reply_safety.sql", "utf8"));
  database.exec(await readFile("migrations/0004_ops_probe.sql", "utf8"));
  database.exec(await readFile("migrations/0005_admin_password_iterations.sql", "utf8"));
  database.exec(await readFile("migrations/0006_routing_managed_mailboxes.sql", "utf8"));
  database.exec(await readFile("migrations/0007_inbound_forward_attempts.sql", "utf8"));
  database.exec(await readFile("migrations/0008_thread_status_archived.sql", "utf8"));
  database.exec(await readFile("migrations/0009_password_scheme_audit_index.sql", "utf8"));
  database.exec(await readFile("migrations/0010_thread_summaries.sql", "utf8"));
  database.exec(await readFile("migrations/0011_outbound_providers.sql", "utf8"));
  return {
    database,
    env: {
      DB: new D1Adapter(database),
      APP_ORIGIN: "https://mailgable-dev.example.workers.dev",
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_BOOTSTRAP_TOKEN: "bootstrap-token-with-sufficient-entropy",
      AUTH_PEPPER: "p".repeat(64),
      PASSWORD_ITERATIONS: "8000",
      SESSION_HOURS: "12",
    },
  };
}

function request(path, { body, cookie, csrf, bootstrapToken, origin = "https://mailgable-dev.example.workers.dev" } = {}) {
  const headers = new Headers({
    Origin: origin,
    "User-Agent": "Mailbox-Test/1.0",
    "CF-Connecting-IP": "203.0.113.10",
  });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (cookie) headers.set("Cookie", cookie);
  if (csrf) headers.set("X-CSRF-Token", csrf);
  if (bootstrapToken) headers.set("X-Bootstrap-Token", bootstrapToken);
  return new Request(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function cookieFrom(response) {
  return (response.headers.get("Set-Cookie") || "").split(";", 1)[0];
}

test("administrator bootstrap, CSRF, password rotation, and session revocation work end to end", async () => {
  const { database, env } = await testEnvironment();
  const firstPassword = "Initial-Admin-Password-2026!";
  const finalPassword = "Final-Admin-Password-2026!";
  try {
    const before = await authStatus(request("/api/admin/mail/auth/status"), env);
    assert.deepEqual(await before.json(), {
      initialized: false,
      authenticated: false,
      email: null,
      csrf_token: null,
    });

    const initialized = await bootstrap(request("/api/admin/mail/auth/bootstrap", {
      bootstrapToken: env.ADMIN_BOOTSTRAP_TOKEN,
      body: { email: env.ADMIN_EMAIL, password: firstPassword },
    }), env);
    assert.equal(initialized.status, 200);
    const initializedBody = await initialized.json();
    const cookie = cookieFrom(initialized);
    assert.ok(cookie.startsWith(`${lib.SESSION_COOKIE_NAME}=`));
    assert.ok(initialized.headers.get("Set-Cookie").includes("HttpOnly"));
    assert.ok(initialized.headers.get("Set-Cookie").includes("Secure"));
    assert.ok(initialized.headers.get("Set-Cookie").includes("SameSite=Strict"));
    assert.ok(initializedBody.csrf_token);

    const session = await getSession(request("/api/admin/mail/config", { cookie }), env);
    assert.equal(session.email, env.ADMIN_EMAIL);

    await assert.rejects(
      requireSession(request("/api/admin/mail/messages/send", { cookie, csrf: "wrong-token", body: {} }), env, true),
      (error) => error?.code === "csrf_invalid",
    );
    await assert.rejects(
      requireSession(request("/api/admin/mail/messages/send", { cookie, csrf: initializedBody.csrf_token, origin: "https://attacker.example", body: {} }), env, true),
      (error) => error?.code === "origin_denied",
    );

    const authorizedRequest = request("/api/admin/mail/auth/password", {
      cookie,
      csrf: initializedBody.csrf_token,
      body: { current_password: firstPassword, new_password: finalPassword },
    });
    const authorized = await requireSession(authorizedRequest, env, true);
    const changed = await changePassword(authorizedRequest, env, authorized);
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).reauthenticate, true);
    assert.equal(await getSession(request("/api/admin/mail/config", { cookie }), env), null);

    await assert.rejects(
      login(request("/api/admin/mail/auth/login", { body: { email: env.ADMIN_EMAIL, password: firstPassword } }), env),
      (error) => error?.code === "invalid_credentials",
    );

    const relogin = await login(request("/api/admin/mail/auth/login", { body: { email: env.ADMIN_EMAIL, password: finalPassword } }), env);
    assert.equal(relogin.status, 200);
    const reloginBody = await relogin.json();
    assert.equal(reloginBody.authenticated, true);
    assert.ok(reloginBody.csrf_token);

    const admin = database.prepare("SELECT password_iterations FROM admins WHERE email=?").get(env.ADMIN_EMAIL);
    assert.equal(Number(admin.password_iterations), 8000);
    const active = database.prepare("SELECT COUNT(*) AS count FROM admin_sessions WHERE revoked_at IS NULL").get();
    assert.equal(Number(active.count), 1);
  } finally {
    database.close();
  }
});

test("enforces a 15-character minimum and rejects over-length passwords without truncation", async () => {
  const { database, env } = await testEnvironment();
  const shortPassword = "x";
  const passphrase = "correct horse battery staple 2026";
  const overlong = "a".repeat(129);
  try {
    await assert.rejects(
      bootstrap(request("/api/admin/mail/auth/bootstrap", {
        bootstrapToken: env.ADMIN_BOOTSTRAP_TOKEN,
        body: { email: env.ADMIN_EMAIL, password: "" },
      }), env),
      (error) => error?.code === "invalid_password",
    );

    await assert.rejects(
      bootstrap(request("/api/admin/mail/auth/bootstrap", {
        bootstrapToken: env.ADMIN_BOOTSTRAP_TOKEN,
        body: { email: env.ADMIN_EMAIL, password: shortPassword },
      }), env),
      (error) => error?.code === "invalid_password",
      "short passwords must be rejected",
    );

    await assert.rejects(
      bootstrap(request("/api/admin/mail/auth/bootstrap", {
        bootstrapToken: env.ADMIN_BOOTSTRAP_TOKEN,
        body: { email: env.ADMIN_EMAIL, password: overlong },
      }), env),
      (error) => error?.code === "password_too_long",
      "over-length passwords must be rejected, not truncated",
    );

    const initialized = await bootstrap(request("/api/admin/mail/auth/bootstrap", {
      bootstrapToken: env.ADMIN_BOOTSTRAP_TOKEN,
      body: { email: env.ADMIN_EMAIL, password: passphrase },
    }), env);
    assert.equal(initialized.status, 200);
    const admin = database.prepare("SELECT password_hash FROM admins WHERE email=?").get(env.ADMIN_EMAIL);
    assert.notEqual(admin.password_hash, passphrase);

    const loggedIn = await login(request("/api/admin/mail/auth/login", {
      body: { email: env.ADMIN_EMAIL, password: passphrase },
    }), env);
    assert.equal(loggedIn.status, 200);
    assert.equal((await loggedIn.json()).authenticated, true);
  } finally {
    database.close();
  }
});

test("AUTH_PEPPER fails closed across bootstrap, login, and session validation", async () => {
  const passphrase = "correct horse battery staple 2026";

  const noPepper = await testEnvironment();
  delete noPepper.env.AUTH_PEPPER;
  try {
    await assert.rejects(
      bootstrap(request("/api/admin/mail/auth/bootstrap", {
        bootstrapToken: noPepper.env.ADMIN_BOOTSTRAP_TOKEN,
        body: { email: noPepper.env.ADMIN_EMAIL, password: passphrase },
      }), noPepper.env),
      (error) => error?.code === "auth_not_configured",
      "bootstrap without AUTH_PEPPER must fail closed",
    );
  } finally {
    noPepper.database.close();
  }

  const shortPepper = await testEnvironment();
  shortPepper.env.AUTH_PEPPER = "short";
  try {
    await assert.rejects(
      bootstrap(request("/api/admin/mail/auth/bootstrap", {
        bootstrapToken: shortPepper.env.ADMIN_BOOTSTRAP_TOKEN,
        body: { email: shortPepper.env.ADMIN_EMAIL, password: passphrase },
      }), shortPepper.env),
      (error) => error?.code === "auth_not_configured",
      "short AUTH_PEPPER must fail closed",
    );
  } finally {
    shortPepper.database.close();
  }

  const withPepper = await testEnvironment();
  try {
    const initialized = await bootstrap(request("/api/admin/mail/auth/bootstrap", {
      bootstrapToken: withPepper.env.ADMIN_BOOTSTRAP_TOKEN,
      body: { email: withPepper.env.ADMIN_EMAIL, password: passphrase },
    }), withPepper.env);
    assert.equal(initialized.status, 200);
    const cookie = cookieFrom(initialized);

    const removedPepper = { ...withPepper.env };
    delete removedPepper.AUTH_PEPPER;
    await assert.rejects(
      login(request("/api/admin/mail/auth/login", {
        body: { email: withPepper.env.ADMIN_EMAIL, password: passphrase },
      }), removedPepper),
      (error) => error?.code === "auth_not_configured",
      "login after initialized DB with missing AUTH_PEPPER must fail closed",
    );
    await assert.rejects(
      getSession(request("/api/admin/mail/config", { cookie }), removedPepper),
      (error) => error?.code === "auth_not_configured",
      "session validation with missing AUTH_PEPPER must fail closed",
    );

    const stillValid = await getSession(request("/api/admin/mail/config", { cookie }), withPepper.env);
    assert.ok(stillValid, "valid AUTH_PEPPER keeps sessions working");
  } finally {
    withPepper.database.close();
  }
});

test("AUTH_PEPPER is cryptographically bound into the password verifier", async () => {
  const salt = new Uint8Array(16);
  salt.fill(7);
  const iterations = 8000;
  const pepperA = { AUTH_PEPPER: "a".repeat(32) };
  const pepperB = { AUTH_PEPPER: "b".repeat(32) };
  const hashA = await passwordDigest("same-passphrase-2026", salt, iterations, pepperA);
  const hashB = await passwordDigest("same-passphrase-2026", salt, iterations, pepperB);
  assert.notEqual(hashA, hashB, "identical password/salt/iterations must produce different hashes for different peppers");
  const repeatA = await passwordDigest("same-passphrase-2026", salt, iterations, pepperA);
  assert.equal(repeatA, hashA, "same pepper is deterministic");
  const noPepper = {};
  await assert.rejects(
    passwordDigest("same-passphrase-2026", salt, iterations, noPepper),
    (error) => error?.code === "auth_not_configured",
  );
});

test("password policy counts Unicode code points after NFC normalization", async () => {
  const { database, env } = await testEnvironment();
  const shortAscii = "a".repeat(14);
  const fiveChinese = "中".repeat(5);
  const fifteenChinese = "中".repeat(15);
  const emojiPassphrase = "🙂".repeat(15) + " 2026";
  const overMaxCodePoints = "x".repeat(129);
  const overMaxBytes = "🙂".repeat(129);
  const decomposed = "e\u0301".repeat(15);
  const composed = "é".repeat(15);
  try {
    for (const password of [shortAscii, fiveChinese]) {
      await assert.rejects(
        bootstrap(request("/api/admin/mail/auth/bootstrap", {
          bootstrapToken: env.ADMIN_BOOTSTRAP_TOKEN,
          body: { email: env.ADMIN_EMAIL, password },
        }), env),
        (error) => error?.code === "invalid_password",
        `expected rejection for ${JSON.stringify(password)}`,
      );
    }
    for (const password of [overMaxCodePoints, overMaxBytes]) {
      await assert.rejects(
        bootstrap(request("/api/admin/mail/auth/bootstrap", {
          bootstrapToken: env.ADMIN_BOOTSTRAP_TOKEN,
          body: { email: env.ADMIN_EMAIL, password },
        }), env),
        (error) => error?.code === "password_too_long",
        `expected length rejection for ${password.length} code points`,
      );
    }

    const normalized = normalizePassword(decomposed);
    assert.equal(normalized, composed, "NFC normalization must make decomposed input deterministic");

    const initialized = await bootstrap(request("/api/admin/mail/auth/bootstrap", {
      bootstrapToken: env.ADMIN_BOOTSTRAP_TOKEN,
      body: { email: env.ADMIN_EMAIL, password: fifteenChinese },
    }), env);
    assert.equal(initialized.status, 200);
    const loggedIn = await login(request("/api/admin/mail/auth/login", {
      body: { email: env.ADMIN_EMAIL, password: fifteenChinese },
    }), env);
    assert.equal(loggedIn.status, 200);

    const admin = database.prepare("SELECT password_scheme FROM admins WHERE email=?").get(env.ADMIN_EMAIL);
    assert.equal(admin.password_scheme, "pbkdf2-sha256+hmac-sha256-v1");
  } finally {
    database.close();
  }
});

test("legacy password hashes verify and upgrade to the peppered scheme", async () => {
  const { database, env } = await testEnvironment();
  const passphrase = "legacy-passphrase-2026";
  const salt = new Uint8Array(16);
  salt.fill(9);
  const legacy = await legacyPasswordDigest(passphrase, salt, 8000);
  database.prepare(
    "INSERT INTO admins(admin_id,email,password_hash,password_salt,password_iterations,password_scheme,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run("legacy-admin", "legacy@example.com", legacy, lib.base64Url(salt), 8000, "pbkdf2-sha256-legacy", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  try {
    const loggedIn = await login(request("/api/admin/mail/auth/login", {
      body: { email: "legacy@example.com", password: passphrase },
    }), env);
    assert.equal(loggedIn.status, 200);
    const admin = database.prepare("SELECT password_scheme,password_hash FROM admins WHERE email=?").get("legacy@example.com");
    assert.equal(admin.password_scheme, "pbkdf2-sha256+hmac-sha256-v1", "legacy hash must be upgraded to v1");
    assert.notEqual(admin.password_hash, legacy, "hash must be re-derived with the peppered scheme");
  } finally {
    database.close();
  }
});

test("pre-bootstrap auth status discloses no administrator email", async () => {
  const { database, env } = await testEnvironment();
  try {
    const status = await authStatus(request("/api/admin/mail/auth/status"), env);
    const body = await status.json();
    assert.equal(body.initialized, false);
    assert.equal("admin_email" in body, false, "no admin email may be disclosed pre-bootstrap");
  } finally {
    database.close();
  }
});
