import {
  AppError,
  asText,
  encoder,
  json,
  now,
  randomToken,
  safeDisplayFilename,
  safeSegment,
  sha256,
  timingSafeEqual,
  uuid,
  type Env,
  type Row,
} from "../lib.js";
import { findMessage } from "./threads.js";

export function objectRoot(direction: string): string {
  if (direction === "incoming") return "incoming";
  if (direction === "outgoing") return "outgoing";
  if (direction === "outgoing_backup_copy") return "sent-copies";
  return "unclassified";
}

export function objectPath(direction: string, mailboxId: string, messageId: string, name: string): string {
  const date = new Date();
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${objectRoot(direction)}/${safeSegment(mailboxId)}/${year}/${month}/${safeSegment(messageId)}/${safeSegment(name)}`;
}

export async function putR2(env: Env, key: string, value: Uint8Array | ArrayBuffer, contentType: string): Promise<void> {
  try {
    await env.MAIL_R2.put(key, value, { httpMetadata: { contentType } });
  } catch {
    throw new AppError(503, "Mailbox archive storage is unavailable.", "archive_unavailable");
  }
}

export function incomingRawObjectName(): string {
  return `original-${randomToken(12)}.eml`;
}

export async function rawMessageResponse(env: Env, messageId: string): Promise<Response> {
  const row = await findMessage(env, messageId);
  if (!row) throw new AppError(404, "Message not found.", "not_found");
  if (!row.raw_r2_key) throw new AppError(404, "Raw message archive is unavailable.", "archive_missing");
  const object = await env.MAIL_R2.get(String(row.raw_r2_key));
  if (!object) throw new AppError(404, "Raw message archive is missing.", "archive_missing");
  return new Response(object.body, {
    headers: {
      "Content-Type": "message/rfc822",
      "Content-Disposition": `attachment; filename="${safeDisplayFilename(messageId)}.eml"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function storageProbe(env: Env): Promise<Response> {
  const probeId = uuid();
  const key = `health/probe-${probeId}.txt`;
  const payload = encoder.encode(`mailbox-storage-probe:${randomToken(16)}`);
  const payloadHash = await sha256(payload);

  let d1Inserted = false;
  let d1Deleted = false;
  let r2Deleted = false;
  try {
    try {
      await env.DB.prepare("INSERT INTO mail_ops_probes(probe_id,payload_hash,created_at) VALUES(?,?,?)")
        .bind(probeId, payloadHash, now()).run();
      d1Inserted = true;
      const storedProbe = await env.DB.prepare("SELECT payload_hash FROM mail_ops_probes WHERE probe_id=? LIMIT 1")
        .bind(probeId).first<Row>();
      if (!storedProbe || !timingSafeEqual(asText(storedProbe.payload_hash, 200), payloadHash)) {
        throw new AppError(503, "D1 probe row failed integrity validation.", "database_probe_failed");
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, "D1 write/read probe failed.", "database_probe_failed");
    }

    await putR2(env, key, payload, "text/plain; charset=utf-8");
    const object = await env.MAIL_R2.get(key);
    if (!object) throw new AppError(503, "R2 probe object could not be read.", "archive_probe_failed");
    const stored = new Uint8Array(await new Response(object.body).arrayBuffer());
    if (stored.byteLength !== payload.byteLength || !timingSafeEqual(await sha256(stored), payloadHash)) {
      throw new AppError(503, "R2 probe object failed integrity validation.", "archive_probe_failed");
    }
    try {
      await env.MAIL_R2.delete(key);
      r2Deleted = true;
    } catch {
      throw new AppError(503, "R2 probe object could not be deleted.", "archive_probe_failed");
    }
    if (await env.MAIL_R2.get(key)) throw new AppError(503, "R2 probe object remained after deletion.", "archive_probe_failed");

    try {
      await env.DB.prepare("DELETE FROM mail_ops_probes WHERE probe_id=?").bind(probeId).run();
      d1Deleted = true;
      const afterDelete = await env.DB.prepare("SELECT probe_id FROM mail_ops_probes WHERE probe_id=? LIMIT 1")
        .bind(probeId).first<Row>();
      if (afterDelete) throw new AppError(503, "D1 probe row remained after deletion.", "database_probe_failed");
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, "D1 delete probe failed.", "database_probe_failed");
    }

    return json({
      ok: true,
      database_read_write_delete: true,
      archive_read_write_delete: true,
    });
  } finally {
    if (!r2Deleted) {
      try { await env.MAIL_R2.delete(key); }
      catch (error) { console.error("R2 probe cleanup failed", key, error); }
    }
    if (d1Inserted && !d1Deleted) {
      try { await env.DB.prepare("DELETE FROM mail_ops_probes WHERE probe_id=?").bind(probeId).run(); }
      catch (error) { console.error("D1 probe cleanup failed", probeId, error); }
    }
  }
}