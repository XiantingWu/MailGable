import {
  AppError,
  asText,
  emailList,
  json,
  now,
  parseJson,
  timingSafeEqual,
  uuid,
  type Env,
  type Row,
} from "../lib.js";
import { DELIVERY_RANK } from "../mail/constants.js";
import { reconcileProviderMessageId } from "../mail/threads.js";
import { aggregateDeliveryStatus } from "../lib.js";
import type { NormalizedDeliveryEvent } from "./types.js";

export function updateRecipientSummary(current: Record<string, string>, recipients: string[], status: string): Record<string, string> {
  const keys = recipients.length ? recipients : ["*"];
  const next = { ...current };
  for (const recipient of keys) {
    const previous = next[recipient] || "sending";
    if ((DELIVERY_RANK[status] || 0) >= (DELIVERY_RANK[previous] || 0)) next[recipient] = status;
  }
  return next;
}

export async function deterministicEventKey(provider: string, ...parts: (string | undefined)[]): Promise<string> {
  const data = [provider, ...parts].filter(Boolean).join("|");
  const textEncoder = new TextEncoder();
  const buffer = await crypto.subtle.digest("SHA-256", textEncoder.encode(data));
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

export function normalizeResendEvent(payload: Row, svixId: string): NormalizedDeliveryEvent {
  const data = payload.data && typeof payload.data === "object" ? payload.data as Row : {};
  const resendId = asText(data.email_id || data.id, 200);
  const tags = data.tags && typeof data.tags === "object" && !Array.isArray(data.tags) ? data.tags as Row : {};
  const status = String(payload.type || "").replace(/^email\./, "");
  return {
    provider: "resend",
    providerEventId: svixId,
    providerMessageId: resendId,
    taggedMessageId: asText(tags.message_id || tags.mailbox_id, 200),
    recipients: emailList(data.to, 100),
    rawType: asText(payload.type, 100) || "unknown",
    status,
    occurredAt: asText(payload.created_at || data.created_at, 100) || undefined,
  };
}

const BREVO_STATUS_MAP = {
  sent: "sent",
  request: "sent",
  delivered: "delivered",
  deferred: "delivery_delayed",
  soft_bounce: "delivery_delayed",
  softBounce: "delivery_delayed",
  hard_bounce: "bounced",
  hardBounce: "bounced",
  blocked: "suppressed",
  invalid_email: "failed",
  invalidEmail: "failed",
  spam: "complained",
  opened: "opened",
  click: "clicked",
  clicks: "clicked",
  unsubscribed: "suppressed",
};

export async function normalizeBrevoEvent(payload: Row, bearerToken: string, expectedToken: string): Promise<NormalizedDeliveryEvent> {
  if (!expectedToken || !timingSafeEqual(bearerToken, expectedToken)) {
    throw new AppError(401, "Webhook authentication is invalid.", "invalid_webhook_auth");
  }
  const event = asText(payload.event, 100);
  // Canonical field is "message-id"; message_id is a documented compatibility
  // fallback only.
  const providerMessageId = asText(payload["message-id"], 200) || asText(payload.message_id, 200);
  const recipients = emailList(payload.email, 10);
  const tags = Array.isArray(payload.tags) ? payload.tags.map(String) : [];
  const taggedMessageId = tags.map((tag) => tag.match(/^mailbox:(.+)$/)?.[1]).filter(Boolean)[0] || "";
  // Prefer ts_event, then ts_epoch, then date; normalize to an ISO string.
  const tsRaw = asText(payload.ts_event, 40) || asText(payload.ts_epoch, 40) || asText(payload.date, 100) || "";
  const occurredAt = tsRaw ? normalizeEventTimestamp(tsRaw) : undefined;
  const mapped = (BREVO_STATUS_MAP as Record<string, string>)[event];
  if (!mapped) {
    throw new AppError(422, "Unsupported provider event type.", "unsupported_provider_event");
  }
  return {
    provider: "brevo",
    providerEventId: await deterministicEventKey("brevo", providerMessageId, recipients[0] || "*", event, occurredAt || tsRaw),
    providerMessageId,
    taggedMessageId,
    recipients,
    rawType: event,
    status: mapped,
    occurredAt,
  };
}

export function normalizeEventTimestamp(value: string): string {
  const trimmed = value.trim();
  if (/^\d{10}$/.test(trimmed)) return new Date(Number(trimmed) * 1000).toISOString();
  if (/^\d{13}$/.test(trimmed)) return new Date(Number(trimmed)).toISOString();
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString();
}

const CLOUDFLARE_STATUS_MAP = {
  "message.delivered": "delivered",
  "message.deferred": "delivery_delayed",
  "message.bounced": "bounced",
  "message.failed": "failed",
  "message.rejected": "suppressed",
  "message.complained": "complained",
};

export async function normalizeCloudflareQueueEvent(cloudEvent: Row): Promise<NormalizedDeliveryEvent> {
  const type = asText(cloudEvent.type, 200);
  const source = cloudEvent.source && typeof cloudEvent.source === "object" ? cloudEvent.source as Row : {};
  const payload = cloudEvent.payload && typeof cloudEvent.payload === "object" ? cloudEvent.payload as Row : {};
  const metadata = cloudEvent.metadata && typeof cloudEvent.metadata === "object" ? cloudEvent.metadata as Row : {};
  if (asText(source.type, 100) !== "email.sending" || !type.startsWith("cf.email.sending.")) {
    throw new AppError(400, "Unsupported queue event type.", "invalid_queue_event");
  }
  const mapped = (CLOUDFLARE_STATUS_MAP as Record<string, string>)[type.replace(/^cf\.email\.sending\./, "")];
  if (!mapped) {
    throw new AppError(422, "Unsupported provider event type.", "unsupported_provider_event");
  }
  const messageId = asText(payload.messageId, 200);
  const recipient = asText(payload.recipient, 320);
  const eventTimestamp = normalizeEventTimestamp(asText(metadata.eventTimestamp, 40) || "");
  const providerEventId = asText(payload.eventId, 200) || await deterministicEventKey("cloudflare", type, messageId, recipient, eventTimestamp);
  return {
    provider: "cloudflare",
    providerEventId,
    providerMessageId: messageId,
    taggedMessageId: "",
    recipients: recipient ? [recipient] : [],
    rawType: type,
    status: mapped,
    occurredAt: eventTimestamp || undefined,
  };
}

async function applyDeliveryStatus(
  env: Env,
  messageId: string,
  providerMessageId: string,
  recipients: string[],
  status: string,
): Promise<void> {
  if (!Object.prototype.hasOwnProperty.call(DELIVERY_RANK, status)) return;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await env.DB.prepare("SELECT recipient_status_json FROM mail_messages WHERE message_id=? LIMIT 1")
      .bind(messageId).first<Row>();
    if (!current) return;
    const previousJson = asText(current.recipient_status_json, 1_000_000) || "{}";
    const summary = updateRecipientSummary(parseJson<Record<string, string>>(previousJson, {}), recipients, status);
    const nextJson = JSON.stringify(summary);
    const aggregate = aggregateDeliveryStatus(summary);
    const result = await env.DB.prepare(
      `UPDATE mail_messages
          SET status=?,recipient_status_json=?,provider_message_id=COALESCE(NULLIF(provider_message_id,''),?),updated_at=?
        WHERE message_id=? AND COALESCE(recipient_status_json,'{}')=?`,
    ).bind(aggregate, nextJson, providerMessageId || null, now(), messageId, previousJson).run();
    const meta = result.meta as { changes?: number };
    if (Number(meta.changes || 0) === 1) return;
  }
  throw new AppError(503, "Delivery status changed concurrently. Resend the event.", "webhook_concurrent_update");
}

export async function applyDeliveryEvent(env: Env, event: NormalizedDeliveryEvent): Promise<{ duplicate: boolean }> {
  // Fast path: a sequential duplicate (same provider + provider_event_id
  // already processed) is a strict no-op — the message status, recipient
  // summary, and updated_at are never re-mutated. The INSERT OR IGNORE and
  // the UNIQUE(provider, provider_event_id) index below remain the final
  // protection for a concurrent race; an event that was never finally
  // inserted (e.g. a status-update failure before the insert) is NOT
  // treated as processed and retries re-enter the pipeline.
  if (event.providerEventId) {
    const existing = await env.DB.prepare(
      "SELECT 1 AS seen FROM mail_delivery_events WHERE provider=? AND provider_event_id=? LIMIT 1",
    ).bind(event.provider, event.providerEventId).first<Row>();
    if (existing) return { duplicate: true };
  }
  let message: Row | null = null;
  if (event.providerMessageId) {
    message = await env.DB.prepare(
      "SELECT * FROM mail_messages WHERE outbound_provider=? AND provider_message_id=? LIMIT 1",
    ).bind(event.provider, event.providerMessageId).first<Row>();
  }
  if (!message && event.taggedMessageId && /^[A-Za-z0-9_-]{8,200}$/.test(event.taggedMessageId)) {
    message = await env.DB.prepare("SELECT * FROM mail_messages WHERE message_id=? AND direction='outgoing' LIMIT 1")
      .bind(event.taggedMessageId).first<Row>();
  }
  if (message && DELIVERY_RANK[event.status] !== undefined) {
    await applyDeliveryStatus(env, String(message.message_id), event.providerMessageId, event.recipients, event.status);
    const { normalizeInternetMessageId } = await import("../mail/helpers.js");
    const providerInternetId = normalizeInternetMessageId(
      event.provider === "resend" ? message.provider_internet_message_id : "",
    );
    if (providerInternetId && message.provider_internet_message_id) {
      await reconcileProviderMessageId(env, message, String(message.provider_internet_message_id));
    }
  }

  const eventId = uuid();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO mail_delivery_events(
      event_id,provider,provider_event_id,provider_message_id,message_id,event_type,status,recipient_json,occurred_at,received_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    eventId, event.provider, event.providerEventId, event.providerMessageId || null,
    message?.message_id || null, event.rawType, event.status, JSON.stringify(event.recipients),
    event.occurredAt || null, now(),
  ).run();
  const eventMeta = inserted.meta as { changes?: number };
  return { duplicate: Number(eventMeta.changes || 0) === 0 };
}

export function deliveryEventResponse(duplicate: boolean): Response {
  return json({ ok: true, duplicate });
}