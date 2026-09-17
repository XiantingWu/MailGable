import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync(":memory:");
try {
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
  const columns = database.prepare("PRAGMA table_info(mail_messages)").all();
  const names = new Set(columns.map((row) => String(row.name)));
  for (const required of [
    "request_hash",
    "provider_internet_message_id",
    "body_truncated",
    "recipient_status_json",
    "reply_to_json",
  ]) {
    if (!names.has(required)) throw new Error(`Missing migrated column: ${required}`);
  }
  const mailboxColumns = database.prepare("PRAGMA table_info(mailboxes)").all();
  if (!mailboxColumns.some((row) => String(row.name) === "routing_managed")) {
    throw new Error("Missing migrated column: routing_managed");
  }
  const messageColumns = database.prepare("PRAGMA table_info(mail_messages)").all();
  const messageNames = new Set(messageColumns.map((row) => String(row.name)));
  for (const required of ["outbound_provider", "provider_message_id"]) {
    if (!messageNames.has(required)) throw new Error(`Missing migrated provider column: ${required}`);
  }
  const eventColumns = database.prepare("PRAGMA table_info(mail_delivery_events)").all();
  const eventNames = new Set(eventColumns.map((row) => String(row.name)));
  for (const required of ["provider", "provider_event_id"]) {
    if (!eventNames.has(required)) throw new Error(`Missing migrated provider event column: ${required}`);
  }
  const threadColumns = database.prepare("PRAGMA table_info(mail_threads)").all();
  const threadNames = new Set(threadColumns.map((row) => String(row.name)));
  for (const required of ["latest_message_id", "latest_direction", "latest_sender_json", "latest_preview", "has_incoming", "has_outgoing", "has_attachment"]) {
    if (!threadNames.has(required)) throw new Error(`Missing migrated thread summary column: ${required}`);
  }
  const threadsTable = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mail_threads'").get();
  const threadsSql = String(threadsTable?.sql || "");
  if (!threadsSql.includes("'archived'") || threadsSql.includes("'closed'")) {
    throw new Error("mail_threads status CHECK must use the archived vocabulary");
  }
  const mailboxCount = database.prepare("SELECT COUNT(*) AS count FROM mailboxes").get();
  if (Number(mailboxCount?.count) !== 0) {
    throw new Error("Fresh migrations must not seed hardcoded mailbox identities");
  }
  const forwardTable = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='inbound_forward_attempts'",
  ).get();
  const forwardSql = String(forwardTable?.sql || "");
  if (!forwardSql.includes("PRIMARY KEY (message_id, target)") || !forwardSql.includes("'accepted'")) {
    throw new Error("Missing or invalid inbound_forward_attempts table");
  }
  const probeTable = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mail_ops_probes'").get();
  if (!probeTable) throw new Error("Missing migrated table: mail_ops_probes");
  const adminsTable = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='admins'").get();
  if (!String(adminsTable?.sql || "").includes("BETWEEN 1000 AND 100000")) {
    throw new Error("admins password_iterations CHECK was not relaxed");
  }
  const adminsColumns = database.prepare("PRAGMA table_info(admins)").all();
  if (!adminsColumns.some((row) => String(row.name) === "password_scheme")) {
    throw new Error("Missing migrated column: password_scheme");
  }
  const auditIndexes = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_admin_audit_request'").get();
  if (!String(auditIndexes?.sql || "").startsWith("CREATE INDEX")) {
    throw new Error("idx_admin_audit_request must be a non-unique index");
  }
  database.prepare(
    "INSERT INTO admins(admin_id,email,password_hash,password_salt,password_iterations,password_scheme,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run("smoke-admin", "smoke@example.com", "hash", "salt", 8000, "pbkdf2-sha256+hmac-sha256-v1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  console.log("SQLite migration smoke test passed.");
} finally {
  database.close();
}
