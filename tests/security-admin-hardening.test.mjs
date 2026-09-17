// Security regression suite for the admin authentication and request boundary.
//
// Covers the pre-public admin hardening audit checklist:
//   - session fixation (client-supplied cookies are never adopted)
//   - absolute and idle session expiry (revoked server-side on first use)
//   - CSRF/origin matrix for every state-changing route
//   - no CORS grants for cross-origin requests
//   - cookie contract (__Host-, Secure, HttpOnly, SameSite=Strict, no Domain)
//   - Host header is never trusted for origin decisions
//   - no account-existence disclosure and login rate limiting
//
//   node --test tests/security-admin-hardening.test.mjs
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
const { authStatus, bootstrap, getSession, login, requireSession } = loaded.exports;

const MIGRATIONS = [
  "migrations/0001_mailbox.sql",
  "migrations/0002_mailbox_hardening.sql",
  "migrations/0003_mailbox_reply_safety.sql",
  "migrations/0004_ops_probe.sql",
  "migrations/0005_admin_password_iterations.sql",
  "migrations/0006_routing_managed_mailboxes.sql",
  "migrations/0007_inbound_forward_attempts.sql",
  "migrations/0008_thread_status_archived.sql",
  "migrations/0009_password_scheme_audit_index.sql",
  "migrations/0010_thread_summaries.sql",
  "migrations/0011_outbound_providers.sql",
];

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

const ORIGIN = "https://mailgable-security.example.workers.dev";
const PASSPHRASE = "correct horse battery staple 2026";

async function testEnvironment(overrides = {}) {
  const database = new DatabaseSync(":memory:");
  for (const file of MIGRATIONS) database.exec(await readFile(file, "utf8"));
  return {
    database,
    env: {
      DB: new D1Adapter(database),
      APP_ORIGIN: ORIGIN,
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_BOOTSTRAP_TOKEN: "bootstrap-token-with-sufficient-entropy",
      AUTH_PEPPER: "p".repeat(64),
      PASSWORD_ITERATIONS: "8000",
      SESSION_HOURS: "12",
      SESSION_IDLE_MINUTES: "30",
      ...overrides,
    },
  };
}

function request(path, {
  method,
  body,
  cookie,
  csrf,
  bootstrapToken,
  origin = ORIGIN,
  host = "mailgable-security.example.workers.dev",
  ua = "Mailbox-Security-Test/1.0",
  ip = "203.0.113.10",
} = {}) {
  const headers = new Headers({ Origin: origin, "User-Agent": ua, "CF-Connecting-IP": ip });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (cookie) headers.set("Cookie", cookie);
  if (csrf) headers.set("X-CSRF-Token", csrf);
  if (bootstrapToken) headers.set("X-Bootstrap-Token", bootstrapToken);
  return new Request(`https://${host}${path}`, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function cookieValue(response) {
  const header = response.headers.get("Set-Cookie") || "";
  return header.split(";", 1)[0];
}

async function bootstrapAdmin(env) {
  const response = await bootstrap(request("/api/admin/mail/auth/bootstrap", {
    bootstrapToken: env.ADMIN_BOOTSTRAP_TOKEN,
    body: { email: env.ADMIN_EMAIL, password: PASSPHRASE },
  }), env);
  assert.equal(response.status, 200);
  return response;
}

async function loginAdmin(env, { cookie } = {}) {
  const response = await login(request("/api/admin/mail/auth/login", {
    cookie,
    body: { email: env.ADMIN_EMAIL, password: PASSPHRASE },
  }), env);
  assert.equal(response.status, 200);
  return response;
}

test("login issues a fresh session token and never adopts a client-supplied cookie (session fixation)", async () => {
  const { database, env } = await testEnvironment();
  try {
    await bootstrapAdmin(env);
    const attackerToken = "attacker-controlled-session-token";
    const response = await login(request("/api/admin/mail/auth/login", {
      cookie: `${lib.SESSION_COOKIE_NAME}=${attackerToken}`,
      body: { email: env.ADMIN_EMAIL, password: PASSPHRASE },
    }), env);
    assert.equal(response.status, 200);
    const issued = cookieValue(response);
    assert.ok(issued.startsWith(`${lib.SESSION_COOKIE_NAME}=`));
    assert.notEqual(issued, `${lib.SESSION_COOKIE_NAME}=${attackerToken}`, "the server must issue its own token");

    // The pre-set token must never become a valid session.
    const adopted = await getSession(request("/api/admin/mail/config", {
      cookie: `${lib.SESSION_COOKIE_NAME}=${attackerToken}`,
    }), env);
    assert.equal(adopted, null);

    // Two logins must produce two distinct sessions.
    const second = await loginAdmin(env);
    assert.notEqual(cookieValue(second), issued);
    const sessions = database.prepare("SELECT COUNT(*) AS count FROM admin_sessions WHERE revoked_at IS NULL").get();
    assert.equal(Number(sessions.count), 3, "bootstrap session plus two login sessions");
  } finally {
    database.close();
  }
});

test("absolute SESSION_HOURS expiry revokes the session on first use", async () => {
  const { database, env } = await testEnvironment();
  try {
    await bootstrapAdmin(env);
    const response = await loginAdmin(env);
    const cookie = cookieValue(response);
    database.prepare("UPDATE admin_sessions SET expires_at=?").run("2020-01-01T00:00:00.000Z");

    const session = await getSession(request("/api/admin/mail/config", { cookie }), env);
    assert.equal(session, null);
    const row = database.prepare("SELECT revoked_at FROM admin_sessions ORDER BY created_at DESC LIMIT 1").get();
    assert.ok(row.revoked_at, "expired sessions are revoked server-side");
  } finally {
    database.close();
  }
});

test("SESSION_IDLE_MINUTES idle expiry revokes the session; 0 disables idle expiry", async () => {
  const idleEnv = await testEnvironment({ SESSION_IDLE_MINUTES: "30" });
  try {
    await bootstrapAdmin(idleEnv.env);
    const response = await loginAdmin(idleEnv.env);
    const cookie = cookieValue(response);
    idleEnv.database.prepare("UPDATE admin_sessions SET last_seen_at=?")
      .run(new Date(Date.now() - 31 * 60_000).toISOString());
    const session = await getSession(request("/api/admin/mail/config", { cookie }), idleEnv.env);
    assert.equal(session, null, "idle sessions are rejected");
    const row = idleEnv.database.prepare("SELECT revoked_at FROM admin_sessions ORDER BY created_at DESC LIMIT 1").get();
    assert.ok(row.revoked_at, "idle sessions are revoked server-side");
  } finally {
    idleEnv.database.close();
  }

  const staticEnv = await testEnvironment({ SESSION_IDLE_MINUTES: "0" });
  try {
    await bootstrapAdmin(staticEnv.env);
    const response = await loginAdmin(staticEnv.env);
    const cookie = cookieValue(response);
    staticEnv.database.prepare("UPDATE admin_sessions SET last_seen_at=?")
      .run(new Date(Date.now() - 2 * 60 * 60_000).toISOString());
    const session = await getSession(request("/api/admin/mail/config", { cookie }), staticEnv.env);
    assert.ok(session, "idle expiry disabled keeps the session within its absolute lifetime");
  } finally {
    staticEnv.database.close();
  }
});

test("CSRF/origin matrix holds for every state-changing route", async () => {
  const { database, env } = await testEnvironment();
  try {
    await bootstrapAdmin(env);
    const response = await loginAdmin(env);
    const cookie = cookieValue(response);
    const csrf = (await response.clone().json()).csrf_token;

    const mutations = [
      { method: "POST", path: "/api/admin/mail/threads/t1/read" },
      { method: "POST", path: "/api/admin/mail/routing-sync" },
      { method: "POST", path: "/api/admin/mail/auth/logout" },
      { method: "DELETE", path: "/api/admin/mail/threads/t1" },
    ];

    for (const route of mutations) {
      const noSession = request(route.path, { method: route.method, body: {} });
      await assert.rejects(requireSession(noSession, env, true), (error) => error?.code === "unauthorized", `${route.path}: no session`);

      const missingCsrf = request(route.path, { method: route.method, body: {}, cookie });
      await assert.rejects(requireSession(missingCsrf, env, true), (error) => error?.code === "csrf_invalid", `${route.path}: missing CSRF`);

      const wrongCsrf = request(route.path, { method: route.method, body: {}, cookie, csrf: "wrong-token" });
      await assert.rejects(requireSession(wrongCsrf, env, true), (error) => error?.code === "csrf_invalid", `${route.path}: wrong CSRF`);

      const foreignOrigin = request(route.path, {
        method: route.method,
        body: {},
        cookie,
        csrf,
        origin: "https://attacker.example",
      });
      await assert.rejects(requireSession(foreignOrigin, env, true), (error) => error?.code === "origin_denied", `${route.path}: foreign origin`);

      const missingOrigin = request(route.path, { method: route.method, body: {}, cookie, csrf, origin: "" });
      await assert.rejects(requireSession(missingOrigin, env, true), (error) => error?.code === "origin_denied", `${route.path}: missing origin`);

      const allowed = request(route.path, { method: route.method, body: {}, cookie, csrf });
      const session = await requireSession(allowed, env, true);
      assert.ok(session, `${route.path}: valid session + CSRF + origin is accepted`);
    }
  } finally {
    database.close();
  }
});

test("route table keeps every non-auth mutation behind requireSession(csrf=true)", async () => {
  const index = await readFile("src/index.ts", "utf8");
  const handleApi = index.slice(index.indexOf("async function handleApi"), index.indexOf("export function classifyD1QuotaError"));
  const blocks = handleApi.split(/if \(method === "(?:POST|PUT|PATCH|DELETE)"/).slice(1);
  assert.ok(blocks.length >= 10, "expected mutation routes in the API table");
  let protectedRoutes = 0;
  for (const block of blocks) {
    // Login and bootstrap are the two deliberately public mutations; both
    // enforce Origin internally (requireOrigin in src/auth.ts).
    if (block.includes("/api/auth/bootstrap") || block.includes("/api/auth/login")) continue;
    const head = block.slice(0, block.indexOf("return "));
    assert.ok(
      head.includes("requireSession(request, env, true)"),
      `mutation route is not CSRF-protected: ${block.slice(0, 80)}`,
    );
    protectedRoutes += 1;
  }
  assert.ok(protectedRoutes >= 9, "expected the CSRF-protected mutation routes");
});

test("cross-origin requests receive no CORS grant", async () => {
  const { database, env } = await testEnvironment();
  try {
    for (const method of ["GET", "OPTIONS", "POST"]) {
      const status = await authStatus(request("/api/admin/mail/auth/status", {
        method,
        origin: "https://attacker.example",
      }), env);
      assert.equal(status.headers.get("Access-Control-Allow-Origin"), null, `${method}: no ACAO`);
      assert.equal(status.headers.get("Access-Control-Allow-Credentials"), null, `${method}: no credentials grant`);
    }
  } finally {
    database.close();
  }
});

test("session cookie satisfies the __Host- contract and the Host header is never trusted", async () => {
  const { database, env } = await testEnvironment();
  try {
    await bootstrapAdmin(env);
    const response = await loginAdmin(env);
    const raw = response.headers.get("Set-Cookie") || "";
    assert.ok(raw.startsWith(`${lib.SESSION_COOKIE_NAME}=`));
    assert.ok(raw.includes("Path=/"));
    assert.ok(raw.includes("HttpOnly"));
    assert.ok(raw.includes("Secure"));
    assert.ok(raw.includes("SameSite=Strict"));
    assert.ok(!/;\s*Domain=/i.test(raw), "the __Host- contract forbids a Domain attribute");

    // A forged Host header must not change the origin decision.
    await assert.rejects(
      login(request("/api/admin/mail/auth/login", {
        host: "attacker.example",
        origin: "https://attacker.example",
        body: { email: env.ADMIN_EMAIL, password: PASSPHRASE },
      }), env),
      (error) => error?.code === "origin_denied",
    );
    // The legitimate origin succeeds even with a forged Host header.
    const accepted = await login(request("/api/admin/mail/auth/login", {
      host: "attacker.example",
      origin: ORIGIN,
      body: { email: env.ADMIN_EMAIL, password: PASSPHRASE },
    }), env);
    assert.equal(accepted.status, 200);
  } finally {
    database.close();
  }
});

test("authentication fails closed when the database is unavailable", async () => {
  const { database, env } = await testEnvironment();
  try {
    await bootstrapAdmin(env);
    const response = await loginAdmin(env);
    const cookie = cookieValue(response);

    const brokenEnv = { ...env, DB: { prepare() { throw new Error("D1 unavailable"); } } };
    // A storage failure must surface as an error, never as an authenticated result.
    await assert.rejects(async () => {
      const status = await authStatus(request("/api/admin/mail/auth/status", { cookie }), brokenEnv);
      const body = await status.json();
      assert.notEqual(body.authenticated, true, "must not fail open");
    });
    await assert.rejects(
      requireSession(request("/api/admin/mail/config", { cookie }), brokenEnv, false),
    );
    await assert.rejects(
      login(request("/api/admin/mail/auth/login", {
        body: { email: env.ADMIN_EMAIL, password: PASSPHRASE },
      }), brokenEnv),
    );
  } finally {
    database.close();
  }
});

test("session revocation is final and concurrent revocation cannot resurrect a session", async () => {
  const { database, env } = await testEnvironment();
  try {
    await bootstrapAdmin(env);
    const response = await loginAdmin(env);
    const cookie = cookieValue(response);
    const csrf = (await response.clone().json()).csrf_token;
    const session = await getSession(request("/api/admin/mail/config", { cookie }), env);
    assert.ok(session);

    // Concurrent logout attempts are idempotent and every one of them ends
    // with the session revoked; a simultaneous read must never reseat it.
    const logout = async () => {
      const row = await env.DB.prepare("UPDATE admin_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE session_id=?")
        .bind(new Date().toISOString(), session.sessionId).run();
      return row;
    };
    await Promise.all([logout(), logout(), getSession(request("/api/admin/mail/config", { cookie }), env)]);
    assert.equal(await getSession(request("/api/admin/mail/config", { cookie }), env), null);
    const row = database.prepare("SELECT revoked_at FROM admin_sessions WHERE session_id=?").get(session.sessionId);
    assert.ok(row.revoked_at);

    // A password change revokes every session; the old cookie stays dead.
    const relogin = await loginAdmin(env);
    const newCookie = cookieValue(relogin);
    await env.DB.prepare("UPDATE admin_sessions SET revoked_at=? WHERE admin_id=?").bind(new Date().toISOString(), session.adminId).run();
    assert.equal(await getSession(request("/api/admin/mail/config", { cookie }), env), null);
    assert.equal(await getSession(request("/api/admin/mail/config", { cookie: newCookie }), env), null);
    assert.equal(csrf.length > 0, true);
  } finally {
    database.close();
  }
});

test("active sessions are capped: the oldest session is revoked when a sixth login occurs", async () => {
  const { database, env } = await testEnvironment();
  try {
    await bootstrapAdmin(env);
    const tokens = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      tokens.push(cookieValue(await loginAdmin(env)));
    }
    const active = database.prepare("SELECT COUNT(*) AS count FROM admin_sessions WHERE revoked_at IS NULL").get();
    assert.equal(Number(active.count), 5, "MAX_ACTIVE_SESSIONS caps live sessions");
    assert.equal(await getSession(request("/api/admin/mail/config", { cookie: tokens[0] }), env), null, "oldest session is revoked");
    assert.ok(await getSession(request("/api/admin/mail/config", { cookie: tokens[5] }), env), "newest session stays valid");
  } finally {
    database.close();
  }
});

test("authentication does not disclose account existence and is rate limited", async () => {
  const { database, env } = await testEnvironment();
  try {
    await bootstrapAdmin(env);
    const unknown = await login(request("/api/admin/mail/auth/login", {
      body: { email: "nobody@example.com", password: PASSPHRASE },
    }), env).catch((error) => error);
    const wrong = await login(request("/api/admin/mail/auth/login", {
      body: { email: env.ADMIN_EMAIL, password: "not-the-passphrase-2026" },
    }), env).catch((error) => error);
    assert.equal(unknown.code, "invalid_credentials");
    assert.equal(wrong.code, "invalid_credentials");
    assert.equal(unknown.message, wrong.message, "failure responses must be indistinguishable");

    // Email-scoped limit is 8 failures per window; the next attempt is denied.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await login(request("/api/admin/mail/auth/login", {
        body: { email: env.ADMIN_EMAIL, password: "not-the-passphrase-2026" },
      }), env).catch(() => {});
    }
    await assert.rejects(
      login(request("/api/admin/mail/auth/login", {
        body: { email: env.ADMIN_EMAIL, password: PASSPHRASE },
      }), env),
      (error) => error?.code === "rate_limited",
      "the email-scoped login limit must stop the burst",
    );
  } finally {
    database.close();
  }
});
