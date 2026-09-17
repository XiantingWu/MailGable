import { exports, env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { requireAuthPepper } from "../src/lib";
import { AppError } from "../src/lib";
import { verifyResendWebhook } from "../src/mail/delivery-events";

const ORIGIN = "https://example.com";
const API = `${ORIGIN}/api/admin/mail`;
const PASSPHRASE = "correct horse battery staple 2026";

function request(path, { method = "GET", cookie = "", csrf = "", body, origin = ORIGIN } = {}) {
  const headers = new Headers({ Origin: origin, "User-Agent": "Worker-Test/1.0", "CF-Connecting-IP": "203.0.113.20" });
  if (cookie) headers.set("Cookie", cookie);
  if (csrf) headers.set("X-CSRF-Token", csrf);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function bootstrapAdmin() {
  const statusResponse = await exports.default.fetch(request("/auth/status"));
  const status = await statusResponse.json();
  if (status.authenticated === false && status.initialized === true) {
    const loginResponse = await exports.default.fetch(request("/auth/login", {
      method: "POST",
      body: { email: env.ADMIN_EMAIL, password: PASSPHRASE },
    }));
    expect(loginResponse.status).toBe(200);
    const loginBody = await loginResponse.json();
    const loginCookie = (loginResponse.headers.get("Set-Cookie") || "").split(";", 1)[0];
    return { cookie: loginCookie, csrf: loginBody.csrf_token };
  }
  const response = await exports.default.fetch(new Request(`${API}/auth/bootstrap`, {
    method: "POST",
    headers: new Headers({
      Origin: ORIGIN,
      "Content-Type": "application/json",
      "X-Bootstrap-Token": env.ADMIN_BOOTSTRAP_TOKEN,
      "User-Agent": "Worker-Test/1.0",
    }),
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: PASSPHRASE }),
  }));
  expect(response.status).toBe(200);
  const body = await response.json();
  const cookie = (response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  return { cookie, csrf: body.csrf_token };
}

function seedMailbox() {
  return env.DB.prepare(
    "INSERT OR IGNORE INTO mailboxes(mailbox_id,address,display_name,can_receive,can_send,active,created_at,updated_at) VALUES(?,?,?,1,1,1,?,?)",
  ).bind("mb-1", "orders@example.com", "Orders", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z").run();
}

function seedThread(threadId, status = "open") {
  return env.DB.batch([
    env.DB.prepare(
      "INSERT INTO mail_threads(thread_id,mailbox_id,subject,participants_json,last_message_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(threadId, "mb-1", "Thread", "[]", "2026-01-01T00:00:00.000Z", status, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
    env.DB.prepare(
      `INSERT INTO mail_messages(message_id,thread_id,mailbox_id,direction,envelope_from,envelope_to,subject,status,is_read,received_at,raw_r2_key,raw_r2_size,archive_status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(`msg-${threadId}`, threadId, "mb-1", "incoming", "sender@example.net", "orders@example.com", "Thread", "received", 0, "2026-01-01T00:00:00.000Z", `incoming/mb-1/2026/01/${threadId}/original-1.eml`, 100, "archived", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
  ]);
}

describe("MailGable Worker runtime", () => {
  it("GET /healthz is the only public health surface and stays minimal", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const stale = await exports.default.fetch(`${ORIGIN}/api/admin/mail/health`);
    expect(stale.status).toBe(404, "no health endpoint may live inside the admin namespace");
  });

  it("admin API endpoints reject unauthenticated access", async () => {
    for (const path of ["/config", "/mailboxes", "/threads", "/routing-status"]) {
      const response = await exports.default.fetch(request(path));
      expect(response.status, path).toBe(401);
    }
  });

  it("public webhook route rejects unsigned requests with no session", async () => {
    const response = await exports.default.fetch(new Request(`${ORIGIN}/webhooks/resend`, {
      method: "POST",
      headers: new Headers({ "Content-Type": "application/json", "svix-id": "x", "svix-timestamp": "0", "svix-signature": "v1,fake" }),
      body: JSON.stringify({ type: "email.delivered" }),
    }));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("webhook_not_configured");
  });

  it("bootstrap, login, CSRF, and session flow work over the real HTTP stack", async () => {
    const { cookie, csrf } = await bootstrapAdmin();

    const configNoSession = await exports.default.fetch(request("/config"));
    expect(configNoSession.status).toBe(401);

    const badLogin = await exports.default.fetch(request("/auth/login", {
      method: "POST",
      body: { email: env.ADMIN_EMAIL, password: "wrong-password-value" },
    }));
    expect(badLogin.status).toBe(401);

    const login = await exports.default.fetch(request("/auth/login", {
      method: "POST",
      body: { email: env.ADMIN_EMAIL, password: PASSPHRASE },
    }));
    expect(login.status).toBe(200);

    const configWithSession = await exports.default.fetch(request("/config", { cookie }));
    expect(configWithSession.status).toBe(200);
    expect((await configWithSession.json()).database).toBe(true);

    const missingCsrf = await exports.default.fetch(request("/threads", { cookie }));
    expect(missingCsrf.status).toBe(200);

    const badOrigin = await exports.default.fetch(request("/auth/logout", {
      method: "POST",
      cookie,
      csrf,
      origin: "https://attacker.example",
      body: {},
    }));
    expect(badOrigin.status).toBe(403);

    const logout = await exports.default.fetch(request("/auth/logout", {
      method: "POST",
      cookie,
      csrf,
      body: {},
    }));
    expect(logout.status).toBe(200);
  });

  it("empty thread list returns an empty page with folder semantics", async () => {
    const { cookie } = await bootstrapAdmin();
    const list = await exports.default.fetch(request("/threads?folder=inbox", { cookie }));
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.threads).toEqual([]);
    expect(body.has_more).toBe(false);
  });

  it("trash, restore, and hard delete work over the real HTTP stack with real D1/R2", async () => {
    await seedMailbox();
    await seedThread("t-http");
    await env.MAIL_R2.put("incoming/mb-1/2026/01/t-http/original-1.eml", "raw-bytes");
    const { cookie, csrf } = await bootstrapAdmin();

    const trash = await exports.default.fetch(request("/threads/t-http/trash", {
      method: "POST", cookie, csrf, body: {},
    }));
    expect(trash.status).toBe(200);
    const status = env.DB.prepare("SELECT status FROM mail_threads WHERE thread_id=?").bind("t-http").first();
    expect((await status).status).toBe("trash");

    const restore = await exports.default.fetch(request("/threads/t-http/restore", {
      method: "POST", cookie, csrf, body: {},
    }));
    expect(restore.status).toBe(200);

    const del = await exports.default.fetch(request("/threads/t-http", {
      method: "DELETE", cookie, csrf, body: {},
    }));
    expect(del.status).toBe(200);
    const delBody = await del.json();
    expect(delBody.deleted_r2_keys).toBe(1);
    expect(await env.MAIL_R2.get("incoming/mb-1/2026/01/t-http/original-1.eml")).toBeNull();
    const remaining = await env.DB.prepare("SELECT COUNT(*) AS count FROM mail_threads WHERE thread_id=?").bind("t-http").first();
    expect((await remaining).count).toBe(0);
  });

  it("sending fails closed without a configured provider key", async () => {
    // OUTBOUND_PROVIDER defaults to none in the test harness, so sending is
    // rejected before any provider is contacted.
    await seedMailbox();
    const { cookie, csrf } = await bootstrapAdmin();
    const send = await exports.default.fetch(request("/messages/send", {
      method: "POST",
      cookie,
      csrf,
      headers: new Headers({ "Idempotency-Key": "test-key-1234567890" }),
      body: { from_mailbox_id: "mb-1", to: "someone@example.net", subject: "Hi", text: "hello" },
    }));
    expect(send.status).toBe(503);
    expect((await send.json()).code).toBe("provider_not_configured");
  });


});

describe("unit fail-closed behaviors", () => {
  it("requireAuthPepper rejects missing and short peppers", () => {
    expect(() => requireAuthPepper({})).toThrow(AppError);
    expect(() => requireAuthPepper({ AUTH_PEPPER: "short" })).toThrow(AppError);
    expect(() => requireAuthPepper({ AUTH_PEPPER: "x".repeat(32) })).not.toThrow();
  });

  it("verifyResendWebhook rejects bad signatures and timestamps", async () => {
    const headers = new Headers({ "svix-id": "msg_1", "svix-timestamp": "1", "svix-signature": "v1,invalid" });
    expect(await verifyResendWebhook("payload", headers, "whsec_abc123", 1)).toBe(false);
    const stale = new Headers({ "svix-id": "msg_1", "svix-timestamp": String(Math.floor(Date.now() / 1000) - 3600), "svix-signature": "v1,invalid" });
    expect(await verifyResendWebhook("payload", stale, "whsec_abc123")).toBe(false);
  });
});

describe("direct worker unit path", () => {
  it("worker.fetch returns 404 for unknown admin paths", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://example.com/admin/mail/nope"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
  });

  it("scheduled cleanup runs without throwing", async () => {
    const ctx = createExecutionContext();
    const controller = { scheduledTime: Date.now(), cron: "17 4 * * *" } as unknown as ScheduledController;
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);
  });
});

describe("admin asset security headers (run_worker_first)", () => {
  it("every admin asset carries the full security header set", async () => {
    const paths = [
      "/admin/mail/",
      "/admin/mail/index.html",
      "/admin/mail/mail.css",
      "/admin/mail/js/app.mjs",
      "/admin/mail/routing-status.css",
    ];
    for (const path of paths) {
      const response = await exports.default.fetch(`${ORIGIN}${path}`);
      expect(response.status, path).toBe(200);
      const headers = response.headers;
      expect(headers.get("X-Frame-Options"), path).toBe("DENY");
      expect(headers.get("Content-Security-Policy"), path).toBeTruthy();
      expect(headers.get("X-Content-Type-Options"), path).toBe("nosniff");
      expect(headers.get("Referrer-Policy"), path).toBe("no-referrer");
      expect(headers.get("X-Robots-Tag"), path).toBe("noindex, nofollow");
      expect(headers.get("Strict-Transport-Security"), path).toMatch(/^max-age=31536000$/);
    }
  });

  it("unknown admin paths return a hardened 404", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/admin/mail/nope`);
    expect(response.status).toBe(404);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("API responses carry the security header set, no-store caching, and no CORS grant", async () => {
    const response = await exports.default.fetch(new Request(`${API}/auth/status`, {
      headers: new Headers({ Origin: "https://attacker.example", "User-Agent": "Worker-Test/1.0" }),
    }));
    expect(response.status).toBe(200);
    const headers = response.headers;
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});
