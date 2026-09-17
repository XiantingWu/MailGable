import type { Env, Row } from "../lib.js";
import type { SendPlan } from "../mail/types.js";

export type ProviderId = "resend" | "brevo" | "cloudflare";
export type DeliveryEventChannel = "webhook" | "queue" | "none";

export interface ProviderCapabilities {
  deliveryEvents: DeliveryEventChannel;
  providerIdempotency: boolean;
  /** Application-safe retry window for unknown outcomes; null = never auto-retry. */
  safeRetryWindowMs: number | null;
  maxMessageBytes: number | null;
  attachments: boolean;
  ccBcc: boolean;
  threadingHeaders: boolean;
}

export interface SendResult {
  provider: ProviderId;
  providerMessageId: string;
}

export interface OutboundProvider {
  id: ProviderId;
  capabilities: ProviderCapabilities;
  isConfigured(env: Env): boolean;
  send(env: Env, row: Row, plan: SendPlan): Promise<SendResult>;
}

export interface NormalizedDeliveryEvent {
  provider: ProviderId;
  providerEventId: string;
  providerMessageId: string;
  taggedMessageId?: string;
  recipients: string[];
  rawType: string;
  status: string;
  occurredAt?: string;
}