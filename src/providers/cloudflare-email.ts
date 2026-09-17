import { AppError, asText, bytesToBase64, encoder, now, sha256, type Env, type Row } from "../lib.js";
import { displayFrom } from "../mail/mailbox.js";
import { rawOutgoingMessage } from "../mail/outbound.js";
import type { OutboundProvider, ProviderCapabilities, SendResult } from "./types.js";
import type { SendPlan } from "../mail/types.js";

// Cloudflare Email Sending (Workers send_email binding).
// - Beta, Workers Paid
// - Attachments and CC/BCC supported; total message size limit 5 MiB.
// - No documented provider idempotency: unknown outcomes are never
//   auto-retried; the operator confirms the provider record first.
export const CLOUDFLARE_EMAIL_MAX_BYTES = 5 * 1024 * 1024;

export const CLOUDFLARE_EMAIL_ERRORS = {
  VALIDATION: "E_VALIDATION_ERROR",
  FIELD_MISSING: "E_FIELD_MISSING",
  TOO_MANY_RECIPIENTS: "E_TOO_MANY_RECIPIENTS",
  TOO_MANY_ATTACHMENTS: "E_TOO_MANY_ATTACHMENTS",
  SENDER_NOT_VERIFIED: "E_SENDER_NOT_VERIFIED",
  RECIPIENT_NOT_ALLOWED: "E_RECIPIENT_NOT_ALLOWED",
  RECIPIENT_SUPPRESSED: "E_RECIPIENT_SUPPRESSED",
  SENDER_DOMAIN_NOT_AVAILABLE: "E_SENDER_DOMAIN_NOT_AVAILABLE",
  CONTENT_TOO_LARGE: "E_CONTENT_TOO_LARGE",
  DELIVERY_FAILED: "E_DELIVERY_FAILED",
  RATE_LIMIT_EXCEEDED: "E_RATE_LIMIT_EXCEEDED",
  DAILY_LIMIT_EXCEEDED: "E_DAILY_LIMIT_EXCEEDED",
  INTERNAL_SERVER_ERROR: "E_INTERNAL_SERVER_ERROR",
} as const;

export function classifyCloudflareEmailFailure(code: string): string {
  switch (code) {
    case CLOUDFLARE_EMAIL_ERRORS.RATE_LIMIT_EXCEEDED:
    case CLOUDFLARE_EMAIL_ERRORS.DAILY_LIMIT_EXCEEDED:
      return "provider_rate_limited";
    case CLOUDFLARE_EMAIL_ERRORS.CONTENT_TOO_LARGE:
      return "provider_payload_too_large";
    case CLOUDFLARE_EMAIL_ERRORS.SENDER_NOT_VERIFIED:
    case CLOUDFLARE_EMAIL_ERRORS.SENDER_DOMAIN_NOT_AVAILABLE:
      return "provider_auth_failed";
    case CLOUDFLARE_EMAIL_ERRORS.VALIDATION:
    case CLOUDFLARE_EMAIL_ERRORS.FIELD_MISSING:
    case CLOUDFLARE_EMAIL_ERRORS.TOO_MANY_RECIPIENTS:
    case CLOUDFLARE_EMAIL_ERRORS.TOO_MANY_ATTACHMENTS:
    case CLOUDFLARE_EMAIL_ERRORS.RECIPIENT_NOT_ALLOWED:
    case CLOUDFLARE_EMAIL_ERRORS.RECIPIENT_SUPPRESSED:
      return "provider_rejected";
    case CLOUDFLARE_EMAIL_ERRORS.INTERNAL_SERVER_ERROR:
      return "provider_outcome_unknown";
    default:
      return "provider_outcome_unknown";
  }
}

export function estimateProviderMessageBytes(row: Row, plan: SendPlan, env: Env): number {
  const raw = rawOutgoingMessage(
    displayFrom(plan.mailbox, env),
    plan.to,
    [...plan.cc, ...plan.bcc],
    asText(row.subject, 998),
    plan.text,
    plan.html,
    String(row.internet_message_id || row.message_id),
    String(row.sent_at || row.created_at || now()),
    plan.uploads,
    asText(row.in_reply_to, 998),
    asText(row.references_header, 8_000),
  );
  return raw.byteLength;
}

export function buildCloudflarePayload(row: Row, plan: SendPlan, env: Env): Record<string, unknown> {
  const headers: Record<string, string> = {
    "X-Mailbox-Mail-ID": asText(row.x_mailbox_mail_id, 200),
  };
  if (row.in_reply_to) headers["In-Reply-To"] = String(row.in_reply_to);
  if (row.references_header) headers.References = String(row.references_header);
  return {
    from: displayFrom(plan.mailbox, env),
    to: plan.to,
    ...(plan.cc.length ? { cc: plan.cc } : {}),
    ...(plan.bcc.length ? { bcc: plan.bcc } : {}),
    subject: asText(row.subject, 998),
    text: plan.text,
    ...(plan.html ? { html: plan.html } : {}),
    headers,
    ...(plan.uploads.length
      ? {
          attachments: plan.uploads.map((item) => ({
            content: item.content,
            filename: item.filename,
            type: item.contentType,
            disposition: "attachment",
          })),
        }
      : {}),
  };
}

async function updateRetryableState(env: Env, messageId: unknown, status: "sending" | "retryable_failed" | "failed", error: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE mail_messages SET status=?,last_error=?,updated_at=?
      WHERE message_id=? AND status IN ('sending','retryable_failed')`,
  ).bind(status, error, now(), messageId).run();
}

export class CloudflareEmailProvider implements OutboundProvider {
  readonly id = "cloudflare" as const;
  readonly capabilities: ProviderCapabilities = {
    deliveryEvents: "queue",
    providerIdempotency: false,
    safeRetryWindowMs: null,
    maxMessageBytes: CLOUDFLARE_EMAIL_MAX_BYTES,
    attachments: true,
    ccBcc: true,
    threadingHeaders: true,
  };

  isConfigured(env: Env): boolean {
    return Boolean(env.EMAIL && typeof env.EMAIL.send === "function");
  }

  async send(env: Env, row: Row, plan: SendPlan): Promise<SendResult> {
    if (!this.isConfigured(env)) {
      throw new AppError(503, "The EMAIL (send_email) binding is not configured.", "provider_not_configured");
    }
    const email = env.EMAIL;
    if (!email || typeof email.send !== "function") {
      throw new AppError(503, "The EMAIL (send_email) binding is not configured.", "provider_not_configured");
    }
    const estimated = estimateProviderMessageBytes(row, plan, env);
    if (estimated > CLOUDFLARE_EMAIL_MAX_BYTES) {
      throw new AppError(413, "Message exceeds the Cloudflare Email Service 5 MiB limit.", "provider_payload_too_large");
    }
    const payload = buildCloudflarePayload(row, plan, env);
    let result;
    try {
      result = await email.send(payload);
    } catch (error) {
      const code = asText((error as Error & { code?: unknown })?.code, 200);
      const message = error instanceof Error ? error.message : String(error);
      const failureCode = classifyCloudflareEmailFailure(code);
      if (failureCode === "provider_rate_limited") {
        await updateRetryableState(env, row.message_id, "retryable_failed", `${code || "rate_limited"}:${message.slice(0, 200)}`);
        throw new AppError(429, "The provider is rate limiting requests.", "provider_rate_limited");
      }
      if (failureCode === "provider_rejected" || failureCode === "provider_payload_too_large" || failureCode === "provider_auth_failed") {
        await updateRetryableState(env, row.message_id, "failed", `${code || "rejected"}:${message.slice(0, 200)}`);
        throw new AppError(failureCode === "provider_auth_failed" ? 503 : 422, "Email provider rejected the message.", failureCode);
      }
      // E_INTERNAL_SERVER_ERROR, transport ambiguity, or unknown errors are
      // outcome-unknown: never mark failed, never auto-retry.
      await updateRetryableState(env, row.message_id, "sending", `cloudflare_outcome_unknown:${message.slice(0, 200)}`);
      throw new AppError(503, "The provider outcome is unknown. Verify the provider record before deciding on a new send.", "provider_outcome_unknown");
    }
    const providerMessageId = asText(result?.messageId, 200);
    if (!providerMessageId) {
      await updateRetryableState(env, row.message_id, "sending", "cloudflare_success_without_confirmed_id");
      throw new AppError(503, "The provider accepted the request but did not return a confirmation id.", "provider_outcome_unknown");
    }
    await env.DB.prepare(
      "UPDATE mail_messages SET provider_message_id=COALESCE(NULLIF(provider_message_id,''),?),updated_at=? WHERE message_id=?",
    ).bind(providerMessageId, now(), row.message_id).run();
    return { provider: "cloudflare", providerMessageId };
  }
}

export const cloudflareEmailProvider = new CloudflareEmailProvider();