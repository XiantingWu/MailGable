import PostalMime, { type Email } from "postal-mime";
import { audit, type SessionUser } from "../auth.js";
import { isRetryableResendResponse } from "../resend-policy.js";
import { getOutboundProvider, getProviderById, providerForMessage } from "../providers/registry.js";
import type { ProviderId, SendResult } from "../providers/types.js";
import {
  AppError,
  asText,
  bytesToBase64,
  encoder,
  forwardSubject,
  json,
  normalizeEmail,
  now,
  parseJson,
  randomToken,
  readJson,
  replySubject,
  sanitizeHtml,
  sha256,
  stableStringify,
  timingSafeEqual,
  uuid,
  validEmail,
  type Env,
  type Row,
} from "../lib.js";
import {
  MAX_HTML_PREVIEW_BYTES,
  MAX_RECIPIENTS,
  MAX_SEND_BODY_BYTES,
  MAX_SENDS_PER_HOUR,
  MAX_SUBJECT,
  MAX_TEXT_PREVIEW_BYTES,
  RETRYABLE_STATUSES,
  SUCCESS_STATUSES,
} from "./constants.js";
import {
  boundedBody,
  header,
  htmlToText,
  mimeHeader,
  normalizeInternetMessageId,
  previewBody,
  references,
  safeHeaderValue,
  strictRecipientList,
  wrapBase64,
} from "./helpers.js";
import { displayFrom, mailboxById, validateMailboxDomain } from "./mailbox.js";
import {
  ensureThread,
  findMessage,
  refreshThread,
} from "./threads.js";
import {
  archiveOutgoingAttachments,
  deleteOutgoingAttachments,
  loadArchivedAttachments,
  parseUploads,
} from "./attachments.js";
import { objectPath, putR2 } from "./archive.js";
import type { SendPlan, UploadAttachment } from "./types.js";

export function automaticBccAddresses(env: Env): string[] {
  let configured: string[];
  try {
    configured = strictRecipientList(
      (env as Env & { AUTO_BCC_ADDRESSES?: string }).AUTO_BCC_ADDRESSES,
      "Automatic BCC",
    );
  } catch {
    throw new AppError(503, "Automatic BCC addresses are not configured correctly.", "auto_bcc_not_configured");
  }
  const required = String((env as Env & { AUTO_BCC_REQUIRED?: string }).AUTO_BCC_REQUIRED) === "true";
  if (required && configured.length === 0) {
    throw new AppError(503, "Automatic BCC is required by deployment policy but no addresses are configured.", "auto_bcc_required_unconfigured");
  }
  return configured;
}

export async function buildSendPlan(body: Row, env: Env): Promise<SendPlan> {
  const mailboxId = asText(body.from_mailbox_id, 100);
  const mailbox = await mailboxById(env, mailboxId);
  if (!mailbox || Number(mailbox.can_send || 0) !== 1 || !validateMailboxDomain(normalizeEmail(mailbox.address), env)) {
    throw new AppError(400, "Selected sender mailbox is unavailable.", "invalid_sender");
  }
  const automaticBcc = automaticBccAddresses(env);
  const to = strictRecipientList(body.to, "To");
  const toSet = new Set(to);
  const cc = strictRecipientList(body.cc, "CC").filter((address) => !toSet.has(address));
  const visibleSet = new Set([...to, ...cc]);
  const requestedBcc = strictRecipientList(body.bcc, "BCC");
  const bcc = [...new Set([...requestedBcc, ...automaticBcc])].filter((address) => !visibleSet.has(address));
  body.bcc = bcc;
  if (!to.length) throw new AppError(400, "At least one recipient is required.", "invalid_recipient");
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw new AppError(400, "A message can have at most 50 recipients.", "too_many_recipients");

  const subject = safeHeaderValue(body.subject, MAX_SUBJECT) || "(No subject)";
  const html = sanitizeHtml(boundedBody(body.html, 1_000_000, "HTML body"));
  const text = boundedBody(body.text, 1_000_000, "Text body") || htmlToText(html);
  if (!html && !text) throw new AppError(400, "Message body cannot be empty.", "empty_body");
  const uploads = parseUploads(body.attachments);
  const parentId = asText(body.parent_message_id, 200);
  const parent = parentId ? await findMessage(env, parentId) : null;
  if (parentId && !parent) throw new AppError(404, "Parent message not found.", "not_found");
  if (parent && String(parent.mailbox_id || "") !== String(mailbox.mailbox_id || "")) {
    throw new AppError(400, "Replies must use the mailbox identity that owns the conversation.", "reply_mailbox_mismatch");
  }
  const requestedThreadId = asText(body.thread_id, 200);
  if (!parent && requestedThreadId) {
    throw new AppError(400, "A thread can only be selected through a parent message.", "thread_parent_required");
  }
  const threadId = String(parent?.thread_id || "") || uuid();
  const requestHash = await sha256(stableStringify(body));
  return { body, mailbox, to, cc, bcc, subject, html, text, uploads, parent, threadId, requestHash };
}

export function rawOutgoingMessage(
  from: string,
  to: string[],
  cc: string[],
  subject: string,
  text: string,
  html: string,
  messageId: string,
  timestamp: string,
  uploads: UploadAttachment[],
  inReplyTo = "",
  refs = "",
): Uint8Array {
  const headers = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    cc.length ? `Cc: ${cc.join(", ")}` : "",
    `Subject: ${mimeHeader(subject)}`,
    `Date: ${new Date(timestamp).toUTCString()}`,
    `Message-ID: ${messageId}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : "",
    refs ? `References: ${refs}` : "",
    "MIME-Version: 1.0",
  ].filter(Boolean);
  const plain = text || htmlToText(html);
  if (!uploads.length && !html) {
    return encoder.encode([...headers, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrapBase64(bytesToBase64(encoder.encode(plain)))].join("\r\n"));
  }
  const mixed = `mixed_${randomToken(12)}`;
  const alternative = `alt_${randomToken(12)}`;
  const lines = [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`, "", `--${mixed}`];
  if (html) {
    lines.push(
      `Content-Type: multipart/alternative; boundary="${alternative}"`, "",
      `--${alternative}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrapBase64(bytesToBase64(encoder.encode(plain))),
      `--${alternative}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrapBase64(bytesToBase64(encoder.encode(html))),
      `--${alternative}--`,
    );
  } else {
    lines.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrapBase64(bytesToBase64(encoder.encode(plain))));
  }
  for (const upload of uploads) {
    lines.push(
      `--${mixed}`,
      `Content-Type: ${upload.contentType}; name*=UTF-8''${encodeURIComponent(upload.filename)}`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(upload.filename)}`,
      "",
      wrapBase64(upload.content),
    );
  }
  lines.push(`--${mixed}--`, "");
  return encoder.encode(lines.join("\r\n"));
}

async function enforceSendRate(env: Env, adminId: string): Promise<void> {
  const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM mail_messages WHERE created_by_admin_id=? AND direction='outgoing' AND created_at>=?")
    .bind(adminId, cutoff).first<Row>();
  if (Number(row?.count || 0) >= MAX_SENDS_PER_HOUR) throw new AppError(429, "Hourly sending limit reached.", "send_rate_limited");
}

export async function archiveOutgoing(env: Env, row: Row, plan: SendPlan): Promise<void> {
  const messageId = String(row.message_id);
  const mailboxId = String(plan.mailbox.mailbox_id);
  await deleteOutgoingAttachments(env, messageId);
  await archiveOutgoingAttachments(env, messageId, mailboxId, plan.uploads);
  const raw = rawOutgoingMessage(
    displayFrom(plan.mailbox, env),
    plan.to,
    plan.cc,
    String(row.subject),
    plan.text,
    plan.html,
    String(row.internet_message_id),
    String(row.sent_at || row.created_at || now()),
    plan.uploads,
    asText(row.in_reply_to, 998),
    asText(row.references_header, 8_000),
  );
  const rawKey = objectPath("outgoing", mailboxId, messageId, `original-${randomToken(12)}.eml`);
  await putR2(env, rawKey, raw, "message/rfc822");
  try {
    await env.DB.prepare("UPDATE mail_messages SET raw_r2_key=?,raw_r2_size=?,archive_status='archived',last_error=NULL,updated_at=? WHERE message_id=?")
      .bind(rawKey, raw.byteLength, now(), messageId).run();
  } catch (error) {
    await env.MAIL_R2.delete(rawKey).catch(() => undefined);
    throw error;
  }
}

function storedAddresses(value: unknown): string[] {
  const rows = parseJson<Array<Row>>(value, []);
  return [...new Set(rows.map((row) => normalizeEmail(row.address)).filter(validEmail))];
}

async function storedSendPlan(env: Env, row: Row): Promise<SendPlan> {
  const mailbox = await mailboxById(env, asText(row.mailbox_id, 100));
  if (!mailbox || Number(mailbox.can_send || 0) !== 1 || !validateMailboxDomain(normalizeEmail(mailbox.address), env)) {
    throw new AppError(503, "The archived sender mailbox is unavailable.", "invalid_sender");
  }
  const to = storedAddresses(row.to_json);
  const cc = storedAddresses(row.cc_json).filter((address) => !to.includes(address));
  const bcc = storedAddresses(row.bcc_json).filter((address) => !to.includes(address) && !cc.includes(address));
  if (!to.length || to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    throw new AppError(503, "The archived recipient list is invalid.", "invalid_recipient_archive");
  }
  const rawObject = row.raw_r2_key ? await env.MAIL_R2.get(asText(row.raw_r2_key, 1_000)) : null;
  if (!rawObject) throw new AppError(503, "The archived raw message is missing.", "archive_missing");
  let parsed: Email;
  try {
    const rawBytes = new Uint8Array(await new Response(rawObject.body).arrayBuffer());
    parsed = await PostalMime.parse(rawBytes, { attachmentEncoding: "arraybuffer" });
  } catch {
    throw new AppError(503, "The archived raw message cannot be parsed safely.", "archive_invalid");
  }
  const uploads = await loadArchivedAttachments(env, String(row.message_id));
  const parent = row.parent_message_id ? await findMessage(env, String(row.parent_message_id)) : null;
  const html = sanitizeHtml(asText(parsed.html, 1_000_000));
  const text = asText(parsed.text, 1_000_000) || htmlToText(html);
  if (!text && !html) throw new AppError(503, "The archived message body is unavailable.", "archive_invalid");
  return {
    body: {},
    mailbox,
    to,
    cc,
    bcc,
    subject: safeHeaderValue(row.subject, MAX_SUBJECT),
    html,
    text,
    uploads,
    parent,
    threadId: String(row.thread_id),
    requestHash: asText(row.request_hash, 200),
  };
}

export async function deliverWithProvider(env: Env, row: Row, plan: SendPlan): Promise<import("../providers/types.js").SendResult> {
  const provider = getOutboundProvider(env);
  if (!provider) throw new AppError(503, "No outbound provider is configured.", "provider_not_configured");
  return provider.send(env, row, plan);
}

export function providerRetryWindowMs(env: Env, row: Row): number | null {
  const pinned = String(row.outbound_provider || "");
  if (pinned && pinned !== "none") {
    const provider = getProviderById(pinned as ProviderId);
    return provider?.capabilities.safeRetryWindowMs ?? null;
  }
  return getOutboundProvider(env)?.capabilities.safeRetryWindowMs ?? null;
}

export async function sendMessage(request: Request, env: Env, session: SessionUser): Promise<Response> {
  const provider = getOutboundProvider(env);
  if (!provider) throw new AppError(503, "No outbound provider is configured (receive-only mode).", "provider_not_configured");
  const idempotency = asText(request.headers.get("Idempotency-Key"), 256);
  if (!/^[A-Za-z0-9:_./-]{8,256}$/.test(idempotency)) throw new AppError(400, "A valid Idempotency-Key header is required.", "invalid_idempotency_key");
  const body = await readJson(request, MAX_SEND_BODY_BYTES);
  const plan = await buildSendPlan(body, env);
  let row = await env.DB.prepare("SELECT * FROM mail_messages WHERE idempotency_key=? LIMIT 1").bind(idempotency).first<Row>();

  if (row) {
    if (!timingSafeEqual(asText(row.request_hash, 200), plan.requestHash)) {
      throw new AppError(409, "This idempotency key was already used with different content.", "idempotency_payload_mismatch");
    }
    const status = asText(row.status, 100);
    if (SUCCESS_STATUSES.has(status)) {
      return json({ message_id: row.message_id, thread_id: row.thread_id, provider: String(row.outbound_provider || ""), provider_message_id: row.provider_message_id || row.resend_email_id || "", status, idempotent: true });
    }
    if (!RETRYABLE_STATUSES.has(status)) {
      throw new AppError(409, "The existing send attempt cannot be retried.", "send_not_retryable");
    }
    const pinnedProvider = providerForMessage(env, row);
    if (!pinnedProvider) {
      throw new AppError(503, "The pinned outbound provider is no longer configured for this retry.", "provider_not_configured_for_retry");
    }
    const window = pinnedProvider.capabilities.safeRetryWindowMs;
    const createdAt = Date.parse(asText(row.created_at, 100));
    if (window === null || !Number.isFinite(createdAt) || Date.now() - createdAt > window) {
      await env.DB.prepare("UPDATE mail_messages SET status='failed',last_error='provider_retry_window_expired',updated_at=? WHERE message_id=?")
        .bind(now(), row.message_id).run();
      throw new AppError(409, "The provider retry window expired. Verify the provider record before sending a new message.", "provider_retry_window_expired");
    }
    await env.DB.prepare("UPDATE mail_messages SET status='sending',last_error=NULL,updated_at=? WHERE message_id=?")
      .bind(now(), row.message_id).run();
  } else {
    await enforceSendRate(env, session.adminId);
    const timestamp = now();
    const messageId = uuid();
    const internetId = `<${messageId}@${(env.MAIL_DOMAIN || "example.com").trim().toLowerCase()}>`;
    const xId = randomToken(24);
    const replyMode = Boolean(plan.parent);
    const finalSubject = replyMode ? replySubject(plan.subject) : plan.subject;
    const parentInternetId = normalizeInternetMessageId(plan.parent?.provider_internet_message_id || plan.parent?.internet_message_id);
    const refs = plan.parent
      ? [...references(asText(plan.parent.references_header, 8_000)), parentInternetId].filter(Boolean).slice(-30).join(" ")
      : "";
    const participants = [...plan.to, ...plan.cc, normalizeEmail(plan.mailbox.address)];
    await ensureThread(env, plan.threadId, String(plan.mailbox.mailbox_id), finalSubject, participants, timestamp);
    const textPreview = previewBody(plan.text, MAX_TEXT_PREVIEW_BYTES);
    const htmlPreview = previewBody(plan.html, MAX_HTML_PREVIEW_BYTES);

    try {
      await env.DB.prepare(
        `INSERT INTO mail_messages(
          message_id,thread_id,mailbox_id,direction,envelope_from,envelope_to,from_json,to_json,cc_json,bcc_json,subject,text_body,html_body,body_truncated,
          internet_message_id,in_reply_to,references_header,x_mailbox_mail_id,parent_message_id,idempotency_key,request_hash,status,is_read,sent_at,
          archive_status,created_by_admin_id,outbound_provider,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
.bind(
        messageId, plan.threadId, plan.mailbox.mailbox_id, "outgoing", normalizeEmail(plan.mailbox.address), plan.to[0],
        JSON.stringify([{ name: plan.mailbox.display_name, address: normalizeEmail(plan.mailbox.address) }]), JSON.stringify(plan.to.map((address) => ({ name: "", address }))),
        JSON.stringify(plan.cc.map((address) => ({ name: "", address }))), JSON.stringify(plan.bcc.map((address) => ({ name: "", address }))),
        finalSubject, textPreview.value || null, htmlPreview.value || null, textPreview.truncated || htmlPreview.truncated ? 1 : 0,
        internetId, parentInternetId || null, refs || null, xId, plan.parent?.message_id || null, idempotency, plan.requestHash, "sending", 1, timestamp,
        "pending", session.adminId, provider.id, timestamp, timestamp,
      ).run();
    } catch {
      const concurrent = await env.DB.prepare("SELECT request_hash FROM mail_messages WHERE idempotency_key=? LIMIT 1").bind(idempotency).first<Row>();
      if (concurrent && timingSafeEqual(asText(concurrent.request_hash, 200), plan.requestHash)) {
        throw new AppError(409, "Another identical send attempt is in progress. Retry shortly with the same key.", "send_in_progress");
      }
      throw new AppError(409, "The idempotency key is already in use.", "idempotency_conflict");
    }
    row = await findMessage(env, messageId);
    if (!row) throw new AppError(500, "Could not create the outgoing message.", "send_create_failed");
  }

  if (String(row.archive_status || "") !== "archived") {
    try {
      await archiveOutgoing(env, row, plan);
      row = await findMessage(env, String(row.message_id)) || row;
    } catch (error) {
      await env.DB.prepare("UPDATE mail_messages SET status='retryable_failed',archive_status='failed',last_error=?,updated_at=? WHERE message_id=?")
        .bind(error instanceof AppError ? error.code : "archive_failed", now(), row.message_id).run();
      throw error;
    }
  }

  const result = await deliverWithProvider(env, row, plan);
  await env.DB.batch([
    env.DB.prepare("UPDATE mail_messages SET status=CASE WHEN status IN ('sending','retryable_failed') THEN 'sent' ELSE status END,provider_message_id=COALESCE(NULLIF(provider_message_id,''),?),resend_email_id=COALESCE(NULLIF(resend_email_id,''),?),last_error=NULL,updated_at=? WHERE message_id=?")
      .bind(result.providerMessageId, result.provider === "resend" ? result.providerMessageId : null, now(), row.message_id),
    ...(row.parent_message_id ? [env.DB.prepare("UPDATE mail_messages SET is_replied=1,updated_at=? WHERE message_id=?").bind(now(), row.parent_message_id)] : []),
  ]);
  await refreshThread(env, String(row.thread_id));
  await audit(request, env, session, "mail_send", "message", String(row.message_id), { mailbox: plan.mailbox.address, recipients: plan.to.length + plan.cc.length + plan.bcc.length, provider: result.provider }, idempotency);
  return json({ message_id: row.message_id, thread_id: row.thread_id, provider: result.provider, provider_message_id: result.providerMessageId, status: "sent" }, 201);
}

export async function retryMessage(request: Request, env: Env, session: SessionUser, messageId: string): Promise<Response> {
  const row = await findMessage(env, messageId);
  if (!row || String(row.direction) !== "outgoing") throw new AppError(404, "Outgoing message not found.", "not_found");
  const status = asText(row.status, 100);
  if (SUCCESS_STATUSES.has(status)) {
    return json({ message_id: row.message_id, thread_id: row.thread_id, provider: String(row.outbound_provider || ""), provider_message_id: row.provider_message_id || row.resend_email_id || "", status, idempotent: true });
  }
  if (!RETRYABLE_STATUSES.has(status)) throw new AppError(409, "This send attempt cannot be retried.", "send_not_retryable");
  if (String(row.archive_status || "") !== "archived" || !row.raw_r2_key) {
    throw new AppError(409, "The archived message is incomplete and cannot be safely retried.", "archive_incomplete");
  }
  const pinnedProvider = providerForMessage(env, row);
  if (!pinnedProvider) {
    throw new AppError(503, "The pinned outbound provider is no longer configured for this retry.", "provider_not_configured_for_retry");
  }
  const window = pinnedProvider.capabilities.safeRetryWindowMs;
  const createdAt = Date.parse(asText(row.created_at, 100));
  if (window === null || !Number.isFinite(createdAt) || Date.now() - createdAt > window) {
    await env.DB.prepare("UPDATE mail_messages SET status='failed',last_error='provider_retry_window_expired',updated_at=? WHERE message_id=?")
      .bind(now(), row.message_id).run();
    throw new AppError(409, "The provider retry window expired. Verify the provider record before sending a new message.", "provider_retry_window_expired");
  }
  const plan = await storedSendPlan(env, row);
  await env.DB.prepare("UPDATE mail_messages SET status='sending',last_error=NULL,updated_at=? WHERE message_id=? AND status IN ('sending','retryable_failed')")
    .bind(now(), row.message_id).run();
  const result = await pinnedProvider.send(env, row, plan);
  await env.DB.batch([
    env.DB.prepare("UPDATE mail_messages SET status=CASE WHEN status IN ('sending','retryable_failed') THEN 'sent' ELSE status END,provider_message_id=COALESCE(NULLIF(provider_message_id,''),?),resend_email_id=COALESCE(NULLIF(resend_email_id,''),?),last_error=NULL,updated_at=? WHERE message_id=?")
      .bind(result.providerMessageId, result.provider === "resend" ? result.providerMessageId : null, now(), row.message_id),
    ...(row.parent_message_id ? [env.DB.prepare("UPDATE mail_messages SET is_replied=1,updated_at=? WHERE message_id=?").bind(now(), row.parent_message_id)] : []),
  ]);
  await refreshThread(env, String(row.thread_id));
  await audit(request, env, session, "mail_retry", "message", String(row.message_id), { mailbox: plan.mailbox.address, recipients: plan.to.length + plan.cc.length + plan.bcc.length, provider: result.provider }, `retry/${row.idempotency_key}`);
  const current = await findMessage(env, String(row.message_id));
  return json({ message_id: row.message_id, thread_id: row.thread_id, provider: result.provider, provider_message_id: result.providerMessageId, status: current?.status || "sent", retried: true });
}

export async function forwardMessage(request: Request, env: Env, session: SessionUser, messageId: string): Promise<Response> {
  const original = await findMessage(env, messageId);
  if (!original) throw new AppError(404, "Message not found.", "not_found");
  const body = await readJson(request, MAX_SEND_BODY_BYTES);
  if (String(original.archive_status || "") !== "archived" || !original.raw_r2_key) {
    throw new AppError(409, "The original message archive is incomplete and cannot be forwarded safely.", "forward_archive_incomplete");
  }
  const rawObject = await env.MAIL_R2.get(asText(original.raw_r2_key, 1_000));
  if (!rawObject) {
    throw new AppError(503, "The original raw message is missing and cannot be forwarded safely.", "forward_archive_missing");
  }
  let parsed: Email;
  try {
    const rawBytes = new Uint8Array(await new Response(rawObject.body).arrayBuffer());
    parsed = await PostalMime.parse(rawBytes, { attachmentEncoding: "arraybuffer" });
  } catch {
    throw new AppError(503, "The original raw message cannot be parsed safely.", "forward_archive_invalid");
  }
  const originalText = boundedBody(parsed.text, 1_000_000, "Forwarded text body");
  const originalHtml = sanitizeHtml(boundedBody(parsed.html, 1_000_000, "Forwarded HTML body"));
  if (!originalText && !originalHtml) {
    throw new AppError(503, "The original archived message body is unavailable.", "forward_archive_invalid");
  }

  body.subject = forwardSubject(asText(body.subject, MAX_SUBJECT) || asText(original.subject, MAX_SUBJECT));
  body.text = `${boundedBody(body.text, 1_000_000, "Forward note")}\n\n---------- Forwarded message ----------\nFrom: ${asText(original.envelope_from, 320)}\nDate: ${new Date(String(original.received_at || original.sent_at || original.created_at || now())).toUTCString()}\nSubject: ${asText(original.subject, MAX_SUBJECT)}\nTo: ${asText(original.envelope_to, 320)}\n\n${originalText || htmlToText(originalHtml)}`.trim();
  if (originalHtml) {
    body.html = `${sanitizeHtml(boundedBody(body.html, 1_000_000, "Forward note HTML"))}<hr><p><strong>Forwarded message</strong></p>${originalHtml}`;
  }

  const supplied = parseUploads(body.attachments);
  const archived = await loadArchivedAttachments(env, messageId);
  if (supplied.length + archived.length > 10) {
    throw new AppError(413, "The forwarded message would exceed the 10-attachment limit. Compose a new message with selected files.", "forward_attachments_exceed_limits");
  }
  const total = [...supplied, ...archived].reduce((sum, item) => sum + item.bytes.byteLength, 0);
  if (total > 8 * 1024 * 1024) {
    throw new AppError(413, "The forwarded message would exceed the 8 MB attachment limit. Compose a new message with selected files.", "forward_attachments_exceed_limits");
  }
  body.attachments = [...supplied, ...archived].map((item) => ({
    filename: item.filename,
    contentType: item.contentType,
    content: item.content,
  }));
  const headers = new Headers(request.headers);
  headers.delete("Content-Length");
  const forwardedRequest = new Request(request.url, { method: "POST", headers, body: JSON.stringify(body) });
  return sendMessage(forwardedRequest, env, session);
}