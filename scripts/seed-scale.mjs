#!/usr/bin/env node
// Generates synthetic scale data in a LOCAL SQLite file and measures the
// thread-list query plans and durations. Local only: --remote is rejected.
import { DatabaseSync } from "node:sqlite";
import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
if (args.includes("--remote")) {
  console.error("seed-scale: refusing remote execution. Local only.");
  process.exit(1);
}
const rowsArg = args.indexOf("--rows");
const rows = rowsArg >= 0 ? Number.parseInt(args[rowsArg + 1], 10) : 10_000;
const output = args.indexOf("--out") >= 0 ? args[args.indexOf("--out") + 1] : path.join(process.cwd(), ".scale-bench.sqlite");
if (!Number.isFinite(rows) || rows < 1 || rows > 200_000) {
  console.error("seed-scale: --rows must be between 1 and 200000.");
  process.exit(1);
}

await rm(output, { force: true });
const db = new DatabaseSync(output);
db.exec("PRAGMA journal_mode = OFF");
db.exec("PRAGMA synchronous = OFF");

const migrations = [
  "0001_mailbox.sql", "0002_mailbox_hardening.sql", "0003_mailbox_reply_safety.sql",
  "0004_ops_probe.sql", "0005_admin_password_iterations.sql", "0006_routing_managed_mailboxes.sql",
  "0007_inbound_forward_attempts.sql", "0008_thread_status_archived.sql",
  "0009_password_scheme_audit_index.sql", "0010_thread_summaries.sql",
];
const { readFile } = await import("node:fs/promises");
for (const migration of migrations) {
  db.exec(await readFile(path.join(process.cwd(), "migrations", migration), "utf8"));
}
db.prepare(
  "INSERT INTO mailboxes(mailbox_id,address,display_name,can_receive,can_send,active,created_at,updated_at) VALUES(?,?,?,1,1,1,?,?)",
).run("mb-1", "orders@example.com", "Orders", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

const insertThread = db.prepare(
  "INSERT INTO mail_threads(thread_id,mailbox_id,subject,participants_json,last_message_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
);
const insertMessage = db.prepare(
  `INSERT INTO mail_messages(message_id,thread_id,mailbox_id,direction,envelope_from,envelope_to,subject,text_body,status,is_read,received_at,archive_status,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
);
const summaryUpdate = db.prepare(
  `UPDATE mail_threads SET latest_message_id=?,latest_direction='incoming',latest_sender_json='[{"name":"S","address":"s@example.net"}]',latest_envelope_from='s@example.net',latest_recipient='orders@example.com',latest_preview=?,latest_message_status='received',has_incoming=1,has_outgoing=0,has_attachment=0 WHERE thread_id=?`,
);
db.exec("BEGIN");
for (let index = 0; index < rows; index += 1) {
  const threadId = `scale-${String(index).padStart(6, "0")}`;
  const stamp = `2026-09-${String((index % 28) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`;
  const subject = index % 7 === 0 ? `Quarterly report ${index}` : `Invoice ${index}`;
  const preview = `body content for message ${index}`;
  insertThread.run(threadId, "mb-1", subject, "[]", stamp, "open", stamp, stamp);
  insertMessage.run(`msg-${threadId}`, threadId, "mb-1", "incoming", "s@example.net", "orders@example.com", subject, preview, "received", 0, stamp, "archived", stamp, stamp);
  summaryUpdate.run(`msg-${threadId}`, preview, threadId);
}
db.exec("COMMIT");

function measure(label, sql, params) {
  const start = process.hrtime.bigint();
  const stmt = db.prepare(sql);
  const rowsRead = stmt.all(...params);
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`${label}: ${rowsRead.length} rows returned in ${durationMs.toFixed(1)} ms`);
  return durationMs;
}

const inboxSql = `
  SELECT t.thread_id,t.subject,t.last_message_at,t.unread_count
    FROM mail_threads t
   WHERE t.status='open' AND t.has_incoming=1
   ORDER BY t.last_message_at DESC, t.thread_id DESC
   LIMIT 41`;
const searchSql = `
  SELECT t.thread_id FROM mail_threads t
   WHERE t.status IN ('open','archived')
     AND (instr(lower(t.subject),?)>0 OR instr(lower(COALESCE(t.latest_preview,'')),?)>0)
   ORDER BY t.last_message_at DESC, t.thread_id DESC LIMIT 41`;

console.log(`seed-scale: ${rows} threads generated in ${output}`);
measure("Inbox first page (40)", inboxSql, []);
measure("All Mail first page (40)", inboxSql.replace("t.status='open' AND t.has_incoming=1", "t.status IN ('open','archived')"), []);
measure("Search 'invoice'", searchSql, ["invoice", "invoice"]);

const explain = db.prepare("EXPLAIN QUERY PLAN " + inboxSql).all();
for (const row of explain) {
  console.log(`PLAN: ${row.detail}`);
}

db.close();