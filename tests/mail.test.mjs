import test from "node:test";
import assert from "node:assert/strict";
import { aggregateDeliveryStatus, verifySvixSignature } from "../.test-build/src/lib.js";
import { handleInbound } from "../.test-build/src/mail/inbound.js";
import { MAX_RAW_BYTES } from "../.test-build/src/mail/constants.js";
import { addressArray, previewBody, safeHeaderValue } from "../.test-build/src/mail/helpers.js";

test("oversized inbound messages are rejected before parsing or storage", async () => {
  const rejections = [];
  const message = {
    rawSize: MAX_RAW_BYTES + 1,
    setReject: (reason) => rejections.push(String(reason)),
    to: "hello@example.com",
    from: "sender@example.net",
    headers: new Headers(),
    raw: new ReadableStream(),
  };
  // An empty env would throw if the handler touched D1/R2 before rejecting.
  await handleInbound(message, {}, {});
  assert.equal(rejections.length, 1);
  assert.match(rejections[0], /limit|exceeds/i);
});

test("preview, header, and address helpers stay bounded under pathological input", () => {
  const preview = previewBody("A".repeat(2_000_000), 300_000);
  assert.equal(preview.truncated, true);
  assert.ok(preview.value.length <= 300_000, "preview is byte-bounded");

  const header = safeHeaderValue(`head\r\ninject${"S".repeat(100_000)}`, 998);
  assert.ok(header.length <= 998, "header value is bounded");
  assert.ok(!/[\r\n]/.test(header), "CR/LF cannot survive header sanitization");

  const addresses = addressArray(Array.from({ length: 5_000 }, (_, index) => ({ address: `user${index}@example.com` })));
  assert.equal(addresses.length, 100, "header address fan-out is capped");
});

test("aggregates per-recipient delivery outcomes", () => {
  assert.equal(aggregateDeliveryStatus({ a: "delivered", b: "bounced" }), "partially_failed");
  assert.equal(aggregateDeliveryStatus({ a: "bounced", b: "sent" }), "partially_failed");
  assert.equal(aggregateDeliveryStatus({ a: "failed", b: "delivery_delayed" }), "partially_failed");
  assert.equal(aggregateDeliveryStatus({ a: "opened", b: "clicked" }), "clicked");
  assert.equal(aggregateDeliveryStatus({ a: "complained" }), "complained");
});

test("verifies valid Svix signatures and rejects stale timestamps", async () => {
  const secretBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const secret = `whsec_${Buffer.from(secretBytes).toString("base64url")}`;
  const raw = JSON.stringify({ type: "email.delivered", data: { email_id: "mail_1" } });
  const timestamp = 1_800_000_000;
  const id = "msg_test";
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${raw}`))).toString("base64");
  const headers = new Headers({ "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": `v1,${signature}` });
  assert.equal(await verifySvixSignature(raw, headers, secret, timestamp), true);
  assert.equal(await verifySvixSignature(raw, headers, secret, timestamp + 301), false);
});
