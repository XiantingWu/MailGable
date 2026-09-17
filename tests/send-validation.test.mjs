import { loadMailModule } from "./helpers/mail-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import * as lib from "../.test-build/src/lib.js";

const loaded = await loadMailModule();
const {
  boundedBody,
  buildSendPlan,
  parseUploads,
  readTextLimited,
  strictRecipientList,
} = loaded;
const { isRetryableResendResponse } = await import("../.test-build/src/resend-policy.js");

function attachment(index = 0) {
  return {
    filename: `file-${index}.txt`,
    contentType: "text/plain",
    content: Buffer.from(`attachment-${index}`).toString("base64"),
  };
}

function environment({ parent = null } = {}) {
  const mailbox = {
    mailbox_id: "support",
    address: "support@example.com",
    display_name: "Support",
    active: 1,
    can_send: 1,
  };
  return {
    MAIL_DOMAIN: "example.com",
    AUTO_BCC_ADDRESSES: "forward@example.org,backup@example.org",
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async first() {
                if (sql.includes("FROM mailboxes")) return values[0] === "support" ? mailbox : null;
                if (sql.includes("FROM mail_messages")) return parent && values[0] === parent.message_id ? parent : null;
                return null;
              },
            };
          },
        };
      },
    },
  };
}

test("loads executable send validation helpers", () => {
  assert.equal(typeof strictRecipientList, "function");
  assert.equal(typeof parseUploads, "function");
  assert.equal(typeof isRetryableResendResponse, "function");
  assert.equal(typeof boundedBody, "function");
  assert.equal(typeof buildSendPlan, "function");
  assert.equal(typeof readTextLimited, "function");
});

test("strict recipient validation rejects invalid and excessive input", () => {
  assert.deepEqual(strictRecipientList("A@example.com, a@example.com; b@example.com", "To"), ["a@example.com", "b@example.com"]);
  assert.throws(() => strictRecipientList("valid@example.com, invalid-address", "To"), (error) => error?.code === "invalid_recipient");
  assert.throws(
    () => strictRecipientList(Array.from({ length: 51 }, (_, index) => `user${index}@example.com`), "To"),
    (error) => error?.code === "too_many_recipients",
  );
});

test("outgoing attachment validation never truncates files", () => {
  assert.equal(parseUploads(Array.from({ length: 10 }, (_, index) => attachment(index))).length, 10);
  assert.throws(
    () => parseUploads(Array.from({ length: 11 }, (_, index) => attachment(index))),
    (error) => error?.code === "too_many_attachments",
  );
  const maxEncodedLength = Math.ceil((5 * 1024 * 1024) / 3) * 4;
  assert.throws(
    () => parseUploads([{ filename: "too-large.bin", contentType: "application/octet-stream", content: "A".repeat(maxEncodedLength + 1) }]),
    (error) => error?.code === "attachment_too_large",
  );
  assert.throws(
    () => parseUploads([{ filename: "invalid.bin", contentType: "application/octet-stream", content: { value: "AAAA" } }]),
    (error) => error?.code === "invalid_attachment",
  );
});

test("message bodies fail rather than truncate", () => {
  assert.equal(boundedBody("hello", 5, "Text body"), "hello");
  assert.throws(() => boundedBody("hello!", 5, "Text body"), (error) => error?.code === "message_body_too_large");
  assert.throws(() => boundedBody({ text: "hello" }, 100, "Text body"), (error) => error?.code === "invalid_body");
});

test("client-selected thread IDs require a parent message", async () => {
  await assert.rejects(
    buildSendPlan({
      from_mailbox_id: "support",
      to: "user@example.com",
      text: "hello",
      thread_id: "support-thread",
      attachments: [],
    }, environment()),
    (error) => error?.code === "thread_parent_required",
  );
});

test("reply parent must belong to the selected mailbox", async () => {
  const parent = { message_id: "parent-1", thread_id: "thread-1", mailbox_id: "contact" };
  await assert.rejects(
    buildSendPlan({
      from_mailbox_id: "support",
      to: "user@example.com",
      text: "hello",
      parent_message_id: parent.message_id,
      attachments: [],
    }, environment({ parent })),
    (error) => error?.code === "reply_mailbox_mismatch",
  );
});

test("webhook reader stops once its byte limit is exceeded", async () => {
  const request = new Request("https://example.test/webhook", {
    method: "POST",
    body: "0123456789ABCDEF",
  });
  await assert.rejects(readTextLimited(request, 8), (error) => error?.code === "body_too_large");
});

test("temporary provider responses remain retryable", () => {
  for (const status of [408, 425, 429, 500, 502, 503]) assert.equal(isRetryableResendResponse(status), true, String(status));
  assert.equal(isRetryableResendResponse(409, "concurrent_idempotent_requests"), true);
  assert.equal(isRetryableResendResponse(409, "invalid_idempotent_request"), false);
  assert.equal(isRetryableResendResponse(422, "validation_error"), false);
});
