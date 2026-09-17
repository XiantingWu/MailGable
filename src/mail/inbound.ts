import PostalMime, { type Email } from "postal-mime";
import { forwardInboundCopies } from "../inbound-forwarding.js";
import {
  AppError,
  asText,
  decoder,
  normalizeEmail,
  now,
  sanitizeHtml,
  sha256,
  type Env,
  type Row,
} from "../lib.js";
import { MAX_RAW_BYTES, MAX_HTML_PREVIEW_BYTES, MAX_TEXT_PREVIEW_BYTES, MAX_SUBJECT } from "./constants.js";
import { addressArray, header, normalizeInternetMessageId, previewBody, references, safeHeaderValue } from "./helpers.js";
import { incomingRawObjectName, objectPath, putR2 } from "./archive.js";
import { storeIncomingAttachments } from "./attachments.js";
import {
  createThreadPlaceholder,
  ensureThread,
  findMessage,
  refreshThread,
  threadFromHeaders,
} from "./threads.js";
import { mailboxByAddress } from "./mailbox.js";

export async function handleInbound(
  message: ForwardableEmailMessage,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  if (message.rawSize && message.rawSize > MAX_RAW_BYTES) {
    message.setReject("Message exceeds the 20 MB mailbox limit.");
    return;
  }
  const envelopeTo = normalizeEmail(message.to);
  const mailbox = await mailboxByAddress(env, envelopeTo);
  if (!mailbox || Number(mailbox.can_receive || 0) !== 1) {
    message.setReject("Unknown or inactive recipient.");
    return;
  }

  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  if (raw.byteLength > MAX_RAW_BYTES) {
    message.setReject("Message exceeds the 20 MB mailbox limit.");
    return;
  }
  let parsed: Email;
  try {
    parsed = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  } catch {
    parsed = { headers: [], headerLines: [], attachments: [], text: decoder.decode(raw).slice(0, 1_000_000) };
  }

  const mailboxId = String(mailbox.mailbox_id);
  const internetId = normalizeInternetMessageId(header(parsed, "message-id") || message.headers.get("message-id"));
  const xId = header(parsed, "x-mailbox-mail-id") || asText(message.headers.get("x-mailbox-mail-id"), 200);
  const rawHash = await sha256(raw);

  const timestamp = now();
  const messageId = `in_${await sha256(`${mailboxId}|${rawHash}`)}`;

  const inReplyTo = normalizeInternetMessageId(header(parsed, "in-reply-to"));
  const refsHeader = references(header(parsed, "references")).join(" ");
  const threadId = await threadFromHeaders(env, inReplyTo, references(refsHeader), mailboxId) || `thread_${messageId.slice(3)}`;
  const subject = safeHeaderValue(parsed.subject, MAX_SUBJECT) || "(No subject)";
  const from = addressArray(parsed.from);
  const replyTo = addressArray(parsed.replyTo);
  const to = addressArray(parsed.to);
  const cc = addressArray(parsed.cc);
  const bcc = addressArray(parsed.bcc);
  const participants = [normalizeEmail(message.from), ...to.map((item) => item.address), ...cc.map((item) => item.address)];

  // The placeholder satisfies the message foreign key without advancing an
  // existing conversation. Only the atomic message-claim winner writes parsed
  // thread metadata and a real last-message timestamp.
  await createThreadPlaceholder(env, threadId, mailboxId, timestamp);

  // Every delivery attempt owns a unique raw object. A losing duplicate can
  // delete only its own object and cannot remove the archive referenced by the
  // winning D1 row.
  const rawKey = objectPath("incoming", mailboxId, messageId, incomingRawObjectName());
  try {
    await putR2(env, rawKey, raw, "message/rfc822");
  } catch (error) {
    await env.DB.prepare("DELETE FROM mail_threads WHERE thread_id=? AND NOT EXISTS(SELECT 1 FROM mail_messages WHERE thread_id=?)")
      .bind(threadId, threadId).run().catch(() => undefined);
    throw error;
  }
  const textPreview = previewBody(asText(parsed.text, 1_000_000), MAX_TEXT_PREVIEW_BYTES);
  const sanitized = sanitizeHtml(asText(parsed.html, 1_000_000));
  const htmlPreview = previewBody(sanitized, MAX_HTML_PREVIEW_BYTES);

  let inserted = false;
  try {
    const claim = await env.DB.prepare(
      `INSERT OR IGNORE INTO mail_messages(
        message_id,thread_id,mailbox_id,direction,envelope_from,envelope_to,from_json,reply_to_json,to_json,cc_json,bcc_json,
        subject,text_body,html_body,body_truncated,internet_message_id,in_reply_to,references_header,x_mailbox_mail_id,parent_message_id,
        status,is_read,received_at,raw_r2_key,raw_r2_size,archive_status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,

    ).bind(
      messageId, threadId, mailbox.mailbox_id, "incoming", normalizeEmail(message.from), envelopeTo,
      JSON.stringify(from), JSON.stringify(replyTo), JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject,
      textPreview.value || null, htmlPreview.value || null, textPreview.truncated || htmlPreview.truncated ? 1 : 0,
      internetId || null, inReplyTo || null, refsHeader || null, xId || null, null,
      "received", 0, timestamp, rawKey, raw.byteLength, "pending", timestamp, timestamp,
    ).run();
    const claimMeta = claim.meta as { changes?: number };
    inserted = Number(claimMeta.changes || 0) === 1;
    if (!inserted && !(await findMessage(env, messageId))) {
      throw new AppError(500, "Could not claim the incoming message.", "inbound_claim_failed");
    }
  } catch (error) {
    await env.MAIL_R2.delete(rawKey).catch(() => undefined);
    await env.DB.prepare("DELETE FROM mail_threads WHERE thread_id=? AND NOT EXISTS(SELECT 1 FROM mail_messages WHERE thread_id=?)")
      .bind(threadId, threadId).run().catch(() => undefined);
    throw error;
  }

  if (!inserted) {
    await env.MAIL_R2.delete(rawKey).catch(() => undefined);
    await env.DB.prepare("DELETE FROM mail_threads WHERE thread_id=? AND NOT EXISTS(SELECT 1 FROM mail_messages WHERE thread_id=?)")
      .bind(threadId, threadId).run().catch(() => undefined);
    await forwardInboundCopies(message, env, messageId, envelopeTo);
    return;
  }

  await ensureThread(env, threadId, mailboxId, subject, participants, timestamp);

  try {
    const attachmentResult = await storeIncomingAttachments(env, messageId, mailboxId, parsed.attachments || []);
    if (attachmentResult.skipped > 0) {
      await env.DB.prepare("UPDATE mail_messages SET archive_status='partial',last_error=?,updated_at=? WHERE message_id=?")
        .bind(`attachment_limit_exceeded:${attachmentResult.skipped}`, now(), messageId).run();
    } else {
      await env.DB.prepare("UPDATE mail_messages SET archive_status='archived',last_error=NULL,updated_at=? WHERE message_id=? AND archive_status='pending'")
        .bind(now(), messageId).run();
    }
  } catch (error) {
    await env.DB.prepare("UPDATE mail_messages SET archive_status='partial',last_error=?,updated_at=? WHERE message_id=?")
      .bind(error instanceof AppError ? error.code : "attachment_archive_failed", now(), messageId).run();
  }
  await refreshThread(env, threadId);
  await forwardInboundCopies(message, env, messageId, envelopeTo);
}