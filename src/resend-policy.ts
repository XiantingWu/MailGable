export type ResendFailureCode = "provider_retryable" | "provider_idempotency_mismatch" | "provider_rejected";

export function isRetryableResendResponse(status: number, code = ""): boolean {
  return status === 408
    || status === 425
    || status === 429
    || status >= 500
    || (status === 409 && code === "concurrent_idempotent_requests");
}

export function classifyResendFailure(status: number, code = ""): ResendFailureCode {
  if (isRetryableResendResponse(status, code)) return "provider_retryable";
  if (status === 409 && code === "invalid_idempotent_request") return "provider_idempotency_mismatch";
  return "provider_rejected";
}
