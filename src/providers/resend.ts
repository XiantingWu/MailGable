import { AppError, asText, now, type Env, type Row } from "../lib.js";
import { RESEND_API } from "../mail/constants.js";
import { displayFrom } from "../mail/mailbox.js";
import { classifyResendFailure } from "../resend-policy.js";
import type { OutboundProvider, SendResult } from "./types.js";
import type { SendPlan } from "../mail/types.js";

export const RESEND_SAFE_RETRY_WINDOW_MS = 23 * 60 * 60_000;

function providerPayload(row: Row, plan: SendPlan, env: Env): Row {
  return {
    from: displayFrom(plan.mailbox, env),
    to: plan.to,
    cc: plan.cc.length ? plan.cc : undefined,
    bcc: plan.bcc.length ? plan.bcc : undefined,
    subject: row.subject,
    text: plan.text || undefined,
    html: plan.html || undefined,
    tags: [{ name: "message_id", value: String(row.message_id) }],
    headers: {
      "X-Mailbox-Mail-ID": row.x_mailbox_mail_id,
      ...(row.in_reply_to ? { "In-Reply-To": String(row.in_reply_to) } : {}),
      ...(row.references_header ? { References: String(row.references_header) } : {}),
    },
    attachments: plan.uploads.length ? plan.uploads.map((item) => ({ filename: item.filename, content: item.content })) : undefined,
  };
}

async function updateRetryableState(env: Env, messageId: unknown, status: "sending" | "retryable_failed" | "failed", error: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE mail_messages SET status=?,last_error=?,updated_at=?
      WHERE message_id=? AND status IN ('sending','retryable_failed')`,
  ).bind(status, error, now(), messageId).run();
}

export class ResendProvider implements OutboundProvider {
  readonly id = "resend" as const;
  readonly capabilities = {
    deliveryEvents: "webhook" as const,
    providerIdempotency: true,
    safeRetryWindowMs: RESEND_SAFE_RETRY_WINDOW_MS,
    maxMessageBytes: null,
    attachments: true,
    ccBcc: true,
    threadingHeaders: true,
  };

  isConfigured(env: Env): boolean {
    return Boolean(env.RESEND_API_KEY);
  }

  async send(env: Env, row: Row, plan: SendPlan): Promise<SendResult> {
    if (!env.RESEND_API_KEY) throw new AppError(503, "RESEND_API_KEY is not configured.", "provider_not_configured");
    let response: Response;
    try {
      response = await fetch(RESEND_API, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": asText(row.idempotency_key, 256),
        },
        body: JSON.stringify(providerPayload(row, plan, env)),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      await updateRetryableState(env, row.message_id, "sending", timedOut ? "resend_timeout_outcome_unknown" : "resend_outcome_unknown");
      throw new AppError(503, "The provider outcome is unknown. Retry the archived message; the same key prevents duplicates.", "provider_outcome_unknown");
    }

    const result = await response.json().catch(() => ({})) as Row;
    if (response.ok && !result.id) {
      await updateRetryableState(env, row.message_id, "sending", "resend_success_without_confirmed_id");
      throw new AppError(503, "The provider accepted the request but did not return a confirmation id. Retry the archived message with the same key.", "provider_outcome_unknown");
    }
    if (!response.ok) {
      const providerCode = asText(result.name || result.code, 100);
      const providerMessage = asText(result.message || result.name, 500) || `HTTP ${response.status}`;
      const retryAfter = asText(response.headers.get("Retry-After"), 100);
      const providerError = retryAfter ? `${providerMessage}; retry-after=${retryAfter}` : providerMessage;
      const failureCode = classifyResendFailure(response.status, providerCode);
      if (failureCode === "provider_retryable") {
        await updateRetryableState(env, row.message_id, "retryable_failed", providerError);
        throw new AppError(response.status === 429 ? 429 : 503, "The provider temporarily rejected the request. Retry the archived message unchanged.", failureCode);
      }
      await updateRetryableState(env, row.message_id, "failed", providerError);
      throw new AppError(failureCode === "provider_idempotency_mismatch" ? 409 : 422, "Email provider rejected the message.", failureCode);
    }
    const providerMessageId = asText(result.id, 200);
    await env.DB.prepare(
      "UPDATE mail_messages SET provider_message_id=COALESCE(NULLIF(provider_message_id,''),?),updated_at=? WHERE message_id=?",
    ).bind(providerMessageId, now(), row.message_id).run();
    return { provider: "resend", providerMessageId };
  }
}

export const resendProvider = new ResendProvider();