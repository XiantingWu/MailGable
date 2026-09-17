export const MAX_RAW_BYTES = 20 * 1024 * 1024;
export const MAX_INCOMING_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_INCOMING_TOTAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_INCOMING_ATTACHMENTS = 50;
export const MAX_OUTGOING_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_OUTGOING_TOTAL_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_SEND_BODY_BYTES = Math.ceil(MAX_OUTGOING_TOTAL_ATTACHMENT_BYTES * 4 / 3) + 2_000_000;
export const MAX_RECIPIENTS = 50;
export const MAX_SENDS_PER_HOUR = 20;
export const MAX_SUBJECT = 998;
export const MAX_TEXT_PREVIEW_BYTES = 300_000;
export const MAX_HTML_PREVIEW_BYTES = 600_000;
export const MAX_THREAD_PAGE = 100;
export const MAX_HEADER_ADDRESSES = 100;
export const IDEMPOTENCY_RETRY_WINDOW_MS = 23 * 60 * 60_000;
export const RESEND_API = "https://api.resend.com/emails";

export const SUCCESS_STATUSES = new Set(["sent", "delivery_delayed", "delivered", "opened", "clicked", "partially_failed", "complained", "bounced", "suppressed"]);
export const RETRYABLE_STATUSES = new Set(["sending", "retryable_failed"]);
export const DELIVERY_RANK: Record<string, number> = {
  sending: 0,
  sent: 1,
  delivery_delayed: 2,
  delivered: 3,
  opened: 4,
  clicked: 5,
  failed: 6,
  suppressed: 7,
  bounced: 8,
  complained: 9,
};

export const THREAD_FOLDERS = ["inbox", "sent", "archive", "spam", "trash", "all"] as const;
export const THREAD_STATUS_FOLDERS: Record<string, string> = {
  archive: "archived",
  spam: "spam",
  trash: "trash",
};
export const TRASH_DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_RETENTION_DAYS = 0;
export const RETENTION_DAYS_MAX = 36_500;