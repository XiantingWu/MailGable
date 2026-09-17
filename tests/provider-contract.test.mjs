// PROVIDER CONTRACT FINAL VERIFICATION (Stages 8/9/10).
//
// Resend: three-key model preserved — RESEND_SETUP_API_KEY (operator-local
// management), RESEND_API_KEY (runtime sending), RESEND_WEBHOOK_SECRET
// (runtime webhook verification). The reconcile contract uses the exact
// canonical webhook endpoint and email.* events; the signing secret flows
// only through writeSecret (central store + Worker), never Git/D1/generated
// config/argv/logs.
//
// Brevo: single-key default (BREVO_API_KEY = sending + management) with an
// optional BREVO_SETUP_API_KEY management override; management resolution
// is BREVO_SETUP_API_KEY || BREVO_API_KEY; provider idempotency is
// documented at 30 minutes and the application retry window is the
// conservative 25 minutes.
//
// Cloudflare Email: exactly the six official lifecycle events, strict
// source.type=email.sending envelope, and Email Routing inbound events are
// never mixed into Email Sending processing.
import test from "node:test";
import assert from "node:assert/strict";

const events = await import("../.test-build/src/providers/events.js");
const { normalizeCloudflareQueueEvent } = events;
const brevo = await import("../.test-build/src/providers/brevo.js");
const resend = await import("../.test-build/src/providers/resend.js");
const reconcile = await import("../scripts/reconcile.mjs");
const { RESEND_WEBHOOK_EVENTS, brevoManagementKey } = reconcile;
const credentialsModule = await import("../scripts/config/credentials.mjs");
const { CREDENTIAL_SCHEMA, providerActiveCredentials } = credentialsModule;

test("Resend contract keeps three distinct credentials with the correct roles", () => {
  const entry = (key) => CREDENTIAL_SCHEMA.find((e) => e.key === key);
  assert.equal(entry("RESEND_SETUP_API_KEY").role, "operator-local", "management key is operator-local");
  assert.equal(entry("RESEND_API_KEY").role, "runtime-persistent", "sending key is runtime-persistent");
  assert.equal(entry("RESEND_WEBHOOK_SECRET").role, "runtime-persistent", "webhook secret is runtime-persistent");
  const runtime = providerActiveCredentials("resend", {
    RESEND_SETUP_API_KEY: "m", RESEND_API_KEY: "s", RESEND_WEBHOOK_SECRET: "w",
  });
  assert.deepEqual(Object.keys(runtime).sort(), ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"]);
  assert.ok(!("RESEND_SETUP_API_KEY" in runtime), "management key never becomes a runtime secret");
  assert.equal(resend.RESEND_SAFE_RETRY_WINDOW_MS, 23 * 60 * 60_000, "Resend 23h app retry window");
});

test("Resend webhook events match the official delivery-event contract", () => {
  assert.deepEqual([...RESEND_WEBHOOK_EVENTS].sort(), [
    "email.bounced", "email.complained", "email.delivered", "email.delivery_delayed", "email.failed",
  ]);
});

test("Resend reconcile uses the exact canonical endpoint and returns the real signing secret through writeSecret only", async () => {
  const created = { id: "wh_c", endpoint: "https://mail.contract-test.dev/webhooks/resend", status: "enabled", events: RESEND_WEBHOOK_EVENTS, signing_secret: "whsec_real_contract_secret" };
  const calls = [];
  const globalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    if (String(url).endsWith("/webhooks") && !options.method) return { ok: true, json: async () => ({ data: [created] }) };
    if (String(url).endsWith("/webhooks") && options.method === "POST") return { ok: true, json: async () => created };
    return { ok: true, json: async () => created };
  };
  const secrets = [];
  try {
    const report = await reconcile.reconcileResend({
      appOrigin: "https://mail.contract-test.dev",
      credentials: { RESEND_SETUP_API_KEY: "re_mgmt" },
      writeSecret: async (name, value) => { secrets.push([name, value]); },
    });
    assert.equal(report.status, "pass");
    const get = calls.find((c) => c.method === "GET" && c.url.includes("/webhooks/wh_c"));
    assert.ok(get, "webhook detail is re-read to obtain the real signing secret");
    assert.deepEqual(secrets, [["RESEND_WEBHOOK_SECRET", "whsec_real_contract_secret"]],
      "the signing secret flows only through writeSecret");
  } finally {
    globalThis.fetch = globalFetch;
  }
  assert.ok(!JSON.stringify(calls).includes("whsec_real_contract_secret"), "signing secret never appears in reconcile call metadata");
});

test("Brevo contract: single-key default, optional override, 30-min provider / 25-min app window", () => {
  assert.equal(brevoManagementKey({ BREVO_API_KEY: "xkeysib_send" }), "xkeysib_send", "default management key is BREVO_API_KEY");
  assert.equal(brevoManagementKey({ BREVO_API_KEY: "xkeysib_send", BREVO_SETUP_API_KEY: "xkeysib_mgmt" }), "xkeysib_mgmt", "setup key overrides management");
  assert.equal(brevoManagementKey({ BREVO_SETUP_API_KEY: "xkeysib_mgmt" }), "xkeysib_mgmt");
  assert.equal(brevoManagementKey({}), "");
  assert.equal(brevo.BREVO_SAFE_RETRY_WINDOW_MS, 25 * 60_000, "25-minute application retry safety window");
  assert.equal(brevo.BREVO_SAFE_RETRY_WINDOW_MS < 30 * 60_000, true, "25m is conservative below the 30-minute provider idempotency TTL");
});

test("Cloudflare Email: exactly the six official lifecycle events are covered", async () => {
  const official = [
    "message.delivered", "message.deferred", "message.bounced",
    "message.failed", "message.rejected", "message.complained",
  ];
  const statuses = new Set();
  for (const event of official) {
    const normalized = await normalizeCloudflareQueueEvent({
      type: `cf.email.sending.${event}`,
      source: { type: "email.sending", zoneId: "z", domain: "d.example.com" },
      payload: { eventId: `e-${event}`, messageId: "m1", recipient: "r@example.net" },
      metadata: { eventTimestamp: "2026-09-03T12:00:00Z" },
    });
    assert.ok(normalized.status, `official event ${event} maps to a status`);
    statuses.add(normalized.status);
  }
  assert.equal(statuses.size, 6, "each official event maps to its own status (delivered, deferred, bounced, failed, rejected, complained)");
  await assert.rejects(
    () => normalizeCloudflareQueueEvent({
      type: "cf.email.sending.message.seventh",
      source: { type: "email.sending", zoneId: "z", domain: "d.example.com" },
      payload: { eventId: "e7", messageId: "m1", recipient: "r@example.net" },
      metadata: { eventTimestamp: "2026-09-03T12:00:00Z" },
    }),
    (error) => error.code === "unsupported_provider_event",
    "a seventh/unknown lifecycle event is rejected, never silently mapped",
  );
});

test("Cloudflare Email: Email Routing inbound events are never treated as Email Sending events", async () => {
  await assert.rejects(
    () => normalizeCloudflareQueueEvent({
      type: "email.routing.received", source: { type: "email.routing" },
      payload: { messageId: "m1", recipient: "r@example.net" },
      metadata: { eventTimestamp: "2026-09-03T12:00:00Z" },
    }),
    (error) => error.code === "invalid_queue_event",
    "email.routing source is rejected",
  );
  await assert.rejects(
    () => normalizeCloudflareQueueEvent({
      type: "cf.email.sending.message.delivered", source: { type: "email.routing" },
      payload: { eventId: "e1", messageId: "m1", recipient: "r@example.net" },
      metadata: { eventTimestamp: "2026-09-03T12:00:00Z" },
    }),
    (error) => error.code === "invalid_queue_event",
    "correct type but wrong source.type is rejected",
  );
  const inbound = await normalizeCloudflareQueueEvent({
    type: "cf.email.sending.message.delivered", source: { type: "email.sending", zoneId: "z", domain: "d.example.com" },
    payload: { eventId: "e1", messageId: "m1", recipient: "r@example.net" },
    metadata: { eventTimestamp: "2026-09-03T12:00:00Z" },
  });
  assert.equal(inbound.provider, "cloudflare");
  assert.equal(inbound.providerEventId, "e1");
});
