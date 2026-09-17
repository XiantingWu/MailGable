import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import * as lib from "../.test-build/src/lib.js";
import Module from "node:module";

const require = createRequire(import.meta.url);
const source = await readFile("src/mail.ts", "utf8");
const parsedMail = {
  headers: [],
  headerLines: [],
  attachments: [],
  text: "identical inbound body",
  html: "",
  subject: "Concurrent inbound",
  from: { name: "External Sender", address: "sender@example.com" },
  to: { name: "Support", address: "support@example.com" },
  cc: [],
  bcc: [],
};
const compiled = require.resolve("../.test-build/src/mail.js");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../lib.js" || request === "./lib.js") return lib;
  if (request === "../auth.js" || request === "./auth.js") return { audit: async () => undefined };
  if (request === "postal-mime") return { default: { parse: async () => parsedMail } };
  return originalLoad.call(this, request, parent, isMain);
};
const loaded = require(compiled);
Module._load = originalLoad;
const { handleInbound, storageProbe, updateRecipientSummary } = loaded;

function inboundMessage(forwardTracker) {
  return {
    from: "sender@example.com",
    to: "support@example.com",
    raw: new TextEncoder().encode("From: sender@example.com\r\nTo: support@example.com\r\nSubject: Concurrent inbound\r\n\r\nidentical inbound body"),
    rawSize: 128,
    headers: new Headers(),
    setReject(reason) {
      throw new Error(`message unexpectedly rejected: ${reason}`);
    },
    async forward(target) {
      forwardTracker.add(target);
    },
  };
}

function createInboundEnvironment() {
  const mailbox = {
    mailbox_id: "support",
    address: "support@example.com",
    display_name: "Support",
    active: 1,
    can_receive: 1,
    can_send: 1,
  };
  const threads = new Map();
  const messages = new Map();
  const objects = new Map();
  const forwardAttempts = new Map();
  const forwardedTargets = new Set();

  const DB = {
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes("FROM mailboxes WHERE address=")) return values[0] === mailbox.address ? mailbox : null;
              if (sql.includes("FROM mail_messages WHERE message_id=")) return messages.get(values[0]) || null;
              if (sql.includes("internet_message_id") || sql.includes("x_mailbox_mail_id")) return null;
              if (sql.includes("SELECT status FROM inbound_forward_attempts")) {
                const row = forwardAttempts.get(`${values[0]}|${values[1]}`);
                return row ? { status: row.status } : null;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT OR IGNORE INTO mail_threads")) {
                const [threadId, mailboxId, subject, participants, lastMessageAt, createdAt, updatedAt] = values;
                if (!threads.has(threadId)) {
                  threads.set(threadId, {
                    thread_id: threadId,
                    mailbox_id: mailboxId,
                    subject,
                    participants_json: participants,
                    last_message_at: lastMessageAt,
                    created_at: createdAt,
                    updated_at: updatedAt,
                  });
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              if (sql.includes("INSERT OR IGNORE INTO mail_messages")) {
                const messageId = values[0];
                if (messages.has(messageId)) return { meta: { changes: 0 } };
                messages.set(messageId, {
                  message_id: messageId,
                  thread_id: values[1],
                  mailbox_id: values[2],
                  subject: values[11],
                  received_at: values[22],
                  raw_r2_key: values[23],
                  raw_r2_size: values[24],
                  archive_status: values[25],
                  created_at: values[26],
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("INSERT OR IGNORE INTO inbound_forward_attempts")) {
                const [messageId, target, createdAt, updatedAt] = values;
                const key = `${messageId}|${target}`;
                if (forwardAttempts.has(key)) return { meta: { changes: 0 } };
                forwardAttempts.set(key, { message_id: messageId, target, status: "pending", attempts: 0, created_at: createdAt, updated_at: updatedAt });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("SET status='in_flight'")) {
                const [attemptedAt, updatedAt, messageId, target] = values;
                const key = `${messageId}|${target}`;
                const row = forwardAttempts.get(key);
                if (row && (row.status === "pending" || row.status === "failed")) {
                  row.status = "in_flight";
                  row.attempts += 1;
                  row.last_attempt_at = attemptedAt;
                  row.updated_at = updatedAt;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              if (sql.includes("SET status='accepted'")) {
                const [acceptedAt, updatedAt, messageId, target] = values;
                const row = forwardAttempts.get(`${messageId}|${target}`);
                if (row) {
                  row.status = "accepted";
                  row.last_error = null;
                  row.accepted_at = row.accepted_at || acceptedAt;
                  row.updated_at = updatedAt;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              if (sql.includes("SET status='failed'")) {
                const [lastError, updatedAt, messageId, target] = values;
                const row = forwardAttempts.get(`${messageId}|${target}`);
                if (row && row.status !== "accepted") {
                  row.status = "failed";
                  row.last_error = lastError;
                  row.updated_at = updatedAt;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              if (sql.includes("SET mailbox_id=COALESCE")) {
                const threadId = values[6];
                const row = threads.get(threadId);
                assert.ok(row);
                row.mailbox_id ||= values[0];
                if (!row.subject) row.subject = values[1];
                row.participants_json = values[2];
                if (String(row.last_message_at) < String(values[3])) row.last_message_at = values[4];
                row.updated_at = values[5];
                return { meta: { changes: 1 } };
              }
              if (sql.includes("archive_status='archived'")) {
                const messageId = values.at(-1);
                const row = messages.get(messageId);
                if (row && row.archive_status === "pending") row.archive_status = "archived";
                return { meta: { changes: row ? 1 : 0 } };
              }
              if (sql.includes("archive_status='partial'")) {
                const messageId = values.at(-1);
                const row = messages.get(messageId);
                if (row) row.archive_status = "partial";
                return { meta: { changes: row ? 1 : 0 } };
              }
              if (sql.includes("DELETE FROM mail_threads")) {
                const threadId = values[0];
                const used = [...messages.values()].some((message) => message.thread_id === threadId);
                if (!used) threads.delete(threadId);
                return { meta: { changes: used ? 0 : 1 } };
              }
              if (sql.includes("SET unread_count=")) {
                const threadId = values.at(-1);
                const row = threads.get(threadId);
                const threadMessages = [...messages.values()].filter((message) => message.thread_id === threadId);
                if (row && threadMessages.length) {
                  row.last_message_at = threadMessages.map((message) => message.received_at || message.created_at).sort().at(-1);
                }
                return { meta: { changes: row ? 1 : 0 } };
              }
              throw new Error(`Unhandled SQL in inbound test: ${sql}`);
            },
          };
        },
      };
    },
  };

  const MAIL_R2 = {
    async put(key, value) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      objects.set(key, Uint8Array.from(bytes));
      await Promise.resolve();
    },
    async delete(key) {
      objects.delete(key);
    },
    async get(key) {
      const value = objects.get(key);
      return value ? { body: value, size: value.byteLength } : null;
    },
  };

  return {
    env: {
      DB,
      MAIL_R2,
      MAIL_DOMAIN: "example.com",
      MAILBOX_ADDRESSES: "support@example.com,contact@example.com,privacy@example.com",
      INBOUND_FORWARD_TO: "forward@example.org,backup@example.org",
    },
    threads,
    messages,
    objects,
    forwardAttempts,
    forwardedTargets,
  };
}

test("concurrent identical inbound deliveries keep one complete D1/R2 archive", async () => {
  const { env, threads, messages, objects, forwardAttempts, forwardedTargets } = createInboundEnvironment();
  await Promise.all([
    handleInbound(inboundMessage(forwardedTargets), env, {}),
    handleInbound(inboundMessage(forwardedTargets), env, {}),
  ]);
  assert.equal(messages.size, 1);
  assert.equal(threads.size, 1);
  assert.equal(objects.size, 1);
  const message = [...messages.values()][0];
  assert.equal(message.archive_status, "archived");
  assert.ok(objects.has(message.raw_r2_key));
  assert.equal(threads.get(message.thread_id).last_message_at, message.received_at);
  assert.deepEqual([...forwardedTargets].sort(), ["backup@example.org", "forward@example.org"]);

  for (const row of forwardAttempts.values()) {
    assert.equal(row.status, "accepted");
    assert.equal(row.attempts, 1, "concurrent redelivery must not re-forward an accepted target");
  }
});

test("recipient status merging is monotonic", () => {
  const opened = updateRecipientSummary({}, ["user@example.com"], "opened");
  const deliveredAfterOpened = updateRecipientSummary(opened, ["user@example.com"], "delivered");
  assert.equal(deliveredAfterOpened["user@example.com"], "opened");
  const bounced = updateRecipientSummary(deliveredAfterOpened, ["user@example.com"], "bounced");
  assert.equal(bounced["user@example.com"], "bounced");
  assert.notEqual(opened, deliveredAfterOpened, "merge must not mutate the caller's snapshot");
});

test("storage probe performs and cleans up real D1 and R2 operations", async () => {
  const probes = new Map();
  const objects = new Map();
  const DB = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async run() {
              if (sql.startsWith("INSERT INTO mail_ops_probes")) {
                probes.set(values[0], { probe_id: values[0], payload_hash: values[1], created_at: values[2] });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("DELETE FROM mail_ops_probes")) {
                const changed = probes.delete(values[0]);
                return { meta: { changes: changed ? 1 : 0 } };
              }
              throw new Error(`Unhandled SQL in storage probe: ${sql}`);
            },
            async first() {
              if (sql.includes("SELECT payload_hash FROM mail_ops_probes")) return probes.get(values[0]) || null;
              if (sql.includes("SELECT probe_id FROM mail_ops_probes")) return probes.get(values[0]) || null;
              return null;
            },
          };
        },
      };
    },
  };
  const MAIL_R2 = {
    async put(key, value) {
      objects.set(key, Uint8Array.from(value));
    },
    async get(key) {
      const value = objects.get(key);
      return value ? { body: value, size: value.byteLength } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  const response = await storageProbe({ DB, MAIL_R2 });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    database_read_write_delete: true,
    archive_read_write_delete: true,
  });
  assert.equal(probes.size, 0);
  assert.equal(objects.size, 0);
});
