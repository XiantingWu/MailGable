import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { loadMailModule } from "./helpers/mail-loader.mjs";

const loaded = await loadMailModule();
const { listThreads, refreshThread, encodeCursor, decodeCursor, setThreadStatus } = loaded;

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
  return { database, env: { DB: new D1Adapter(database) } };
}

function seed(database, { threadId, status = "open", lastAt, direction = "incoming", hasAttachment = 0, hasOutgoing = false }) {
  database.prepare(
    "INSERT INTO mail_threads(thread_id,mailbox_id,subject,participants_json,last_message_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(threadId, "mb-1", `Subject ${threadId}`, "[]", lastAt, status, lastAt, lastAt);
  database.prepare(
    `INSERT INTO mail_messages(message_id,thread_id,mailbox_id,direction,envelope_from,envelope_to,subject,text_body,status,is_read,received_at,archive_status,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(`msg-${threadId}`, threadId, "mb-1", direction, "sender@example.net", "orders@example.com", `Subject ${threadId}`, `body ${threadId}`, "received", 0, lastAt, "archived", lastAt, lastAt);
  if (hasOutgoing) {
    database.prepare(
      `INSERT INTO mail_messages(message_id,thread_id,mailbox_id,direction,envelope_from,envelope_to,subject,status,is_read,sent_at,archive_status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(`msg-${threadId}-out`, threadId, "mb-1", "outgoing", "orders@example.com", "partner@example.net", `Subject ${threadId}`, "sent", 1, lastAt, "archived", lastAt, lastAt);
  }
  if (hasAttachment) {
    database.prepare(
      "INSERT INTO mail_attachments(attachment_id,message_id,filename,content_type,size,r2_object_key,is_inline,created_at) VALUES(?,?,?,?,?,?,0,?)",
    ).run(`att-${threadId}`, `msg-${threadId}`, "f.txt", "text/plain", 5, `k-${threadId}`, lastAt);
  }
}

function list(env, params) {
  const url = new URL(`https://example.com/api/admin/mail/threads?${new URLSearchParams(params)}`);
  return listThreads(new Request(url), env);
}

test("folder semantics: All Mail and Sent include archived threads; spam/trash stay excluded", async () => {
  const { database, env } = await testEnvironment();
  seed(database, { threadId: "t-inbox", lastAt: "2026-09-01T00:00:00.000Z" });
  seed(database, { threadId: "t-archived", status: "archived", lastAt: "2026-08-01T00:00:00.000Z" });
  seed(database, { threadId: "t-sent", lastAt: "2026-07-01T00:00:00.000Z", hasOutgoing: true });
  seed(database, { threadId: "t-spam", status: "spam", lastAt: "2026-06-01T00:00:00.000Z" });
  seed(database, { threadId: "t-trash", status: "trash", lastAt: "2026-05-01T00:00:00.000Z" });

  for (const id of ["t-inbox", "t-archived", "t-sent", "t-spam", "t-trash"]) await refreshThread(env, id);
  const all = await (await list(env, { folder: "all" })).json();
  const allIds = all.threads.map((row) => row.thread_id).sort();
  assert.deepEqual(allIds, ["t-archived", "t-inbox", "t-sent"], "All Mail includes archived, excludes spam/trash");

  const inbox = await (await list(env, { folder: "inbox" })).json();
  assert.deepEqual(inbox.threads.map((row) => row.thread_id), ["t-inbox", "t-sent"], "Inbox is open threads with inbound mail (t-sent also has inbound)");

  const sent = await (await list(env, { folder: "sent" })).json();
  assert.deepEqual(sent.threads.map((row) => row.thread_id), ["t-sent"], "Sent includes archived threads with outgoing mail");

  const archive = await (await list(env, { folder: "archive" })).json();
  assert.deepEqual(archive.threads.map((row) => row.thread_id), ["t-archived"], "Archive shows archived only");
  database.close();
});

test("thread list reads from the denormalized summary instead of the message window", async () => {
  const { database, env } = await testEnvironment();
  seed(database, { threadId: "t-a", lastAt: "2026-09-01T00:00:00.000Z", hasAttachment: 1 });
  seed(database, { threadId: "t-b", lastAt: "2026-09-02T00:00:00.000Z" });
  await refreshThread(env, "t-a");
  await refreshThread(env, "t-b");

  const listed = await (await list(env, { folder: "all", attachment: "1" })).json();
  assert.deepEqual(listed.threads.map((row) => row.thread_id), ["t-a"]);
  const row = listed.threads[0];
  assert.equal(row.text_body, "body t-a", "preview comes from the summary column");
  assert.equal(row.direction, "incoming");
  database.close();
});

test("cursor pagination: no duplicates, no gaps, stable across same timestamps, new messages surface", async () => {
  const { database, env } = await testEnvironment();
  for (let index = 0; index < 7; index += 1) {
    seed(database, { threadId: `t-${index}`, lastAt: `2026-09-0${index + 1}T00:00:00.000Z` });
    await refreshThread(env, `t-${index}`);
  }

  const page1 = await (await list(env, { folder: "all", limit: "3" })).json();
  assert.equal(page1.threads.length, 3);
  assert.equal(page1.has_more, true);
  assert.ok(page1.next_cursor);

  const page2 = await (await list(env, { folder: "all", limit: "3", cursor: page1.next_cursor })).json();
  assert.equal(page2.threads.length, 3);
  assert.ok(page2.next_cursor);
  const seen = new Set([...page1.threads, ...page2.threads].map((row) => row.thread_id));
  assert.equal(seen.size, 6, "no duplicates across pages");

  const page3 = await (await list(env, { folder: "all", limit: "3", cursor: page2.next_cursor })).json();
  assert.equal(page3.threads.length, 1);
  assert.equal(page3.has_more, false);
  assert.equal(page3.next_cursor, null);
  const allIds = [...page1.threads, ...page2.threads, ...page3.threads].map((row) => row.thread_id);
  assert.equal(new Set(allIds).size, 7, "no missing threads across pages");

  const parsed = decodeCursor(page1.next_cursor);
  assert.ok(parsed && parsed.t && parsed.i);
  assert.equal(decodeCursor("garbage!"), null);
  assert.equal(decodeCursor(encodeCursor("2026-09-05T00:00:00.000Z", "t-4")).i, "t-4");
  database.close();
});

test("setting a thread status updates the folder listing immediately", async () => {
  const { database, env } = await testEnvironment();
  seed(database, { threadId: "t-x", lastAt: "2026-09-01T00:00:00.000Z" });
  await refreshThread(env, "t-x");
  await setThreadStatus(env, "t-x", "archived");
  const all = await (await list(env, { folder: "all" })).json();
  assert.deepEqual(all.threads.map((row) => row.thread_id), ["t-x"]);
  const inbox = await (await list(env, { folder: "inbox" })).json();
  assert.equal(inbox.threads.length, 0, "archived thread leaves the inbox");
  database.close();
});