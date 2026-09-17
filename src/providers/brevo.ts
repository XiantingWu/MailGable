import { AppError, asText, encoder, now, type Env, type Row } from "../lib.js";
import { displayFrom } from "../mail/mailbox.js";
import type { OutboundProvider, SendResult } from "./types.js";
import type { SendPlan } from "../mail/types.js";

export const BREVO_API = "https://api.brevo.com/v3/smtp/email";
// Brevo documents an idempotencyKey TTL of approximately 30 minutes.
// The application retry window is a conservative 25 minutes.
export const BREVO_SAFE_RETRY_WINDOW_MS = 25 * 60_000;

function brevoPayload(row: Row, plan: SendPlan, env: Env): Row {
  return {
    sender: { name: asText(plan.mailbox.display_name, 200), email: normalizeSender(plan.mailbox, env) },
    to: plan.to.map((address) => ({ email: address })),
    ...(plan.cc.length ? { cc: plan.cc.map((address) => ({ email: address })) } : {}),
    ...(plan.bcc.length ? { bcc: plan.bcc.map((address) => ({ email: address })) } : {}),
    subject: asText(row.subject, 998),
    ...(plan.text ? { textContent: plan.text } : {}),
    ...(plan.html ? { htmlContent: plan.html } : {}),
    ...(plan.uploads.length ? { attachment: plan.uploads.map((item) => ({ name: item.filename, content: item.content })) } : {}),
    headers: {
      "X-Mailbox-Mail-ID": row.x_mailbox_mail_id,
      "idempotencyKey": String(row.message_id),
    },
    tags: [`mailbox:${row.message_id}`],
  };
}

function normalizeSender(mailbox: Row, env: Env): string {
  const address = asText(mailbox.address, 320).trim().toLowerCase();
  return address;
}

async function updateRetryableState(env: Env, messageId: unknown, status: "sending" | "retryable_failed" | "failed", error: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE mail_messages SET status=?,last_error=?,updated_at=?
      WHERE message_id=? AND status IN ('sending','retryable_failed')`,
  ).bind(status, error, now(), messageId).run();
}

export class BrevoProvider implements OutboundProvider {
  readonly id = "brevo" as const;
  readonly capabilities = {
    deliveryEvents: "webhook" as const,
    providerIdempotency: true,
    safeRetryWindowMs: BREVO_SAFE_RETRY_WINDOW_MS,
    maxMessageBytes: null,
    attachments: true,
    ccBcc: true,
    // Brevo's Transactional API headers only support non-standard custom
    // headers; standard threading headers are not supported.
    threadingHeaders: false,
  };

  isConfigured(env: Env): boolean {
    return Boolean(env.BREVO_API_KEY);
  }

  async send(env: Env, row: Row, plan: SendPlan): Promise<SendResult> {
    if (!env.BREVO_API_KEY) throw new AppError(503, "BREVO_API_KEY is not configured.", "provider_not_configured");
    let response: Response;
    try {
      response = await fetch(BREVO_API, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "api-key": env.BREVO_API_KEY,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(brevoPayload(row, plan, env)),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      await updateRetryableState(env, row.message_id, "sending", timedOut ? "brevo_timeout_outcome_unknown" : "brevo_outcome_unknown");
      throw new AppError(503, "The provider outcome is unknown. Retry the archived message.", "provider_outcome_unknown");
    }

    const result = await response.json().catch(() => ({})) as Row;
    if (response.ok && !result.messageId) {
      await updateRetryableState(env, row.message_id, "sending", "brevo_success_without_confirmed_id");
      throw new AppError(503, "The provider accepted the request but did not return a confirmation id. Retry the archived message.", "provider_outcome_unknown");
    }
    if (!response.ok) {
      const providerCode = asText(result.code, 100);
      const providerMessage = asText(result.message, 500) || `HTTP ${response.status}`;
      const failureCode = classifyBrevoFailure(response.status, providerCode);
      if (failureCode === "provider_retryable") {
        await updateRetryableState(env, row.message_id, "retryable_failed", providerMessage);
        throw new AppError(response.status === 429 ? 429 : 503, "The provider temporarily rejected the request. Retry the archived message unchanged.", failureCode);
      }
      await updateRetryableState(env, row.message_id, "failed", providerMessage);
      throw new AppError(response.status === 401 || response.status === 403 ? 503 : 422, "Email provider rejected the message.", failureCode);
    }
    const providerMessageId = asText(result.messageId, 200);
    await env.DB.prepare(
      "UPDATE mail_messages SET provider_message_id=COALESCE(NULLIF(provider_message_id,''),?),updated_at=? WHERE message_id=?",
    ).bind(providerMessageId, now(), row.message_id).run();
    return { provider: "brevo", providerMessageId };
  }
}

export function classifyBrevoFailure(status: number, code: string): string {
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (status === 429) return "provider_retryable";
  if (status === 400 && /validation|payload/i.test(code)) return "provider_rejected";
  if (status >= 500) return "provider_retryable";
  return "provider_rejected";
}

export const brevoProvider = new BrevoProvider();

export function serializeOutgoingBytes(row: Row, plan: SendPlan, env: Env): number {
  const payload = JSON.stringify(brevoPayload(row, plan, env));
  return encoder.encode(payload).byteLength;
}