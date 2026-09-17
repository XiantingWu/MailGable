import { logError } from "./log.js";
import {
  AppError,
  asText,
  normalizeEmail,
  now,
  truncateUtf8,
  validEmail,
  type Env,
  type Row,
} from "./lib.js";

export function inboundForwardAddresses(env: Pick<Env, "INBOUND_FORWARD_TO">): string[] {
  const raw = asText(env.INBOUND_FORWARD_TO, 2_000)
    .split(/[;,\n]+/)
    .map(normalizeEmail)
    .filter(Boolean);
  if (raw.some((entry) => !validEmail(entry))) {
    throw new AppError(
      503,
      "Inbound forwarding contains an invalid address. Fix INBOUND_FORWARD_TO or leave it empty to disable forwarding.",
      "inbound_forward_invalid_config",
    );
  }
  return [...new Set(raw)];
}

const FORWARD_CLAIM_STALE_MINUTES = 15;

type InboundForwardEnv = Pick<Env, "DB" | "INBOUND_FORWARD_TO" | "LOG_LEVEL">;
type ForwardableMessage = Pick<ForwardableEmailMessage, "forward" | "headers">;
type ForwardAttempt = Row & { target?: unknown; status?: unknown };

function safeForwardError(error: unknown): { name: string; message: string } {
  const rawName = error instanceof AppError ? error.code : error instanceof Error ? error.name : "Error";
  const name = truncateUtf8(
    asText(rawName, 100).replace(/[\r\n\t]+/g, " ").trim() || "Error",
    100,
  );
  const message = truncateUtf8(
    asText(error instanceof Error ? error.message : error, 2_000).replace(/[\r\n\t]+/g, " ").trim() || "Unknown forwarding error",
    500,
  );
  return { name, message };
}

function safeAuditHeader(value: unknown, maxBytes: number): string {
  return truncateUtf8(asText(value, maxBytes).replace(/[\r\n\t]+/g, " ").trim(), maxBytes);
}

function forwardAuditHeaders(
  message: Pick<ForwardableEmailMessage, "headers">,
  messageId: string,
  envelopeTo: string,
  target: string,
): Headers {
  const headers = new Headers();
  headers.set("X-Mailbox-Archive-ID", safeAuditHeader(messageId, 200));
  headers.set("X-Mailbox-Original-Recipient", safeAuditHeader(normalizeEmail(envelopeTo), 300));
  headers.set("X-Mailbox-Forward-Target", safeAuditHeader(target, 300));
  const internetMessageId = safeAuditHeader(message.headers.get("message-id"), 500);
  if (internetMessageId) headers.set("X-Mailbox-Original-Message-ID", internetMessageId);
  return headers;
}


async function ensureAttemptRows(env: InboundForwardEnv, messageId: string, targets: string[], timestamp: string): Promise<void> {
  await env.DB.batch(targets.map((target) => env.DB.prepare(
    `INSERT OR IGNORE INTO inbound_forward_attempts(
       message_id,target,status,attempts,last_error,last_attempt_at,accepted_at,created_at,updated_at
     ) VALUES(?,?,'pending',0,NULL,NULL,NULL,?,?)`,
  ).bind(messageId, target, timestamp, timestamp)));
}

async function attemptStatus(env: InboundForwardEnv, messageId: string, target: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT status FROM inbound_forward_attempts WHERE message_id=? AND target=? LIMIT 1",
  ).bind(messageId, target).first<ForwardAttempt>();
  return asText(row?.status, 40);
}

async function claimTarget(env: InboundForwardEnv, messageId: string, target: string, timestamp: string): Promise<"claimed" | "accepted" | "busy"> {
  const result = await env.DB.prepare(
    `UPDATE inbound_forward_attempts
        SET status='in_flight',attempts=attempts+1,last_error=NULL,last_attempt_at=?,updated_at=?
      WHERE message_id=? AND target=?
        AND (
          status IN ('pending','failed')
          OR (
            status='in_flight'
            AND (last_attempt_at IS NULL OR datetime(last_attempt_at)<=datetime(?,'-${FORWARD_CLAIM_STALE_MINUTES} minutes'))
          )
        )`,
  ).bind(timestamp, timestamp, messageId, target, timestamp).run();
  const meta = result.meta as { changes?: number };
  if (Number(meta.changes || 0) === 1) return "claimed";
  return (await attemptStatus(env, messageId, target)) === "accepted" ? "accepted" : "busy";
}

async function markForwardAccepted(env: InboundForwardEnv, messageId: string, target: string, timestamp: string): Promise<void> {
  // `accepted` means message.forward() returned successfully and Cloudflare
  // accepted the forwarding request. It is not proof that the destination MX
  // ultimately delivered the message; final delivery is observed in Email
  // Routing Activity / emailRoutingAdaptive.
  await env.DB.prepare(
    `UPDATE inbound_forward_attempts
        SET status='accepted',last_error=NULL,accepted_at=COALESCE(accepted_at,?),updated_at=?
      WHERE message_id=? AND target=?`,
  ).bind(timestamp, timestamp, messageId, target).run();
}

async function markFailed(env: InboundForwardEnv, messageId: string, target: string, error: unknown, timestamp: string): Promise<void> {
  const detail = safeForwardError(error);
  await env.DB.prepare(
    `UPDATE inbound_forward_attempts
        SET status='failed',last_error=?,updated_at=?
      WHERE message_id=? AND target=? AND status<>'accepted'`,
  ).bind(`${detail.name}: ${detail.message}`, timestamp, messageId, target).run();
  logError(env, "Inbound forwarding request failed", {
    message_id: messageId,
    target,
    error_name: detail.name,
    error_message: detail.message,
    occurred_at: timestamp,
  });
}

export async function forwardInboundCopies(
  message: ForwardableMessage,
  env: InboundForwardEnv,
  messageId: string,
  envelopeTo: string,
): Promise<void> {
  const targets = inboundForwardAddresses(env);
  if (!targets.length) return;
  const recipient = normalizeEmail(envelopeTo);
  if (targets.includes(recipient)) {
    throw new AppError(503, "Inbound forwarding would create a delivery loop.", "inbound_forward_loop");
  }

  const timestamp = now();
  await ensureAttemptRows(env, messageId, targets, timestamp);

  const claimed: string[] = [];
  let acceptedCount = 0;
  let busyCount = 0;
  for (const target of targets) {
    const state = await claimTarget(env, messageId, target, timestamp);
    if (state === "claimed") claimed.push(target);
    else if (state === "accepted") acceptedCount += 1;
    else busyCount += 1;
  }

  // Cloudflare supports one forward() call per verified destination. Keep the
  // requests isolated so one synchronous failure cannot prevent the other
  // backup request, but do not add an arbitrary delay: downstream SMTP pacing
  // and retries are Cloudflare's responsibility after the request is accepted.
  let failedCount = 0;
  for (const target of claimed) {
    try {
      await message.forward(target, forwardAuditHeaders(message, messageId, envelopeTo, target));
      acceptedCount += 1;
      await markForwardAccepted(env, messageId, target, now());
    } catch (error) {
      failedCount += 1;
      await markFailed(env, messageId, target, error, now());
    }
  }

  // Backup forwarding is deliberately best-effort relative to the authoritative
  // D1/R2 archive. A partial backup failure is recorded but must not reject an
  // otherwise archived inbound message. A synchronous failure remains eligible
  // for retry if the original message is redelivered; there is no autonomous
  // native-forward replay once the EmailMessage event has ended.
  if (acceptedCount > 0) return;
  if (failedCount > 0 || busyCount > 0) {
    throw new AppError(
      502,
      "No inbound backup forwarding destination accepted the request.",
      "inbound_forward_failed",
    );
  }
}
