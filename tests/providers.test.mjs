import test from "node:test";
import assert from "node:assert/strict";
import { loadMailModule } from "./helpers/mail-loader.mjs";

const loaded = await loadMailModule();
const { buildSendPlan, automaticBccAddresses } = loaded;
const registry = await import("../.test-build/src/providers/registry.js");
const { getProviderById, configuredProviderId, providerForMessage, getOutboundProvider } = registry;
const brevo = await import("../.test-build/src/providers/brevo.js");
const resend = await import("../.test-build/src/providers/resend.js");
const cloudflare = await import("../.test-build/src/providers/cloudflare-email.js");
const events = await import("../.test-build/src/providers/events.js");
const { normalizeResendEvent, normalizeBrevoEvent, normalizeCloudflareQueueEvent, deterministicEventKey, applyDeliveryEvent } = events;

function fakeEnv(overrides = {}) {
  return {
    OUTBOUND_PROVIDER: "none",
    RESEND_API_KEY: "",
    BREVO_API_KEY: "",
    EMAIL: undefined,
    DB: {
      prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }),
    },
    ...overrides,
  };
}

test("registry exposes all three providers with distinct capabilities", () => {
  const resendProvider = getProviderById("resend");
  const brevoProvider = getProviderById("brevo");
  const cfProvider = getProviderById("cloudflare");
  assert.ok(resendProvider && brevoProvider && cfProvider);
  assert.equal(resendProvider.capabilities.safeRetryWindowMs, 23 * 60 * 60_000);
  assert.equal(resendProvider.capabilities.deliveryEvents, "webhook");
  assert.equal(brevoProvider.capabilities.safeRetryWindowMs, 25 * 60_000);
  assert.equal(brevoProvider.capabilities.deliveryEvents, "webhook");
  assert.equal(cfProvider.capabilities.deliveryEvents, "queue");
  assert.equal(cfProvider.capabilities.safeRetryWindowMs, null);
  assert.equal(cfProvider.capabilities.providerIdempotency, false);
  assert.equal(cfProvider.capabilities.maxMessageBytes, 5 * 1024 * 1024);
});

test("configuredProviderId selects only a configured provider; none by default", () => {
  assert.equal(configuredProviderId(fakeEnv()), null);
  assert.equal(configuredProviderId(fakeEnv({ OUTBOUND_PROVIDER: "resend", RESEND_API_KEY: "rk" })), "resend");
  assert.equal(configuredProviderId(fakeEnv({ OUTBOUND_PROVIDER: "resend" })), null, "unconfigured provider is not selected");
  assert.equal(configuredProviderId(fakeEnv({ OUTBOUND_PROVIDER: "brevo", BREVO_API_KEY: "bk" })), "brevo");
  assert.equal(configuredProviderId(fakeEnv({ OUTBOUND_PROVIDER: "brevo", BREVO_API_KEY: "bk", RESEND_API_KEY: "rk" })), "brevo");
  assert.equal(configuredProviderId(fakeEnv({ OUTBOUND_PROVIDER: "cloudflare", EMAIL: { send: async () => ({}) } })), "cloudflare");
  assert.equal(getOutboundProvider(fakeEnv()), null);
});

test("providerForMessage pins retries to the original provider and fails closed when missing", () => {
  const env = fakeEnv({ OUTBOUND_PROVIDER: "brevo", BREVO_API_KEY: "bk", RESEND_API_KEY: "rk" });
  assert.equal(providerForMessage(env, { outbound_provider: "resend" }).id, "resend");
  assert.throws(
    () => providerForMessage(fakeEnv({ OUTBOUND_PROVIDER: "brevo", BREVO_API_KEY: "bk" }), { outbound_provider: "resend" }),
    (error) => error.code === "provider_not_configured_for_retry",
    "deleting the old provider credential must never fall back",
  );
  assert.equal(providerForMessage(env, {}), null);
});

test("Brevo payload mapping, attachment base64, tags, and messageId parsing", async () => {
  const env = fakeEnv({ OUTBOUND_PROVIDER: "brevo", BREVO_API_KEY: "bk" });
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ messageId: "brevo-msg-1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const plan = {
      mailbox: { mailbox_id: "m1", address: "hello@example.com", display_name: "Hello" },
      to: ["a@example.net"], cc: [], bcc: [],
      subject: "Hi", text: "body", html: "",
      uploads: [{ filename: "f.txt", contentType: "text/plain", content: Buffer.from("file-content").toString("base64"), bytes: new Uint8Array(11) }],
      parent: null, threadId: "t1", requestHash: "h",
    };
    const provider = getProviderById("brevo");
    const result = await provider.send(env, { message_id: "msg-1", idempotency_key: "web/abc", subject: "Hi", x_mailbox_mail_id: "x1" }, plan);
    assert.equal(result.providerMessageId, "brevo-msg-1");
    const body = JSON.parse(captured.init.body);
    assert.equal(body.sender.email, "hello@example.com");
    assert.deepEqual(body.to, [{ email: "a@example.net" }]);
    assert.equal(body.attachment[0].name, "f.txt");
    assert.equal(body.attachment[0].content, Buffer.from("file-content").toString("base64"));
    assert.deepEqual(body.tags, ["mailbox:msg-1"]);
    assert.equal(body.headers.idempotencyKey, "msg-1", "Brevo idempotency key lives in custom headers");
    assert.equal("idempotencyKey" in body, false, "no top-level idempotencyKey");
    assert.equal("In-Reply-To" in body.headers, false, "Brevo does not support standard threading headers");
    assert.match(String(captured.init.headers["api-key"]), /^bk$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Brevo success without messageId is provider_outcome_unknown", async () => {
  const env = fakeEnv({ OUTBOUND_PROVIDER: "brevo", BREVO_API_KEY: "bk" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
  try {
    const plan = { mailbox: { mailbox_id: "m1", address: "hello@example.com", display_name: "Hello" }, to: ["a@example.net"], cc: [], bcc: [], subject: "S", text: "b", html: "", uploads: [], parent: null, threadId: "t", requestHash: "h" };
    await assert.rejects(
      getProviderById("brevo").send(env, { message_id: "m2", idempotency_key: "k", subject: "S", x_mailbox_mail_id: "x" }, plan),
      (error) => error.code === "provider_outcome_unknown",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Brevo webhook authentication, normalization, and deterministic replay keys", async () => {
  const payload = {
    event: "hardBounce",
    "message-id": "brevo-msg-9",
    email: "bounce@example.net",
    tags: ["mailbox:msg-9"],
    ts_event: "2024-11-14T18:13:00+00:00",
  };
  const event = await normalizeBrevoEvent(payload, "token-123", "token-123");
  assert.equal(event.provider, "brevo");
  assert.equal(event.status, "bounced");
  assert.equal(event.taggedMessageId, "msg-9");
  assert.deepEqual(event.recipients, ["bounce@example.net"]);
  const replay = await normalizeBrevoEvent(payload, "token-123", "token-123");
  assert.equal(event.providerEventId, replay.providerEventId, "deterministic replay identity");
  await assert.rejects(
    normalizeBrevoEvent(payload, "wrong-token", "token-123"),
    (error) => error.code === "invalid_webhook_auth",
  );
});

test("Cloudflare queue event normalization and duplicate protection", async () => {
  const event = await normalizeCloudflareQueueEvent({
    type: "cf.email.sending.message.delivered",
    source: { type: "email.sending", zoneId: "z", domain: "example.com" },
    payload: { eventId: "evt-1", messageId: "cf-1", recipient: "r@example.net" },
    metadata: { eventTimestamp: "2026-09-03T12:00:00Z" },
  });
  assert.equal(event.status, "delivered");
  assert.equal(event.providerEventId, "evt-1");
  assert.equal(event.providerMessageId, "cf-1");
  assert.deepEqual(event.recipients, ["r@example.net"]);
  const bad = { type: "not.email.event" };
  await assert.rejects(normalizeCloudflareQueueEvent(bad), /Unsupported queue event/);
});

test("deterministicEventKey is cryptographic, stable, and unique per provider", async () => {
  assert.equal(await deterministicEventKey("brevo", "m1", "a@x", "delivered", "1"), await deterministicEventKey("brevo", "m1", "a@x", "delivered", "1"));
  assert.notEqual(await deterministicEventKey("brevo", "m1", "a@x", "delivered", "1"), await deterministicEventKey("resend", "m1", "a@x", "delivered", "1"));
  const key = await deterministicEventKey("cloudflare", "t", "m", "r", "ts");
  assert.match(key, /^[0-9a-f]{40}$/);
});

test("capabilities summary table is explicit and distinct", () => {
  const table = {
    resend: { window: resend.RESEND_SAFE_RETRY_WINDOW_MS, events: "webhook", idempotency: true },
    brevo: { window: brevo.BREVO_SAFE_RETRY_WINDOW_MS, events: "webhook", idempotency: true },
    cloudflare: { window: null, events: "queue", idempotency: false },
  };
  assert.equal(table.resend.window > table.brevo.window, true, "Resend 23h > Brevo 25m");
  assert.equal(table.cloudflare.window, null);
  assert.equal(table.cloudflare.idempotency, false);
});

test("provider switching: new mail uses the active provider, retries stay pinned", () => {
  // New mail picks the currently configured provider.
  const resendEnv = fakeEnv({ OUTBOUND_PROVIDER: "resend", RESEND_API_KEY: "rk" });
  assert.equal(getOutboundProvider(resendEnv)?.id, "resend");
  const brevoEnv = fakeEnv({ OUTBOUND_PROVIDER: "brevo", BREVO_API_KEY: "bk" });
  assert.equal(getOutboundProvider(brevoEnv)?.id, "brevo");

  // M1 was sent while Resend was active; retry must use Resend even after
  // switching to Brevo.
  const bothEnv = fakeEnv({ OUTBOUND_PROVIDER: "brevo", BREVO_API_KEY: "bk", RESEND_API_KEY: "rk" });
  assert.equal(providerForMessage(bothEnv, { outbound_provider: "resend", provider_message_id: "r1" })?.id, "resend");
  // M2 sent under Brevo retries on Brevo.
  assert.equal(providerForMessage(brevoEnv, { outbound_provider: "brevo", provider_message_id: "b1" })?.id, "brevo");

  // Deleting the old provider's credential must never fall back to the
  // active provider for the pinned retry.
  assert.throws(
    () => providerForMessage(brevoEnv, { outbound_provider: "resend", provider_message_id: "r1" }),
    (error) => error.code === "provider_not_configured_for_retry",
  );
});

test("provider capability table has no false parity", () => {
  const resendP = getProviderById("resend");
  const brevoP = getProviderById("brevo");
  const cfP = getProviderById("cloudflare");
  assert.equal(resendP.capabilities.deliveryEvents, "webhook");
  assert.equal(brevoP.capabilities.deliveryEvents, "webhook");
  assert.equal(cfP.capabilities.deliveryEvents, "queue");
  assert.notEqual(resendP.capabilities.safeRetryWindowMs, brevoP.capabilities.safeRetryWindowMs, "retry windows are provider-specific");
  assert.equal(cfP.capabilities.providerIdempotency, false);
  assert.notEqual(cfP.capabilities.maxMessageBytes, null);
  assert.equal(resendP.capabilities.maxMessageBytes, null);
});

test("unknown future provider events never mutate delivery state (no delayed fallback)", async () => {
  const brevoFuture = {
    event: "future_event",
    "message-id": "m-x",
    email: "r@example.net",
    ts_event: "2026-09-03T12:00:00Z",
  };
  await assert.rejects(
    normalizeBrevoEvent(brevoFuture, "tok", "tok"),
    (error) => error.code === "unsupported_provider_event",
  );
  const cfFuture = {
    type: "cf.email.sending.message.future",
    source: { type: "email.sending", zoneId: "z", domain: "d.example.com" },
    payload: { eventId: "e1", messageId: "m1", recipient: "r@example.net" },
    metadata: { eventTimestamp: "2026-09-03T12:00:00Z" },
  };
  await assert.rejects(
    normalizeCloudflareQueueEvent(cfFuture),
    (error) => error.code === "unsupported_provider_event",
  );
});

test("Cloudflare send payload carries the complete official contract", async () => {
  const { buildCloudflarePayload, estimateProviderMessageBytes, CLOUDFLARE_EMAIL_MAX_BYTES } = cloudflare;
  const plan = {
    mailbox: { mailbox_id: "m1", address: "hello@example.com", display_name: "Hello" },
    to: ["a@example.net"], cc: ["b@example.net"], bcc: ["c@example.net"],
    subject: "Hi", text: "body", html: "",
    uploads: [{ filename: "f.txt", contentType: "text/plain", content: Buffer.from("x").toString("base64"), bytes: new Uint8Array(1) }],
    parent: null, threadId: "t1", requestHash: "h",
  };
  const payload = buildCloudflarePayload(
    { message_id: "m9", subject: "Hi", x_mailbox_mail_id: "x9", in_reply_to: "<r@example.net>", references_header: "<a> <b>" },
    plan,
    fakeEnv(),
  );
  assert.deepEqual(payload.to, ["a@example.net"]);
  assert.deepEqual(payload.cc, ["b@example.net"]);
  assert.deepEqual(payload.bcc, ["c@example.net"]);
  assert.equal(payload.headers["In-Reply-To"], "<r@example.net>");
  assert.equal(payload.headers.References, "<a> <b>");
  assert.equal(payload.headers["X-Mailbox-Mail-ID"], "x9");
  assert.equal(payload.attachments[0].disposition, "attachment");
  assert.equal(estimateProviderMessageBytes({ message_id: "m9", subject: "Hi", x_mailbox_mail_id: "x9", in_reply_to: "<r@example.net>", references_header: "<a> <b>", internet_message_id: "<m9@example.com>" }, plan, fakeEnv()) > 0, true);
  assert.ok(CLOUDFLARE_EMAIL_MAX_BYTES >= 5 * 1024 * 1024);
});

test("Cloudflare outcome-unknown errors never mark the message failed", async () => {
  const env = fakeEnv({
    OUTBOUND_PROVIDER: "cloudflare",
    EMAIL: { send: async () => { throw Object.assign(new Error("boom"), { code: "E_INTERNAL_SERVER_ERROR" }); } },
  });
  let lastUpdate = null;
  env.DB = { prepare: () => ({ bind: (...v) => ({ run: async () => { lastUpdate = v; return { meta: { changes: 1 } }; } }) }) };
  const plan = { mailbox: { mailbox_id: "m1", address: "hello@example.com", display_name: "Hello" }, to: ["a@example.net"], cc: [], bcc: [], subject: "S", text: "b", html: "", uploads: [], parent: null, threadId: "t", requestHash: "h" };
  await assert.rejects(
    getProviderById("cloudflare").send(env, { message_id: "m10", idempotency_key: "k", subject: "S", x_mailbox_mail_id: "x" }, plan),
    (error) => error.code === "provider_outcome_unknown",
  );
  assert.equal(lastUpdate[0], "sending", "E_INTERNAL_SERVER_ERROR keeps the message in an unknown-safe state");
});

test("Cloudflare success requires the official messageId field", async () => {
  const env = fakeEnv({
    OUTBOUND_PROVIDER: "cloudflare",
    EMAIL: { send: async () => ({ message_id: "wrong-field" }) },
  });
  const plan = { mailbox: { mailbox_id: "m1", address: "hello@example.com", display_name: "Hello" }, to: ["a@example.net"], cc: [], bcc: [], subject: "S", text: "b", html: "", uploads: [], parent: null, threadId: "t", requestHash: "h" };
  await assert.rejects(
    getProviderById("cloudflare").send(env, { message_id: "m11", idempotency_key: "k", subject: "S", x_mailbox_mail_id: "x" }, plan),
    (error) => error.code === "provider_outcome_unknown",
    "message_id is not the official response field",
  );
  const okEnv = fakeEnv({
    OUTBOUND_PROVIDER: "cloudflare",
    EMAIL: { send: async () => ({ messageId: "cf-ok-1" }) },
  });
  const result = await getProviderById("cloudflare").send(okEnv, { message_id: "m12", idempotency_key: "k", subject: "S", x_mailbox_mail_id: "x" }, plan);
  assert.equal(result.providerMessageId, "cf-ok-1");
});

test("Cloudflare error classifier maps official E_ codes", () => {
  const { classifyCloudflareEmailFailure } = cloudflare;
  assert.equal(classifyCloudflareEmailFailure("E_RATE_LIMIT_EXCEEDED"), "provider_rate_limited");
  assert.equal(classifyCloudflareEmailFailure("E_DAILY_LIMIT_EXCEEDED"), "provider_rate_limited");
  assert.equal(classifyCloudflareEmailFailure("E_CONTENT_TOO_LARGE"), "provider_payload_too_large");
  assert.equal(classifyCloudflareEmailFailure("E_SENDER_NOT_VERIFIED"), "provider_auth_failed");
  assert.equal(classifyCloudflareEmailFailure("E_RECIPIENT_SUPPRESSED"), "provider_rejected");
  assert.equal(classifyCloudflareEmailFailure("E_INTERNAL_SERVER_ERROR"), "provider_outcome_unknown");
  assert.equal(classifyCloudflareEmailFailure("E_SOMETHING_NEW"), "provider_outcome_unknown");
});

test("Brevo capability matrix matches the real contract", () => {
  const brevoP = getProviderById("brevo");
  assert.equal(brevoP.capabilities.threadingHeaders, false);
  assert.equal(brevoP.capabilities.attachments, true);
  assert.equal(brevoP.capabilities.ccBcc, true);
  const cfP = getProviderById("cloudflare");
  assert.equal(cfP.capabilities.threadingHeaders, true);
  assert.equal(cfP.capabilities.attachments, true);
  const resendP = getProviderById("resend");
  assert.equal(resendP.capabilities.threadingHeaders, true);
});

test("official wire-contract fixtures parse into the canonical fields", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const fixtures = (name) => JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "providers", name), "utf8"));

  const cfDelivered = await normalizeCloudflareQueueEvent(fixtures("cloudflare/delivered.json"));
  assert.equal(cfDelivered.providerMessageId, "cf-sent-000000000001");
  assert.equal(cfDelivered.providerEventId, "42cf9a81-1c2e-4d5f-8a9b-0c1d2e3f4a5b");
  assert.deepEqual(cfDelivered.recipients, ["alice@example.net"]);
  assert.equal(cfDelivered.status, "delivered");

  const cfBounced = await normalizeCloudflareQueueEvent(fixtures("cloudflare/bounced.json"));
  assert.equal(cfBounced.status, "bounced");
  assert.equal(cfBounced.providerEventId, "a5b6c7d8-e9f0-4a1b-8c2d-3e4f5a6b7c8d");

  const brevoDelivered = await normalizeBrevoEvent(fixtures("brevo/delivered.json"), "tok", "tok");
  assert.equal(brevoDelivered.providerMessageId, "brevo-000000000001", "message-id (not message_id) is canonical");
  assert.equal(brevoDelivered.taggedMessageId, "msg-brev-1");
  assert.equal(brevoDelivered.occurredAt, "2026-09-03T12:00:00.000Z", "ts_event normalized to ISO");

  const brevoBounce = await normalizeBrevoEvent(fixtures("brevo/hardbounce.json"), "tok", "tok");
  assert.equal(brevoBounce.status, "bounced");
  assert.equal(brevoBounce.providerMessageId, "brevo-000000000002");

  const resendDelivered = normalizeResendEvent(fixtures("resend/delivered.json"), "svix-00000000000000000000000000000000");
  assert.equal(resendDelivered.providerMessageId, "resend-000000000001");
  assert.equal(resendDelivered.status, "delivered");
  assert.equal(resendDelivered.providerEventId, "svix-00000000000000000000000000000000");

  const cfReplay = await normalizeCloudflareQueueEvent(fixtures("cloudflare/delivered.json"));
  assert.equal(cfReplay.providerEventId, cfDelivered.providerEventId, "official payload.eventId is replay-stable");
});
