// Single source of truth for the non-secret operator config
// (.mailbox/config.json). configure.mjs, setup.mjs, provider.mjs,
// credentials.mjs, and operator-runner.mjs all share this schema, loader,
// and validator; no script invents its own field names or its own parser.
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export const OPERATOR_CONFIG_KEYS = [
  "mode",
  "worker_name",
  "mail_domain",
  "admin_email",
  "app_origin",
  "cloudflare_account_id",
  "cloudflare_zone_id",
  "outbound_provider",
  "d1_name",
  "r2_name",
];

export const OUTBOUND_PROVIDERS = ["none", "resend", "brevo", "cloudflare"];
export const PLACEHOLDER_DOMAINS = ["example.com", "example.org", "example.net", "example.test"];

const CONFIG_FILE = path.join(process.cwd(), ".mailbox", "config.json");

// Canonical .mailbox/config.json loader — the only parser in the repo.
// Honors MAILBOX_CONFIG_FILE for non-interactive/CI configuration.
export function loadOperatorConfig({ env = process.env, configFile = "" } = {}) {
  const file = configFile || env.MAILBOX_CONFIG_FILE || CONFIG_FILE;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export function validateZoneId(value) {
  return /^[a-f0-9]{32}$/i.test(value) && !/^0+$/.test(value);
}

export function validateAccountId(value) {
  return /^[a-f0-9]{32}$/i.test(value) && !/^0+$/.test(value);
}

export function validateOperatorConfig(config) {
  const errors = [];
  if (config.mode !== "production" && config.mode !== "dev") errors.push("mode must be production|dev");
  if (!config.worker_name || /^[a-z0-9-]{1,63}$/i.test(config.worker_name) === false) errors.push("invalid worker_name");
  if (!config.mail_domain || PLACEHOLDER_DOMAINS.includes(config.mail_domain)) errors.push("placeholder/invalid mail_domain");
  if (!config.admin_email || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(config.admin_email)) errors.push("invalid admin_email");
  if (!config.app_origin || !/^https:\/\/[^/]+$/.test(config.app_origin)) errors.push("app_origin must be a bare https origin");
  if (config.mode === "production" && !validateZoneId(config.cloudflare_zone_id || "")) errors.push("cloudflare_zone_id must be 32 hex");
  if (config.mode === "production" && !validateAccountId(config.cloudflare_account_id || "")) errors.push("cloudflare_account_id must be 32 hex (and not all zeroes)");
  if (config.outbound_provider && !OUTBOUND_PROVIDERS.includes(config.outbound_provider)) errors.push("unknown outbound_provider");
  if (config.d1_name && /^[a-z0-9-]{1,63}$/i.test(config.d1_name) === false) errors.push("invalid d1_name");
  if (config.r2_name && /^[a-z0-9-]{1,63}$/i.test(config.r2_name) === false) errors.push("invalid r2_name");
  return { ok: errors.length === 0, errors };
}

// Canonical operator config object; unknown keys are dropped so scripts
// never read ad-hoc fields (zone_id, database_id, ...).
export function canonicalOperatorConfig(config) {
  const canonical = {};
  for (const key of OPERATOR_CONFIG_KEYS) {
    if (config[key] !== undefined && config[key] !== "") canonical[key] = config[key];
  }
  return canonical;
}