import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { loadMailModule } from "./helpers/mail-loader.mjs";

const loaded = await loadMailModule();
const { storeIncomingAttachments, cleanupMail, deleteThreadData } = loaded;

class CountingD1 {
  constructor(database) {
    this.database = database;
    this.writes = 0;
  }

  prepare(sql) {
    this.writes += 1;
    return new Prepared(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) await statement.run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

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

class R2Fake {
  constructor() {
    this.objects = new Map();
  }

  async put(key, value) {
    this.objects.set(key, value);
  }

  async get(key) {
    return this.objects.has(key) ? { body: new Blob([this.objects.get(key)]) } : null;
  }

  async delete(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) this.objects.delete(key);
  }
}

async function testEnvironment() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
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
  ]) {
    database.exec(await readFile(migration, "utf8"));
  }
  database.prepare(
    "INSERT INTO mailboxes(mailbox_id,address,display_name,can_receive,can_send,active,created_at,updated_at) VALUES(?,?,?,1,1,1,?,?)",
  ).run("mb-1", "orders@example.com", "Orders", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  const r2 = new R2Fake();
  const d1 = new CountingD1(database);
  return { database, r2, d1, env: { DB: d1, MAIL_R2: r2 } };
}

function attachment(index) {
  const content = new TextEncoder().encode(`attachment-${index}-${"x".repeat(16)}`);
  return {
    filename: `file-${index}.txt`,
    mimeType: "text/plain",
    content,
    contentId: null,
    disposition: "attachment",
    related: false,
  };
}

function seedMessage(database, messageId) {
  database.prepare(
    "INSERT OR IGNORE INTO mail_threads(thread_id,mailbox_id,subject,participants_json,last_message_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run("t-holder", "mb-1", "T", "[]", "2026-01-01T00:00:00.000Z", "open", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  database.prepare(
    `INSERT INTO mail_messages(message_id,thread_id,mailbox_id,direction,envelope_from,envelope_to,subject,status,is_read,received_at,archive_status,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(messageId, "t-holder", "mb-1", "incoming", "a@example.net", "orders@example.com", "T", "received", 0, "2026-01-01T00:00:00.000Z", "archived", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

test("attachment metadata writes are batched below the D1 100-parameter limit", async () => {
  const { database, env } = await testEnvironment();
  seedMessage(database, "msg-batch");
  const d1 = env.DB;
  d1.writes = 0;
  const result = await storeIncomingAttachments(env, "msg-batch", "mb-1", Array.from({ length: 50 }, (_, index) => attachment(index)));
  assert.equal(result.stored, 50);
  const rows = database.prepare("SELECT COUNT(*) AS c FROM mail_attachments WHERE message_id=?").get("msg-batch");
  assert.equal(rows.c, 50);
  assert.ok(d1.writes <= 7, `expected <= 7 D1 queries for 50 attachment rows, got ${d1.writes}`);
  database.close();
});

test("zero and single attachment paths stay correct", async () => {
  const { database, env } = await testEnvironment();
  seedMessage(database, "msg-0");
  seedMessage(database, "msg-1");
  const zero = await storeIncomingAttachments(env, "msg-0", "mb-1", []);
  assert.equal(zero.stored, 0);
  const one = await storeIncomingAttachments(env, "msg-1", "mb-1", [attachment(1)]);
  assert.equal(one.stored, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM mail_attachments WHERE message_id=?").get("msg-1").c, 1);
  database.close();
});

test("scheduled retention processes a bounded batch per run and continues later", async () => {
  const { database, r2, env } = await testEnvironment();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  for (let index = 0; index < 55; index += 1) {
    const threadId = `t-${index}`;
    const updatedAt = new Date(now - (90 + index) * day).toISOString();
    database.prepare(
      "INSERT INTO mail_threads(thread_id,mailbox_id,subject,participants_json,last_message_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(threadId, "mb-1", "T", "[]", updatedAt, "trash", updatedAt, updatedAt);
    r2.objects.set(`k/${threadId}`, "raw");
  }
  env.TRASH_RETENTION_DAYS = "30";
  await cleanupMail(env);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS c FROM mail_threads WHERE status='trash'").get().c,
    5,
    "only the bounded batch is processed in one run",
  );
  await cleanupMail(env);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS c FROM mail_threads WHERE status='trash'").get().c,
    0,
    "the next scheduled run continues the purge",
  );
  database.close();
});

test("hard delete still works after summary columns exist", async () => {
  const { database, r2, env } = await testEnvironment();
  database.prepare(
    "INSERT INTO mail_threads(thread_id,mailbox_id,subject,participants_json,last_message_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run("t-hd", "mb-1", "T", "[]", "2026-01-01T00:00:00.000Z", "trash", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  database.prepare(
    `INSERT INTO mail_messages(message_id,thread_id,mailbox_id,direction,envelope_from,envelope_to,subject,status,is_read,received_at,raw_r2_key,raw_r2_size,archive_status,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("msg-hd", "t-hd", "mb-1", "incoming", "a@example.net", "orders@example.com", "T", "received", 0, "2026-01-01T00:00:00.000Z", "incoming/mb-1/2026/01/t-hd/original-1.eml", 100, "archived", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  r2.objects.set("incoming/mb-1/2026/01/t-hd/original-1.eml", "raw");
  const result = await deleteThreadData(env, "t-hd");
  assert.equal(result.deleted_keys, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM mail_threads WHERE thread_id=?").get("t-hd").c, 0);
  database.close();
});