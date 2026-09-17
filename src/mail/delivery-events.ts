import {
  AppError,
  asText,
  json,
  now,
  type Env,
  type Row,
} from "../lib.js";
import { verifyResendWebhook } from "../providers/resend-webhook.js";
import { applyDeliveryEvent, normalizeBrevoEvent, normalizeCloudflareQueueEvent, normalizeResendEvent } from "../providers/events.js";

export async function readTextLimited(request: Request, maxBytes: number): Promise<string> {
  const declared = Number.parseInt(request.headers.get("Content-Length") || "0", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AppError(413, "Webhook payload is too large.", "body_too_large");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("payload limit exceeded").catch(() => undefined);
        throw new AppError(413, "Webhook payload is too large.", "body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function handleResendWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.RESEND_WEBHOOK_SECRET) throw new AppError(503, "Webhook verification is not configured.", "webhook_not_configured");
  const raw = await readTextLimited(request, 1_000_000);
  if (!(await verifyResendWebhook(raw, request.headers, env.RESEND_WEBHOOK_SECRET))) {
    throw new AppError(400, "Webhook signature is invalid.", "invalid_webhook_signature");
  }
  const svixId = request.headers.get("svix-id") || "";
  let payload: Row;
  try { payload = JSON.parse(raw) as Row; } catch { throw new AppError(400, "Webhook payload is invalid JSON.", "invalid_json"); }
  const event = normalizeResendEvent(payload, svixId);
  const { duplicate } = await applyDeliveryEvent(env, event);
  return json({ ok: true, duplicate });
}

export async function handleBrevoWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.BREVO_WEBHOOK_TOKEN) throw new AppError(503, "Webhook authentication is not configured.", "webhook_not_configured");
  const raw = await readTextLimited(request, 1_000_000);
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  let payload: Row;
  try { payload = JSON.parse(raw) as Row; } catch { throw new AppError(400, "Webhook payload is invalid JSON.", "invalid_json"); }
  const event = await normalizeBrevoEvent(payload, bearer, env.BREVO_WEBHOOK_TOKEN);
  const { duplicate } = await applyDeliveryEvent(env, event);
  return json({ ok: true, duplicate });
}

export async function handleCloudflareQueueEvent(batch: { messages: Array<{ body: unknown }> }, env: Env): Promise<void> {
  for (const item of batch.messages) {
    const cloudEvent = item.body as Row;
    const type = asText(cloudEvent.type, 200);
    if (!type.startsWith("cf.email.sending.")) continue;
    const event = await normalizeCloudflareQueueEvent(cloudEvent);
    await applyDeliveryEvent(env, event);
  }
}

export { verifyResendWebhook };