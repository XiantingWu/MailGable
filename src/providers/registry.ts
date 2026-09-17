import type { Env } from "../lib.js";
import { resendProvider } from "./resend.js";
import { brevoProvider } from "./brevo.js";
import { cloudflareEmailProvider } from "./cloudflare-email.js";
import type { OutboundProvider, ProviderId } from "./types.js";

const REGISTRY: OutboundProvider[] = [resendProvider, brevoProvider, cloudflareEmailProvider];

export function getProviderById(id: ProviderId): OutboundProvider | null {
  return REGISTRY.find((provider) => provider.id === id) || null;
}

export function configuredProviderId(env: Env): ProviderId | null {
  const configured = (env.OUTBOUND_PROVIDER || "none").toLowerCase();
  if (configured === "none") return null;
  const provider = getProviderById(configured as ProviderId);
  if (provider && provider.isConfigured(env)) return provider.id;
  return null;
}

export function getOutboundProvider(env: Env): OutboundProvider | null {
  const id = configuredProviderId(env);
  return id ? getProviderById(id) : null;
}

export function providerForMessage(env: Env, row: import("../lib.js").Row): OutboundProvider | null {
  const pinned = String(row.outbound_provider || "");
  if (!pinned || pinned === "none") return null;
  const provider = getProviderById(pinned as ProviderId);
  if (!provider) return null;
  if (!provider.isConfigured(env)) {
    const error = new Error(`provider ${pinned} is not configured for retry of archived message.`);
    (error as Error & { code?: string }).code = "provider_not_configured_for_retry";
    throw error;
  }
  return provider;
}