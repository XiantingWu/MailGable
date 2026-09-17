// Runtime secrets for the MailGable Worker.
//
// These are installed with `wrangler secret put` and therefore never appear
// in wrangler.jsonc, so `wrangler types` cannot infer them. They are declared
// here as optional fields on the Env interfaces (declaration merging with the
// Wrangler-generated types) so typecheck is stable in environments without a
// local .dev.vars file. Runtime access always treats them as possibly-absent
// (fail-closed, e.g. requireAuthPepper).

declare namespace Cloudflare {
  interface Env {
    OUTBOUND_PROVIDER?: string;
    EMAIL?: SendEmail;
    AUTH_PEPPER?: string;
    ADMIN_BOOTSTRAP_TOKEN?: string;
    RESEND_API_KEY?: string;
    RESEND_WEBHOOK_SECRET?: string;
    BREVO_API_KEY?: string;
    BREVO_WEBHOOK_TOKEN?: string;
    CLOUDFLARE_ROUTING_READ_TOKEN?: string;
  }
}

interface Env {
  OUTBOUND_PROVIDER?: string;
  AUTH_PEPPER?: string;
  ADMIN_BOOTSTRAP_TOKEN?: string;
  RESEND_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  BREVO_API_KEY?: string;
  BREVO_WEBHOOK_TOKEN?: string;
  CLOUDFLARE_ROUTING_READ_TOKEN?: string;
}

interface EmailSendResult {
  messageId: string;
}

interface SendEmail {
  send(message: Record<string, unknown>): Promise<EmailSendResult>;
}