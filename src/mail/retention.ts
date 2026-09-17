import { logError } from "../log.js";
import {
  AppError,
  asInt,
  asText,
  now,
  type Env,
  type Row,
} from "../lib.js";
import { DEFAULT_RETENTION_DAYS, RETENTION_DAYS_MAX, TRASH_DEFAULT_RETENTION_DAYS } from "./constants.js";
import { threadR2ObjectKeys } from "./threads.js";

export function messageRetentionDays(env: Env): number {
  return asInt(env.MESSAGE_RETENTION_DAYS, DEFAULT_RETENTION_DAYS, 0, RETENTION_DAYS_MAX);
}

export function trashRetentionDays(env: Env): number {
  return asInt(env.TRASH_RETENTION_DAYS, TRASH_DEFAULT_RETENTION_DAYS, 1, RETENTION_DAYS_MAX);
}

export async function deleteThreadData(env: Env, threadId: string): Promise<{ deleted_keys: number }> {
  const keys = await threadR2ObjectKeys(env, threadId);
  const uniqueKeys = [...new Set(keys.map((row) => asText(row.key, 1_000)).filter(Boolean))];

  // R2 deletion must fully succeed before any D1 row is touched. Any failure
  // keeps the D1 metadata intact so a later retry can still locate the
  // objects. R2Bucket.delete is idempotent for already-absent keys and
  // accepts up to 1000 keys per call.
  for (let index = 0; index < uniqueKeys.length; index += 1000) {
    const chunk = uniqueKeys.slice(index, index + 1000);
    try {
      await env.MAIL_R2.delete(chunk);
    } catch {
      throw new AppError(503, "Archive deletion is incomplete; metadata was preserved for retry.", "deletion_incomplete");
    }
  }

  const messages = await env.DB.prepare("SELECT message_id FROM mail_messages WHERE thread_id=?").bind(threadId).all<Row>();
  for (const message of messages.results || []) {
    await env.DB.prepare("DELETE FROM mail_delivery_events WHERE message_id=?").bind(message.message_id).run();
  }
  await env.DB.prepare("DELETE FROM mail_messages WHERE thread_id=?").bind(threadId).run();
  await env.DB.prepare("DELETE FROM mail_threads WHERE thread_id=?").bind(threadId).run();
  return { deleted_keys: uniqueKeys.length };
}

const RETENTION_BATCH_LIMIT = 50;

export async function cleanupMail(env: Env): Promise<void> {
  const webhookCutoff = new Date(Date.now() - 180 * 24 * 60 * 60_000).toISOString();
  const auditCutoff = new Date(Date.now() - 365 * 24 * 60 * 60_000).toISOString();
  const probeCutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const forwardingCutoff = new Date(Date.now() - 180 * 24 * 60 * 60_000).toISOString();
  const statements = [
    env.DB.prepare("DELETE FROM mail_delivery_events WHERE received_at<?").bind(webhookCutoff),
    env.DB.prepare("DELETE FROM admin_audit_log WHERE created_at<?").bind(auditCutoff),
    env.DB.prepare("DELETE FROM mail_ops_probes WHERE created_at<?").bind(probeCutoff),
    env.DB.prepare(
      "DELETE FROM inbound_forward_attempts WHERE updated_at<? AND status IN ('accepted','failed')",
    ).bind(forwardingCutoff),
  ];

  const retention = messageRetentionDays(env);
  if (retention > 0) {
    const cutoff = new Date(Date.now() - retention * 24 * 60 * 60_000).toISOString();
    // Bounded, oldest-first batch per scheduled run; the next run continues.
    const expired = await env.DB.prepare(
      "SELECT thread_id FROM mail_threads WHERE status<>'trash' AND last_message_at<? ORDER BY last_message_at ASC, thread_id ASC LIMIT ?",
    ).bind(cutoff, RETENTION_BATCH_LIMIT).all<Row>();
    for (const row of expired.results || []) {
      const threadId = String(row.thread_id || "");
      if (!threadId) continue;
      try {
        await deleteThreadData(env, threadId);
      } catch (error) {
        // The thread remains fully intact; the next scheduled run retries.
        logError(env, "Retention deletion deferred", { thread_id: threadId, error: error instanceof Error ? error.name : "unknown" });
      }
    }
  }

  const trashRetention = trashRetentionDays(env);
  const trashCutoff = new Date(Date.now() - trashRetention * 24 * 60 * 60_000).toISOString();
  // Bounded, oldest-first batch per scheduled run; the next run continues.
  const expiredTrash = await env.DB.prepare(
    "SELECT thread_id FROM mail_threads WHERE status='trash' AND updated_at<? ORDER BY updated_at ASC, thread_id ASC LIMIT ?",
  ).bind(trashCutoff, RETENTION_BATCH_LIMIT).all<Row>();
  for (const row of expiredTrash.results || []) {
    const threadId = String(row.thread_id || "");
    if (!threadId) continue;
    try {
      await deleteThreadData(env, threadId);
    } catch (error) {
      // The thread remains fully intact; the next scheduled run retries.
      logError(env, "Trash purge deferred", { thread_id: threadId, error: error instanceof Error ? error.name : "unknown" });
    }
  }

  await env.DB.batch(statements);
}