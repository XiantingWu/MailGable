import test from "node:test";
import assert from "node:assert/strict";
import {
  forwardInboundCopies,
  inboundForwardAddresses,
} from "../.test-build/src/inbound-forwarding.js";

class FakeStatement {
  constructor(database, sql, args = []) {
    this.database = database;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.args = args;
  }

  bind(...args) {
    return new FakeStatement(this.database, this.sql, args);
  }

  async run() {
    const sql = this.sql;
    if (sql.startsWith("INSERT OR IGNORE INTO inbound_forward_attempts")) {
      const [messageId, target, createdAt, updatedAt] = this.args;
      const key = `${messageId}|${target}`;
      if (!this.database.rows.has(key)) {
        this.database.rows.set(key, {
          message_id: messageId,
          target,
          status: "pending",
          attempts: 0,
          last_error: null,
          last_attempt_at: null,
          accepted_at: null,
          created_at: createdAt,
          updated_at: updatedAt,
        });
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.includes("SET status='in_flight'")) {
      const [lastAttemptAt, updatedAt, messageId, target] = this.args;
      const row = this.database.rows.get(`${messageId}|${target}`);
      if (!row || !["pending", "failed"].includes(row.status)) return { meta: { changes: 0 } };
      row.status = "in_flight";
      row.attempts += 1;
      row.last_error = null;
      row.last_attempt_at = lastAttemptAt;
      row.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET status='accepted'")) {
      const [acceptedAt, updatedAt, messageId, target] = this.args;
      const row = this.database.rows.get(`${messageId}|${target}`);
      if (!row) return { meta: { changes: 0 } };
      row.status = "accepted";
      row.last_error = null;
      row.accepted_at ||= acceptedAt;
      row.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET status='failed'")) {
      const [lastError, updatedAt, messageId, target] = this.args;
      const row = this.database.rows.get(`${messageId}|${target}`);
      if (!row) return { meta: { changes: 0 } };
      if (row.status === "accepted") return { meta: { changes: 0 } };
      row.status = "failed";
      row.last_error = lastError;
      row.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unexpected run SQL: ${sql}`);
  }

  async first() {
    if (this.sql.startsWith("SELECT status FROM inbound_forward_attempts")) {
      const [messageId, target] = this.args;
      const row = this.database.rows.get(`${messageId}|${target}`);
      return row ? { status: row.status } : null;
    }
    throw new Error(`Unexpected first SQL: ${this.sql}`);
  }
}

class FakeDatabase {
  rows = new Map();
  prepare(sql) { return new FakeStatement(this, sql); }
  async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); }
  status(messageId, target) { return this.rows.get(`${messageId}|${target}`)?.status; }
}

const configuredEnv = () => ({
  DB: new FakeDatabase(),
  INBOUND_FORWARD_TO: "forward@example.org,backup@example.org",
});

function fakeMessage(handler, messageId = "<original-message@example.net>") {
  const calls = [];
  const message = {
    headers: new Headers(messageId ? { "Message-ID": messageId } : undefined),
    forward: async (target, headers) => {
      calls.push({ target, headers: new Headers(headers) });
      return handler(target, headers);
    },
  };
  return { message, calls };
}

test("accepts zero, one, or many inbound forwarding targets and deduplicates", () => {
  assert.deepEqual(inboundForwardAddresses({ INBOUND_FORWARD_TO: "" }), []);
  assert.deepEqual(inboundForwardAddresses({ INBOUND_FORWARD_TO: undefined }), []);
  assert.deepEqual(
    inboundForwardAddresses({ INBOUND_FORWARD_TO: "forward@example.org" }),
    ["forward@example.org"],
  );
  assert.deepEqual(
    inboundForwardAddresses({ INBOUND_FORWARD_TO: " BACKUP@EXAMPLE.ORG ; Forward@Example.org " }),
    ["backup@example.org", "forward@example.org"],
  );
  assert.deepEqual(
    inboundForwardAddresses({ INBOUND_FORWARD_TO: "a@example.com,backup@example.org,b@example.net" }),
    ["a@example.com", "backup@example.org", "b@example.net"],
  );
  assert.deepEqual(
    inboundForwardAddresses({ INBOUND_FORWARD_TO: "a@example.com,a@example.com" }),
    ["a@example.com"],
    "duplicate targets are removed",
  );
  for (const value of [
    "not-an-email",
    "forward@example.org,not-an-email",
  ]) {
    assert.throws(
      () => inboundForwardAddresses({ INBOUND_FORWARD_TO: value }),
      (error) => error?.code === "inbound_forward_invalid_config",
      value,
    );
  }
});

test("is a no-op when no forwarding targets are configured", async () => {
  const env = { DB: new FakeDatabase(), INBOUND_FORWARD_TO: "" };
  const { message, calls } = fakeMessage(async () => undefined);
  await forwardInboundCopies(message, env, "in_0", "orders@example.com");
  assert.equal(calls.length, 0);
  assert.equal(env.DB.rows.size, 0, "no attempt rows are created without targets");
});

test("forwards targets independently, preserves partial success, and retries only a failed target on redelivery", async () => {
  const env = configuredEnv();
  const { message, calls } = fakeMessage(async (target) => {
    if (target === "forward@example.org") throw new Error("451 temporary rate limit");
  });

  const originalError = console.error;
  console.error = () => undefined;
  try {
    await forwardInboundCopies(message, env, "in_1", "support@example.com");
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(calls.map((call) => call.target), ["forward@example.org", "backup@example.org"]);
  assert.equal(env.DB.status("in_1", "forward@example.org"), "failed");
  assert.equal(env.DB.status("in_1", "backup@example.org"), "accepted");

  const retry = fakeMessage(async () => undefined);
  await forwardInboundCopies(retry.message, env, "in_1", "support@example.com");
  assert.deepEqual(retry.calls.map((call) => call.target), ["forward@example.org"]);
  assert.equal(env.DB.status("in_1", "forward@example.org"), "accepted");
  assert.equal(env.DB.status("in_1", "backup@example.org"), "accepted");
});

test("resolves when all forward requests are accepted and skips accepted duplicates", async () => {
  const env = configuredEnv();
  const { message, calls } = fakeMessage(async () => undefined);
  await forwardInboundCopies(message, env, "in_2", "privacy@example.com");
  assert.equal(calls.length, 2);
  await forwardInboundCopies(message, env, "in_2", "privacy@example.com");
  assert.equal(calls.length, 2, "accepted targets must not be forwarded again on duplicate delivery");
});

test("adds immutable-correlation X headers without changing the original Message-ID", async () => {
  const env = configuredEnv();
  const originalMessageId = "<same-message-id@example.net>";
  const { message, calls } = fakeMessage(async () => undefined, originalMessageId);
  await forwardInboundCopies(message, env, "in_audit_1", "Support@Example.com");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.headers.get("X-Mailbox-Archive-ID"), "in_audit_1");
    assert.equal(call.headers.get("X-Mailbox-Original-Recipient"), "support@example.com");
    assert.equal(call.headers.get("X-Mailbox-Forward-Target"), call.target);
    assert.equal(call.headers.get("X-Mailbox-Original-Message-ID"), originalMessageId);
    assert.equal(call.headers.get("Message-ID"), null, "forward overrides must never replace the RFC Message-ID");
  }
});

test("omits the audit Message-ID header when the original email has no Message-ID", async () => {
  const env = configuredEnv();
  const { message, calls } = fakeMessage(async () => undefined, "");
  await forwardInboundCopies(message, env, "in_no_mid", "contact@example.com");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.headers.get("X-Mailbox-Original-Message-ID") === null));
});

test("rejects only when no target request is accepted", async () => {
  const env = configuredEnv();
  const { message } = fakeMessage(async () => { throw new Error("temporary failure"); });
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await assert.rejects(
      forwardInboundCopies(message, env, "in_3", "contact@example.com"),
      (error) => error?.code === "inbound_forward_failed",
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(env.DB.status("in_3", "forward@example.org"), "failed");
  assert.equal(env.DB.status("in_3", "backup@example.org"), "failed");
});

test("fails closed instead of forwarding back to the envelope recipient", async () => {
  const env = configuredEnv();
  const { message, calls } = fakeMessage(async () => undefined);
  await assert.rejects(
    forwardInboundCopies(message, env, "in_4", "forward@example.org"),
    (error) => error?.code === "inbound_forward_loop",
  );
  assert.equal(calls.length, 0);
});

test("a single target is forwarded and tracked like any other target", async () => {
  const env = { DB: new FakeDatabase(), INBOUND_FORWARD_TO: "archive@example.net" };
  const { message, calls } = fakeMessage(async () => undefined);
  await forwardInboundCopies(message, env, "in_5", "sales@example.com");
  assert.deepEqual(calls.map((call) => call.target), ["archive@example.net"]);
  assert.equal(env.DB.status("in_5", "archive@example.net"), "accepted");
});