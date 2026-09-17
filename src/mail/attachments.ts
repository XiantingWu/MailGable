import type { Attachment } from "postal-mime";
import {
  AppError,
  asText,
  base64ToBytes,
  bytesToBase64,
  now,
  safeFilename,
  sha256,
  timingSafeEqual,
  uuid,
  type Env,
  type Row,
} from "../lib.js";
import {
  MAX_INCOMING_ATTACHMENTS,
  MAX_INCOMING_ATTACHMENT_BYTES,
  MAX_INCOMING_TOTAL_ATTACHMENT_BYTES,
  MAX_OUTGOING_ATTACHMENT_BYTES,
  MAX_OUTGOING_TOTAL_ATTACHMENT_BYTES,
} from "./constants.js";
import { attachmentBytes, safeMimeType } from "./helpers.js";
import { objectPath, putR2 } from "./archive.js";
import type { UploadAttachment } from "./types.js";

export async function hashAttachment(bytes: Uint8Array): Promise<string> {
  return sha256(bytes);
}

export async function storeIncomingAttachments(
  env: Env,
  messageId: string,
  mailboxId: string,
  items: Attachment[],
): Promise<{ stored: number; skipped: number }> {
  let total = 0;
  let stored = 0;
  let skipped = Math.max(0, items.length - MAX_INCOMING_ATTACHMENTS);
  const pending: Array<{
    id: string; key: string; filename: string; contentType: string;
    contentId: string | null; disposition: string | null; size: number; hash: string; inline: number;
  }> = [];
  for (const item of items.slice(0, MAX_INCOMING_ATTACHMENTS)) {
    const bytes = attachmentBytes(item);
    if (!bytes.byteLength || bytes.byteLength > MAX_INCOMING_ATTACHMENT_BYTES || total + bytes.byteLength > MAX_INCOMING_TOTAL_ATTACHMENT_BYTES) {
      skipped += 1;
      continue;
    }
    total += bytes.byteLength;
    const attachmentId = uuid();
    const filename = safeFilename(item.filename);
    const contentType = safeMimeType(item.mimeType);
    const key = objectPath("incoming", mailboxId, messageId, `attachments/${attachmentId}-${filename}`);
    await putR2(env, key, bytes, contentType);
    pending.push({
      id: attachmentId, key, filename, contentType,
      contentId: asText(item.contentId, 500) || null,
      disposition: asText(item.disposition, 100) || null,
      size: bytes.byteLength,
      hash: await hashAttachment(bytes),
      inline: item.related ? 1 : 0,
    });
    stored += 1;
  }
  // Batch metadata writes: each row needs 11 bound parameters, so 8 rows
  // per query stay under the 100-parameter D1 limit.
  try {
    for (let index = 0; index < pending.length; index += 8) {
      const chunk = pending.slice(index, index + 8);
      const placeholders = chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?)").join(",");
      const values = chunk.flatMap((item) => [
        item.id, messageId, item.filename, item.contentType, item.contentId, item.disposition,
        item.size, item.hash, item.key, item.inline, now(),
      ]);
      await env.DB.prepare(
        `INSERT INTO mail_attachments(attachment_id,message_id,filename,content_type,content_id,disposition,size,sha256,r2_object_key,is_inline,created_at)
         VALUES ${placeholders}`,
      ).bind(...values).run();
    }
  } catch (error) {
    for (const item of pending) {
      await env.MAIL_R2.delete(item.key).catch(() => undefined);
    }
    throw error;
  }
  return { stored, skipped };
}

export function parseUploads(value: unknown): UploadAttachment[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 10) throw new AppError(413, "A message can include at most 10 attachments.", "too_many_attachments");
  const result: UploadAttachment[] = [];
  let total = 0;
  const maxEncodedLength = Math.ceil(MAX_OUTGOING_ATTACHMENT_BYTES / 3) * 4;
  for (const item of value) {
    if (!item || typeof item !== "object") throw new AppError(400, "Attachment metadata is invalid.", "invalid_attachment");
    const row = item as Row;
    if (typeof row.content !== "string") throw new AppError(400, "Attachment content must be Base64 text.", "invalid_attachment");
    const content = row.content.replace(/\s/g, "");
    if (!content || content.length > maxEncodedLength) {
      throw new AppError(413, "Each outgoing attachment must be 5 MB or smaller.", "attachment_too_large");
    }
    const bytes = base64ToBytes(content);
    if (!bytes.byteLength || bytes.byteLength > MAX_OUTGOING_ATTACHMENT_BYTES) {
      throw new AppError(413, "Each outgoing attachment must be 5 MB or smaller.", "attachment_too_large");
    }
    total += bytes.byteLength;
    if (total > MAX_OUTGOING_TOTAL_ATTACHMENT_BYTES) {
      throw new AppError(413, "Total outgoing attachment size must be 8 MB or smaller.", "attachments_too_large");
    }
    result.push({
      filename: safeFilename(row.filename),
      contentType: safeMimeType(row.contentType),
      content,
      bytes,
    });
  }
  return result;
}

export async function deleteOutgoingAttachments(env: Env, messageId: string): Promise<void> {
  const existing = await env.DB.prepare("SELECT r2_object_key FROM mail_attachments WHERE message_id=?").bind(messageId).all<Row>();
  for (const row of existing.results || []) {
    const key = asText(row.r2_object_key, 1_000);
    if (key) await env.MAIL_R2.delete(key);
  }
  await env.DB.prepare("DELETE FROM mail_attachments WHERE message_id=?").bind(messageId).run();
}

export async function archiveOutgoingAttachments(env: Env, messageId: string, mailboxId: string, uploads: UploadAttachment[]): Promise<void> {
  const pending = await Promise.all(uploads.map(async (upload) => {
    const attachmentId = uuid();
    const key = objectPath("outgoing", mailboxId, messageId, `attachments/${attachmentId}-${upload.filename}`);
    await putR2(env, key, upload.bytes, upload.contentType);
    return { id: attachmentId, key, filename: upload.filename, contentType: upload.contentType, size: upload.bytes.byteLength, hash: await hashAttachment(upload.bytes) };
  }));
  try {
    for (let index = 0; index < pending.length; index += 8) {
      const chunk = pending.slice(index, index + 8);
      const placeholders = chunk.map(() => "(?,?,?,?,?,?,?,?,?)").join(",");
      await env.DB.prepare(
        `INSERT INTO mail_attachments(attachment_id,message_id,filename,content_type,size,sha256,r2_object_key,is_inline,created_at)
         VALUES ${placeholders}`,
      ).bind(...chunk.flatMap((item) => [item.id, messageId, item.filename, item.contentType, item.size, item.hash, item.key, 0, now()])).run();
    }
  } catch (error) {
    for (const item of pending) {
      await env.MAIL_R2.delete(item.key).catch(() => undefined);
    }
    throw error;
  }
}

export async function loadArchivedAttachments(env: Env, messageId: string): Promise<UploadAttachment[]> {
  const rows = await env.DB.prepare("SELECT filename,content_type,r2_object_key,size,sha256 FROM mail_attachments WHERE message_id=? ORDER BY created_at")
    .bind(messageId).all<Row>();
  const entries = rows.results || [];
  if (entries.length > 10) throw new AppError(413, "Archived attachments exceed the 10-file sending limit.", "too_many_attachments");
  const uploads: UploadAttachment[] = [];
  let total = 0;
  for (const row of entries) {
    const declared = Number(row.size || 0);
    if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_OUTGOING_ATTACHMENT_BYTES || total + declared > MAX_OUTGOING_TOTAL_ATTACHMENT_BYTES) {
      throw new AppError(413, "Archived attachments exceed the outgoing size limits.", "attachments_too_large");
    }
    const object = await env.MAIL_R2.get(asText(row.r2_object_key, 1_000));
    if (!object) throw new AppError(503, "An archived attachment is missing; the message cannot be safely retried.", "attachment_archive_missing");
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    const actualHash = await hashAttachment(bytes);
    const expectedHash = asText(row.sha256, 200);
    if (
      bytes.byteLength !== declared
      || bytes.byteLength > MAX_OUTGOING_ATTACHMENT_BYTES
      || total + bytes.byteLength > MAX_OUTGOING_TOTAL_ATTACHMENT_BYTES
      || !expectedHash
      || !timingSafeEqual(expectedHash, actualHash)
    ) {
      throw new AppError(503, "An archived attachment failed integrity checks.", "attachment_archive_invalid");
    }
    total += bytes.byteLength;
    uploads.push({
      filename: safeFilename(row.filename),
      contentType: safeMimeType(row.content_type),
      content: bytesToBase64(bytes),
      bytes,
    });
  }
  return uploads;
}

export async function attachmentResponse(env: Env, attachmentId: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM mail_attachments WHERE attachment_id=? LIMIT 1").bind(attachmentId).first<Row>();
  if (!row) throw new AppError(404, "Attachment not found.", "not_found");
  const object = await env.MAIL_R2.get(String(row.r2_object_key));
  if (!object) throw new AppError(404, "Attachment archive is missing.", "archive_missing");
  const headers = new Headers();
  headers.set("Content-Type", safeMimeType(row.content_type));
  headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename(row.filename))}`);
  headers.set("Content-Length", String(row.size || object.size));
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
}