import {
  AppError,
  asInt,
  asText,
  base64ToBytes,
  bytesToBase64,
  decoder,
  encoder,
  json,
  normalizeEmail,
  now,
  readJson,
  sanitizeHtml,
  type Env,
  type Row,
} from "../lib.js";
import { audit, type SessionUser } from "../auth.js";
import { MAX_SUBJECT, MAX_THREAD_PAGE } from "./constants.js";
import { dateFilter, references } from "./helpers.js";

export async function findMessage(env: Env, id: string): Promise<Row | null> {
  return env.DB.prepare("SELECT * FROM mail_messages WHERE message_id=? LIMIT 1").bind(id).first<Row>();
}

export async function findMessageByInternetId(env: Env, id: string, mailboxId = ""): Promise<Row | null> {
  if (!id) return null;
  if (mailboxId) {
    return env.DB.prepare(
      `SELECT * FROM mail_messages
        WHERE (internet_message_id=? OR provider_internet_message_id=?)
          AND mailbox_id=?
        ORDER BY created_at DESC LIMIT 1`,
    ).bind(id, id, mailboxId).first<Row>();
  }
  return env.DB.prepare(
    "SELECT * FROM mail_messages WHERE internet_message_id=? OR provider_internet_message_id=? ORDER BY created_at DESC LIMIT 1",
  ).bind(id, id).first<Row>();
}

export async function findMessageByXId(env: Env, id: string): Promise<Row | null> {
  if (!id) return null;
  return env.DB.prepare("SELECT * FROM mail_messages WHERE x_mailbox_mail_id=? AND direction='outgoing' ORDER BY created_at DESC LIMIT 1")
    .bind(id).first<Row>();
}

export async function createThreadPlaceholder(
  env: Env,
  threadId: string,
  mailboxId: string | null,
  timestamp: string,
): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO mail_threads(thread_id,mailbox_id,subject,participants_json,last_message_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
  ).bind(threadId, mailboxId, "", "[]", "1970-01-01T00:00:00.000Z", timestamp, timestamp).run();
}

export async function ensureThread(
  env: Env,
  threadId: string,
  mailboxId: string | null,
  subject: string,
  participants: string[],
  timestamp: string,
): Promise<void> {
  const people = JSON.stringify([...new Set(participants.filter((value) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)))].slice(0, 100));
  await env.DB.prepare("INSERT OR IGNORE INTO mail_threads(thread_id,mailbox_id,subject,participants_json,last_message_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .bind(threadId, mailboxId, subject.slice(0, MAX_SUBJECT), people, timestamp, timestamp, timestamp).run();
  await env.DB.prepare(
    `UPDATE mail_threads
        SET mailbox_id=COALESCE(mailbox_id,?),
            subject=CASE WHEN subject='' THEN ? ELSE subject END,
            participants_json=?,
            last_message_at=CASE WHEN last_message_at<? THEN ? ELSE last_message_at END,
            updated_at=?
      WHERE thread_id=?`,
  ).bind(mailboxId, subject.slice(0, MAX_SUBJECT), people, timestamp, timestamp, now(), threadId).run();
}

export async function refreshThread(env: Env, threadId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE mail_threads
        SET unread_count=(SELECT COUNT(*) FROM mail_messages WHERE thread_id=? AND direction='incoming' AND is_read=0),
            is_replied=CASE WHEN EXISTS(SELECT 1 FROM mail_messages WHERE thread_id=? AND direction='outgoing' AND parent_message_id IS NOT NULL) THEN 1 ELSE 0 END,
            last_message_at=COALESCE((SELECT MAX(COALESCE(received_at,sent_at,created_at)) FROM mail_messages WHERE thread_id=?),last_message_at),
            latest_message_id=(SELECT m.message_id FROM mail_messages m WHERE m.thread_id=? ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC, m.created_at DESC LIMIT 1),
            latest_direction=(SELECT m.direction FROM mail_messages m WHERE m.thread_id=? ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC, m.created_at DESC LIMIT 1),
            latest_sender_json=COALESCE((SELECT COALESCE(m.from_json,'[]') FROM mail_messages m WHERE m.thread_id=? ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC, m.created_at DESC LIMIT 1),'[]'),
            latest_envelope_from=(SELECT m.envelope_from FROM mail_messages m WHERE m.thread_id=? ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC, m.created_at DESC LIMIT 1),
            latest_recipient=COALESCE((SELECT COALESCE(m.envelope_to,'') FROM mail_messages m WHERE m.thread_id=? ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC, m.created_at DESC LIMIT 1),''),
            latest_preview=COALESCE((SELECT substr(COALESCE(m.text_body,''),1,800) FROM mail_messages m WHERE m.thread_id=? ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC, m.created_at DESC LIMIT 1),''),
            latest_message_status=(SELECT m.status FROM mail_messages m WHERE m.thread_id=? ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC, m.created_at DESC LIMIT 1),
            has_incoming=CASE WHEN EXISTS(SELECT 1 FROM mail_messages WHERE thread_id=? AND direction='incoming') THEN 1 ELSE 0 END,
            has_outgoing=CASE WHEN EXISTS(SELECT 1 FROM mail_messages WHERE thread_id=? AND direction='outgoing') THEN 1 ELSE 0 END,
            has_attachment=CASE WHEN EXISTS(SELECT 1 FROM mail_attachments a JOIN mail_messages m ON m.message_id=a.message_id WHERE m.thread_id=?) THEN 1 ELSE 0 END,
            updated_at=?
      WHERE thread_id=?`,
  ).bind(
    threadId, threadId, threadId,
    threadId, threadId, threadId, threadId, threadId, threadId, threadId, threadId, threadId, threadId,
    now(), threadId,
  ).run();
}

export async function refreshThreadAttachments(env: Env, threadId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE mail_threads
        SET has_attachment=CASE WHEN EXISTS(SELECT 1 FROM mail_attachments a JOIN mail_messages m ON m.message_id=a.message_id WHERE m.thread_id=?) THEN 1 ELSE 0 END,
            updated_at=?
      WHERE thread_id=?`,
  ).bind(threadId, now(), threadId).run();
}

export async function threadFromHeaders(env: Env, inReplyTo: string, refs: string[], mailboxId: string): Promise<string> {
  const ids = [...new Set([inReplyTo, ...refs].filter(Boolean))];
  if (!ids.length) return "";
  const placeholders = ids.map(() => "?").join(",");
  const row = await env.DB.prepare(
    `SELECT thread_id FROM mail_messages
      WHERE mailbox_id=? AND (internet_message_id IN (${placeholders}) OR provider_internet_message_id IN (${placeholders}))
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(mailboxId, ...ids, ...ids).first<Row>();
  return row?.thread_id ? String(row.thread_id) : "";
}

export async function reconcileProviderMessageId(env: Env, parent: Row, internetId: string): Promise<void> {
  const normalizedId = internetId.trim();
  if (!normalizedId) return;
  const parentThread = String(parent.thread_id);
  const mailboxId = String(parent.mailbox_id || "");
  if (!mailboxId) return;
  const oldThreads = await env.DB.prepare(
    `SELECT DISTINCT thread_id FROM mail_messages
      WHERE direction='incoming' AND mailbox_id=? AND thread_id<>?
        AND (in_reply_to=? OR instr(COALESCE(references_header,''),?)>0)`,
  ).bind(mailboxId, parentThread, normalizedId, normalizedId).all<Row>();

  await env.DB.prepare(
    `UPDATE mail_messages
        SET provider_internet_message_id=COALESCE(NULLIF(provider_internet_message_id,''),?),updated_at=?
      WHERE message_id=?`,
  ).bind(normalizedId, now(), parent.message_id).run();

  await env.DB.prepare(
    `UPDATE mail_messages SET thread_id=?,updated_at=?
      WHERE direction='incoming' AND mailbox_id=? AND thread_id<>?
        AND (in_reply_to=? OR instr(COALESCE(references_header,''),?)>0)`,
  ).bind(parentThread, now(), mailboxId, parentThread, normalizedId, normalizedId).run();

  for (const row of oldThreads.results || []) {
    const oldThread = String(row.thread_id || "");
    if (!oldThread || oldThread === parentThread) continue;
    await refreshThread(env, oldThread);
    await env.DB.prepare("DELETE FROM mail_threads WHERE thread_id=? AND NOT EXISTS(SELECT 1 FROM mail_messages WHERE thread_id=?)")
      .bind(oldThread, oldThread).run();
  }
  await refreshThread(env, parentThread);
}

export function encodeCursor(timestamp: string, threadId: string): string {
  return bytesToBase64(encoder.encode(JSON.stringify({ t: timestamp, i: threadId })))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeCursor(value: string): { t: string; i: string } | null {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - standard.length % 4) % 4);
  try {
    const parsed = JSON.parse(decoder.decode(base64ToBytes(padded))) as { t?: unknown; i?: unknown };
    if (typeof parsed?.t === "string" && typeof parsed?.i === "string" && /^\d{4}-\d{2}-\d{2}T/.test(parsed.t) && /^[A-Za-z0-9_-]{1,200}$/.test(parsed.i)) {
      return { t: parsed.t, i: parsed.i };
    }
  } catch {
    // fall through
  }
  return null;
}

export async function listThreads(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const folder = ["inbox", "sent", "archive", "spam", "trash", "all"].includes(url.searchParams.get("folder") || "")
    ? String(url.searchParams.get("folder"))
    : "inbox";
  const mailbox = asText(url.searchParams.get("mailbox"), 100);
  const query = asText(url.searchParams.get("q"), 200).trim().toLowerCase().slice(0, 200);
  const unread = url.searchParams.get("unread") === "1";
  const replied = url.searchParams.get("replied") === "1";
  const attachment = url.searchParams.get("attachment") === "1";
  const from = dateFilter(asText(url.searchParams.get("date_from"), 20));
  const to = dateFilter(asText(url.searchParams.get("date_to"), 20), true);
  const limit = asInt(url.searchParams.get("limit"), 40, 1, 100);
  const cursor = decodeCursor(asText(url.searchParams.get("cursor"), 400)) || null;

  const where: string[] = [];
  const values: unknown[] = [];
  if (folder === "trash") {
    where.push("t.status='trash'");
  } else if (folder === "spam") {
    where.push("t.status='spam'");
  } else if (folder === "archive") {
    where.push("t.status='archived'");
  } else if (folder === "inbox") {
    where.push("t.status='open' AND t.has_incoming=1");
  } else if (folder === "sent") {
    where.push("t.status IN ('open','archived') AND t.has_outgoing=1");
  } else {
    where.push("t.status IN ('open','archived')");
  }
  if (mailbox) { where.push("t.mailbox_id=?"); values.push(mailbox); }
  if (unread) where.push("t.unread_count>0");
  if (replied) where.push("t.is_replied=1");
  if (attachment) where.push("t.has_attachment=1");
  if (from) { where.push("t.last_message_at>=?"); values.push(from); }
  if (to) { where.push("t.last_message_at<=?"); values.push(to); }
  if (query) {
    where.push(`(instr(lower(t.subject),?)>0
      OR instr(lower(COALESCE(t.latest_preview,'')),?)>0
      OR instr(lower(COALESCE(t.latest_envelope_from,'')),?)>0
      OR instr(lower(COALESCE(t.latest_recipient,'')),?)>0)`);
    values.push(query, query, query, query);
  }
  if (cursor) {
    where.push("(t.last_message_at<? OR (t.last_message_at=? AND t.thread_id<?))");
    values.push(cursor.t, cursor.t, cursor.i);
  }

  const sql = `
    SELECT t.thread_id,t.mailbox_id,t.subject,t.participants_json,t.last_message_at,t.unread_count,t.is_replied,t.status,
           t.latest_message_id AS message_id,t.latest_direction AS direction,
           t.latest_envelope_from AS envelope_from,t.latest_recipient AS envelope_to,
           t.latest_sender_json AS from_json,t.latest_preview AS text_body,t.latest_message_status AS status_summary,
           t.has_attachment,
           mb.address AS mailbox_address,mb.display_name AS mailbox_name
      FROM mail_threads t
      LEFT JOIN mailboxes mb ON mb.mailbox_id=t.mailbox_id
     WHERE ${where.join(" AND ")}
     ORDER BY t.last_message_at DESC, t.thread_id DESC
     LIMIT ?`;
  values.push(limit + 1);
  const result = await env.DB.prepare(sql).bind(...values).all<Row>();
  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return json({
    threads: page,
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor(String(last.last_message_at), String(last.thread_id)) : null,
  });
}

export async function getThread(request: Request, env: Env, threadId: string): Promise<Response> {
  const url = new URL(request.url);
  const limit = asInt(url.searchParams.get("limit"), MAX_THREAD_PAGE, 1, MAX_THREAD_PAGE);
  const offset = asInt(url.searchParams.get("offset"), 0, 0, 100_000);
  const thread = await env.DB.prepare("SELECT t.*,m.address AS mailbox_address,m.display_name AS mailbox_name FROM mail_threads t LEFT JOIN mailboxes m ON m.mailbox_id=t.mailbox_id WHERE t.thread_id=? LIMIT 1")
    .bind(threadId).first<Row>();
  if (!thread) throw new AppError(404, "Conversation not found.", "not_found");
  const total = await env.DB.prepare("SELECT COUNT(*) AS count FROM mail_messages WHERE thread_id=?").bind(threadId).first<Row>();
  const messages = await env.DB.prepare(
    `SELECT * FROM (
       SELECT message_id,thread_id,mailbox_id,direction,envelope_from,envelope_to,from_json,reply_to_json,to_json,cc_json,bcc_json,
              subject,text_body,html_body,body_truncated,status,is_read,is_replied,received_at,sent_at,
              archive_status,last_error,recipient_status_json,created_at
         FROM mail_messages WHERE thread_id=?
        ORDER BY COALESCE(received_at,sent_at,created_at) DESC,created_at DESC
        LIMIT ? OFFSET ?
     ) ORDER BY COALESCE(received_at,sent_at,created_at),created_at`,
  ).bind(threadId, limit, offset).all<Row>();
  const attachments = await env.DB.prepare(
    `SELECT a.attachment_id,a.message_id,a.filename,a.content_type,a.content_id,a.disposition,a.size,a.is_inline
       FROM mail_attachments a
       JOIN (
         SELECT message_id FROM mail_messages WHERE thread_id=?
          ORDER BY COALESCE(received_at,sent_at,created_at) DESC,created_at DESC
          LIMIT ? OFFSET ?
       ) page ON page.message_id=a.message_id
      ORDER BY a.created_at`,
  ).bind(threadId, limit, offset).all<Row>();
  const events = await env.DB.prepare(
    `SELECT e.event_id,e.message_id,e.event_type,e.status,e.recipient_json,e.occurred_at,e.received_at
       FROM mail_delivery_events e JOIN mail_messages m ON m.message_id=e.message_id
      WHERE m.thread_id=? ORDER BY e.received_at DESC LIMIT 200`,
  ).bind(threadId).all<Row>();
  const count = Number(total?.count || 0);
  // Defense in depth: inbound and outbound paths sanitize HTML before storage,
  // but the read boundary sanitizes again so any row written by another path
  // (imports, older versions, manual edits) can never reach the viewer as
  // active content.
  const safeMessages = (messages.results || []).map((row) => ({
    ...row,
    html_body: row.html_body ? sanitizeHtml(String(row.html_body)) : null,
  }));
  return json({
    thread,
    messages: safeMessages,
    attachments: attachments.results || [],
    events: events.results || [],
    total_messages: count,
    has_more_messages: offset + limit < count,
    next_message_offset: offset + limit < count ? offset + limit : null,
  });
}

export async function markThread(request: Request, env: Env, session: SessionUser, threadId: string): Promise<Response> {
  const body = await readJson(request, 8 * 1024);
  const read = body.read !== false;
  const exists = await env.DB.prepare("SELECT thread_id FROM mail_threads WHERE thread_id=?").bind(threadId).first<Row>();
  if (!exists) throw new AppError(404, "Conversation not found.", "not_found");
  await env.DB.prepare("UPDATE mail_messages SET is_read=?,updated_at=? WHERE thread_id=? AND direction='incoming'").bind(read ? 1 : 0, now(), threadId).run();
  await refreshThread(env, threadId);
  await audit(request, env, session, read ? "thread_mark_read" : "thread_mark_unread", "thread", threadId);
  return json({ ok: true, read });
}

export async function setThreadStatus(
  env: Env,
  threadId: string,
  status: "open" | "archived" | "spam" | "trash",
): Promise<Row> {
  const exists = await env.DB.prepare("SELECT thread_id,status FROM mail_threads WHERE thread_id=? LIMIT 1").bind(threadId).first<Row>();
  if (!exists) throw new AppError(404, "Conversation not found.", "not_found");
  await env.DB.prepare("UPDATE mail_threads SET status=?,updated_at=? WHERE thread_id=?").bind(status, now(), threadId).run();
  return { ...exists, status };
}

export function threadR2ObjectKeys(env: Env, threadId: string): Promise<Row[]> {
  return env.DB.prepare(
    `SELECT raw_r2_key AS key FROM mail_messages WHERE thread_id=? AND raw_r2_key IS NOT NULL
     UNION ALL
     SELECT r2_object_key AS key FROM mail_attachments a JOIN mail_messages m ON m.message_id=a.message_id WHERE m.thread_id=?`,
  ).bind(threadId, threadId).all<Row>().then((result) => result.results || []);
}