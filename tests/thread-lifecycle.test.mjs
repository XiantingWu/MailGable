import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { loadMailModule } from "./helpers/mail-loader.mjs";

const loaded = await loadMailModule();
const { setThreadStatus, deleteThreadData, cleanupMail, messageRetentionDays, trashRetentionDays } = loaded;

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
      for (const statement of statements) await statement.run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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
  ]) {
    database.exec(await readFile(migration, "utf8"));
  }
  database.prepare(
    "INSERT INTO mailboxes(mailbox_id,address,display_name,can_receive,can_send,active,created_at,updated_at) VALUES(?,?,?,1,1,1,?,?)",
  ).run("mb-1", "orders@example.com", "Orders", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  const r2 = new R2Fake();
  const env = { DB: new D1Adapter(database), MAIL_R2: r2 };
  return { database, r2, env };
}

function seedThread(database, threadId, { status = "open", lastMessageAt = "2026-01-01T00:00:00.000Z", updatedAt = "2026-01-01T00:00:00.000Z" } = {}) {
  database.prepare(
    "INSERT INTO mail_threads(thread_id,mailbox_id,subject,participants_json,last_message_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(threadId, "mb-1", "Thread", "[]", lastMessageAt, status, "2026-01-01T00:00:00.000Z", updatedAt);
  database.prepare(
    `INSERT INTO mail_messages(message_id,thread_id,mailbox_id,direction,envelope_from,envelope_to,subject,status,is_read,received_at,raw_r2_key,raw_r2_size,archive_status,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(`msg-${threadId}`, threadId, "mb-1", "incoming", "sender@example.net", "orders@example.com", "Thread", "received", 0, lastMessageAt, `incoming/mb-1/2026/01/${threadId}/original-1.eml`, 100, "archived", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  database.prepare(
    "INSERT INTO mail_attachments(attachment_id,message_id,filename,content_type,size,r2_object_key,is_inline,created_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(`att-${threadId}`, `msg-${threadId}`, "file.txt", "text/plain", 10, `incoming/mb-1/2026/01/${threadId}/attachments/a-file.txt`, 0, "2026-01-01T00:00:00.000Z");
}

test("thread status transitions archive, spam, trash, and restore", async () => {
  const { database, env } = await testEnvironment();
  seedThread(database, "t1");
  await setThreadStatus(env, "t1", "archived");
  assert.equal(database.prepare("SELECT status FROM mail_threads WHERE thread_id=?").get("t1").status, "archived");
  await setThreadStatus(env, "t1", "spam");
  assert.equal(database.prepare("SELECT status FROM mail_threads WHERE thread_id=?").get("t1").status, "spam");
  await setThreadStatus(env, "t1", "trash");
  assert.equal(database.prepare("SELECT status FROM mail_threads WHERE thread_id=?").get("t1").status, "trash");
  await setThreadStatus(env, "t1", "open");
  assert.equal(database.prepare("SELECT status FROM mail_threads WHERE thread_id=?").get("t1").status, "open");
  await assert.rejects(
    setThreadStatus(env, "missing-thread", "trash"),
    (error) => error?.code === "not_found",
  );
  database.close();
});

test("hard delete removes raw, attachments, delivery events, messages, and the thread", async () => {
  const { database, r2, env } = await testEnvironment();
  seedThread(database, "t2");
  const rawKey = database.prepare("SELECT raw_r2_key FROM mail_messages WHERE thread_id=?").get("t2").raw_r2_key;
  const attKey = database.prepare("SELECT r2_object_key FROM mail_attachments WHERE message_id=?").get("msg-t2").r2_object_key;
  r2.objects.set(rawKey, "raw-bytes");
  r2.objects.set(attKey, "att-bytes");

  const result = await deleteThreadData(env, "t2");
  assert.equal(result.deleted_keys, 2);
  assert.equal(r2.objects.has(rawKey), false);
  assert.equal(r2.objects.has(attKey), false);
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM mail_threads WHERE thread_id=?").get("t2").c, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM mail_messages WHERE thread_id=?").get("t2").c, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM mail_attachments WHERE message_id=?").get("msg-t2").c, 0);
  database.close();
});

test("hard delete fails closed: any R2 failure keeps the D1 metadata for retry", async () => {
  const { database, env } = await testEnvironment();
  seedThread(database, "t3");
  const originalDelete = env.MAIL_R2.delete.bind(env.MAIL_R2);
  env.MAIL_R2.delete = async (keys) => {
    const list = Array.isArray(keys) ? keys : [keys];
    if (list.some((key) => key.includes("original"))) throw new Error("r2 unavailable");
    return originalDelete(list);
  };
  await assert.rejects(
    deleteThreadData(env, "t3"),
    (error) => error?.code === "deletion_incomplete",
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM mail_threads WHERE thread_id=?").get("t3").c, 1, "thread must remain for retry");
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM mail_messages WHERE thread_id=?").get("t3").c, 1, "message metadata must remain for retry");
  env.MAIL_R2.delete = originalDelete;
  database.close();
});

test("hard delete retry succeeds once R2 is healthy again", async () => {
  const { database, r2, env } = await testEnvironment();
  seedThread(database, "t4");
  const rawKey = database.prepare("SELECT raw_r2_key FROM mail_messages WHERE thread_id=?").get("t4").raw_r2_key;
  const attKey = database.prepare("SELECT r2_object_key FROM mail_attachments WHERE message_id=?").get("msg-t4").r2_object_key;
  r2.objects.set(rawKey, "raw-bytes");
  r2.objects.set(attKey, "att-bytes");
  let failing = true;
  const originalDelete = env.MAIL_R2.delete.bind(env.MAIL_R2);
  env.MAIL_R2.delete = async (keys) => {
    if (failing) throw new Error("r2 unavailable");
    return originalDelete(keys);
  };
  await assert.rejects(deleteThreadData(env, "t4"), (error) => error?.code === "deletion_incomplete");
  failing = false;
  const result = await deleteThreadData(env, "t4");
  assert.equal(result.deleted_keys, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM mail_threads WHERE thread_id=?").get("t4").c, 0);
  assert.equal(r2.objects.has(rawKey), false);
  env.MAIL_R2.delete = originalDelete;
  database.close();
});

test("hard delete is idempotent: already-deleted R2 objects do not block the retry", async () => {
  const { database, env } = await testEnvironment();
  seedThread(database, "t5");
  const first = await deleteThreadData(env, "t5");
  assert.equal(first.deleted_keys, 2);
  const second = await deleteThreadData(env, "t5");
  assert.equal(second.deleted_keys, 0, "no remaining rows means no keys to delete");
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM mail_threads WHERE thread_id=?").get("t5").c, 0);
  database.close();
});

test("retention parsing honors 0-as-indefinite and trash defaults", () => {
  assert.equal(messageRetentionDays({}), 0);
  assert.equal(messageRetentionDays({ MESSAGE_RETENTION_DAYS: "365" }), 365);
  assert.equal(messageRetentionDays({ MESSAGE_RETENTION_DAYS: "not-a-number" }), 0);
  assert.equal(trashRetentionDays({}), 30);
  assert.equal(trashRetentionDays({ TRASH_RETENTION_DAYS: "7" }), 7);
});

test("cleanupMail purges expired trash with R2 cleanup and leaves fresh threads intact", async () => {
  const { database, r2, env } = await testEnvironment();
  seedThread(database, "t-old", { status: "trash", updatedAt: "2020-01-01T00:00:00.000Z" });
  seedThread(database, "t-new", { status: "trash", updatedAt: "2026-08-25T00:00:00.000Z" });
  seedThread(database, "t-open", { status: "open", updatedAt: "2026-08-25T00:00:00.000Z" });
  for (const id of ["t-old", "t-new", "t-open"]) {
    r2.objects.set(`incoming/mb-1/2026/01/${id}/original-1.eml`, "raw");
  }
  await cleanupMail(env);
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM mail_threads WHERE thread_id=?").get("t-old").c, 0, "expired trash is purged");
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM mail_threads WHERE thread_id=?").get("t-new").c, 1, "recent trash is retained");
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM mail_threads WHERE thread_id=?").get("t-open").c, 1, "open threads are retained");
  assert.equal(r2.objects.has("incoming/mb-1/2026/01/t-old/original-1.eml"), false, "expired trash raw is deleted from R2");
  assert.equal(r2.objects.has("incoming/mb-1/2026/01/t-new/original-1.eml"), true, "recent trash raw stays archived");
  database.close();
});

test("scheduled trash purge fails closed: a temporary R2 failure keeps the thread for the next run", async () => {
  const { database, r2, env } = await testEnvironment();
  seedThread(database, "t-fail", { status: "trash", updatedAt: "2020-01-01T00:00:00.000Z" });
  r2.objects.set("incoming/mb-1/2026/01/t-fail/original-1.eml", "raw");
  const originalDelete = env.MAIL_R2.delete.bind(env.MAIL_R2);
  let failing = true;
  env.MAIL_R2.delete = async (keys) => {
    if (failing) throw new Error("r2 unavailable");
    return originalDelete(keys);
  };
  await cleanupMail(env);
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM mail_threads WHERE thread_id=?").get("t-fail").c, 1, "failed purge keeps the thread");
  assert.equal(r2.objects.has("incoming/mb-1/2026/01/t-fail/original-1.eml"), true, "object remains addressable for retry");
  failing = false;
  await cleanupMail(env);
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM mail_threads WHERE thread_id=?").get("t-fail").c, 0, "scheduled retry completes the purge");
  assert.equal(r2.objects.has("incoming/mb-1/2026/01/t-fail/original-1.eml"), false);
  env.MAIL_R2.delete = originalDelete;
  database.close();
});

test("cleanupMail enforces message retention when MESSAGE_RETENTION_DAYS is set", async () => {
  const { database, r2, env } = await testEnvironment();
  env.MESSAGE_RETENTION_DAYS = "30";
  seedThread(database, "t-expired", { lastMessageAt: "2020-01-01T00:00:00.000Z" });
  seedThread(database, "t-recent", { lastMessageAt: "2026-08-25T00:00:00.000Z" });
  r2.objects.set("incoming/mb-1/2026/01/t-expired/original-1.eml", "raw");
  r2.objects.set("incoming/mb-1/2026/01/t-recent/original-1.eml", "raw");
  await cleanupMail(env);
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM mail_threads WHERE thread_id=?").get("t-expired").c, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM mail_threads WHERE thread_id=?").get("t-recent").c, 1);
  assert.equal(r2.objects.has("incoming/mb-1/2026/01/t-expired/original-1.eml"), false);
  database.close();
});

test("migration 0008 upgrades pre-public closed threads to archived", async () => {
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
  ]) {
    database.exec(await readFile(migration, "utf8"));
  }
  database.prepare(
    "INSERT INTO mailboxes(mailbox_id,address,display_name,can_receive,can_send,active,created_at,updated_at) VALUES(?,?,?,1,1,1,?,?)",
  ).run("mb-1", "orders@example.com", "Orders", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  database.prepare(
    "INSERT INTO mail_threads(thread_id,mailbox_id,subject,participants_json,last_message_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run("t-legacy", "mb-1", "Legacy", "[]", "2026-01-01T00:00:00.000Z", "closed", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

  database.exec(await readFile("migrations/0008_thread_status_archived.sql", "utf8"));

  const status = database.prepare("SELECT status FROM mail_threads WHERE thread_id=?").get("t-legacy").status;
  assert.equal(status, "archived", "pre-public 'closed' rows must migrate to 'archived'");
  database.close();
});
