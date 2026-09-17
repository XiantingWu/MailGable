// Pure setup logic for MailGable deployment tooling. No CLI side effects
// here: every function is deterministic and testable without Cloudflare
// credentials. The CLI (setup.mjs) handles process/network execution.
import { createHash } from "node:crypto";
import { requiredSecretsFor } from "./config/credentials.mjs";

export const MODES = ["dev", "production"];
export const R2_SENTINEL_KEY = "_mailbox/install.json";
export const R2_SENTINEL_SCHEMA = "mailbox-r2-v1";
export const PLACEHOLDER_DOMAINS = ["example.com", "example.org", "example.net", "example.test"];
export const PLACEHOLDER_WORKER_NAMES = ["mailgable-dev"];
export const KNOWN_MAILBOX_TABLES = [
  "admins", "admin_sessions", "auth_attempts", "admin_audit_log",
  "mailboxes", "mail_threads", "mail_messages", "mail_attachments",
  "mail_delivery_events", "inbound_forward_attempts", "mail_ops_probes",
];

export function parseSetupArgs(args) {
  const get = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : "";
  };
  return {
    mode: get("--mode") || "dev",
    dryRun: args.includes("--dry-run"),
    appOrigin: get("--app-origin") || process.env.APP_ORIGIN || "",
    workerName: get("--worker-name") || process.env.MAILGABLE_WORKER_NAME || "",
    mailDomain: get("--mail-domain") || process.env.MAIL_DOMAIN || "",
    adminEmail: get("--admin-email") || process.env.ADMIN_EMAIL || "",
    zoneId: get("--zone-id") || process.env.CLOUDFLARE_ZONE_ID || "",
    d1Name: get("--d1-name") || process.env.MAILGABLE_D1_NAME || "",
    r2Name: get("--r2-name") || process.env.MAILGABLE_R2_NAME || "",
    adoptEmptyResources: args.includes("--adopt-empty-resources"),
    deployOnly: args.includes("--deploy-only"),
    migrateOnly: args.includes("--migrate-only"),
  };
}

export function validateMode(mode) {
  if (!MODES.includes(mode)) return { ok: false, code: "invalid_mode" };
  return { ok: true };
}

export function strictOrigin(appOrigin) {
  try {
    const url = new URL(appOrigin);
    if (url.protocol !== "https:") return { ok: false, code: "origin_protocol" };
    if (!url.hostname) return { ok: false, code: "origin_hostname" };
    if (url.username || url.password) return { ok: false, code: "origin_userinfo" };
    if (url.pathname !== "/") return { ok: false, code: "origin_path" };
    if (url.search || url.hash) return { ok: false, code: "origin_query" };
    return { ok: true, host: url.hostname };
  } catch {
    return { ok: false, code: "origin_invalid" };
  }
}

export function isPlaceholder(value, placeholders) {
  const normalized = String(value || "").trim().toLowerCase();
  return placeholders.some((placeholder) => normalized === placeholder || normalized.endsWith(`@${placeholder}`));
}

export function validateProductionInputs(inputs) {
  const { appOrigin, mailDomain, adminEmail, zoneId, workerName } = inputs;
  const d1Name = inputs.d1Name || `${workerName}-db`;
  const r2Name = inputs.r2Name || `${workerName}-r2`;
  const origin = strictOrigin(appOrigin);
  if (!origin.ok) return { ok: false, code: origin.code, detail: "APP_ORIGIN" };
  if (!mailDomain || isPlaceholder(mailDomain, PLACEHOLDER_DOMAINS)) return { ok: false, code: "placeholder_mail_domain" };
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(mailDomain)) return { ok: false, code: "invalid_mail_domain" };
  if (!adminEmail || isPlaceholder(adminEmail, PLACEHOLDER_DOMAINS)) return { ok: false, code: "placeholder_admin_email" };
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(adminEmail)) return { ok: false, code: "invalid_admin_email" };
  if (!zoneId || !/^[a-f0-9]{32}$/i.test(zoneId) || /^0+$/.test(zoneId)) return { ok: false, code: "invalid_zone_id" };
  const accountId = inputs.accountId || "";
  if (!/^[0-9a-f]{32}$/i.test(accountId) || /^0+$/.test(accountId)) return { ok: false, code: "invalid_account_id" };
  if (!workerName || PLACEHOLDER_WORKER_NAMES.includes(workerName) || workerName.length > 128 || !/^[a-z0-9-]+$/i.test(workerName)) {
    return { ok: false, code: "invalid_worker_name" };
  }
  if (!d1Name || !/^[a-z0-9-]{1,63}$/i.test(d1Name)) return { ok: false, code: "invalid_d1_name" };
  if (!r2Name || !/^[a-z0-9-]{1,63}$/i.test(r2Name)) return { ok: false, code: "invalid_r2_name" };
  return { ok: true, originHost: origin.host };
}

export function buildSetupPlan(template, args, databaseId, secrets) {
  const mode = args.mode;
  const workerName = mode === "production" ? args.workerName : String(template.name || "mailgable-dev");
  const d1Name = args.d1Name || (mode === "production" ? `${workerName}-db` : String(template.d1_databases?.[0]?.database_name || "mailgable-db"));
  const r2Name = args.r2Name || (mode === "production" ? `${workerName}-r2` : String(template.r2_buckets?.[0]?.bucket_name || "mailgable-r2"));
  return {
    mode,
    workerName,
    mailDomain: args.mailDomain || "",
    adminEmail: args.adminEmail || "",
    zoneId: args.zoneId || "",
    accountId: args.accountId || "",
    d1Name,
    r2Name,
    databaseId,
    outboundProvider: args.outboundProvider || "none",
    workersDev: mode !== "production",
    appOrigin: args.appOrigin,
    appOriginHost: args.appOrigin ? new URL(args.appOrigin).hostname : "",
    secrets,
  };
}

export function buildGeneratedConfig(template, plan) {
  const config = JSON.parse(JSON.stringify(template));
  config.name = plan.workerName;
  config.d1_databases = config.d1_databases.map((item) => ({
    ...item,
    database_name: plan.d1Name,
    database_id: plan.databaseId,
  }));
  config.r2_buckets = config.r2_buckets.map((item) => ({ ...item, bucket_name: plan.r2Name }));
  if (plan.mode === "production") {
    config.workers_dev = false;
    config.preview_urls = false;
    config.routes = [{ pattern: plan.appOriginHost, custom_domain: true }];
    config.vars = {
      ...(config.vars || {}),
      APP_ORIGIN: plan.appOrigin,
      MAIL_WORKER_NAME: plan.workerName,
      MAIL_DOMAIN: plan.mailDomain,
      ADMIN_EMAIL: plan.adminEmail,
      CLOUDFLARE_ZONE_ID: plan.zoneId,
      OUTBOUND_PROVIDER: plan.outboundProvider,
    };
    // Wrangler secrets.required: long-lived runtime secrets for the active
    // provider plus the routing token when routing sync is enabled. Never
    // ADMIN_BOOTSTRAP_TOKEN (transient) or setup-only credentials.
    config.secrets = {
      required: requiredSecretsFor(plan.outboundProvider),
    };
    if (plan.outboundProvider === "cloudflare") {
      config.send_email = [{ name: "EMAIL" }];
      // The Email Sending Event Subscription produces into the queue; the
      // Worker only consumes, so no producer binding is generated.
      config.queues = {
        consumers: [{ queue: `${plan.workerName}-email-events`, max_batch_size: 10, max_retries: 5 }],
      };
    } else {
      delete config.send_email;
      delete config.queues;
    }
  } else {
    config.workers_dev = true;
    config.preview_urls = false;
    delete config.routes;
    delete config.send_email;
    delete config.queues;
  }
  return config;
}

export function configInvariants(config) {
  const problems = [];
  if (config.name !== config.vars?.MAIL_WORKER_NAME) {
    problems.push("name must equal MAIL_WORKER_NAME");
  }
  if (config.workers_dev === false && (!Array.isArray(config.routes) || config.routes.length !== 1 || config.routes[0]?.custom_domain !== true)) {
    problems.push("production requires exactly one custom-domain route");
  }
  if (config.workers_dev === true && config.routes?.length) {
    problems.push("dev mode must not carry production routes");
  }
  return problems;
}

export function classifyD1State(listing, name) {
  if (!Array.isArray(listing)) return { kind: "list_error", code: "d1_list_error" };
  const match = listing.find((item) => String(item.name || item.database_name || "") === name);
  if (!match) return { kind: "missing" };
  return { kind: "present", id: String(match.uuid || match.id || "") };
}

export function classifyR2State(listing, name) {
  if (!Array.isArray(listing)) return { kind: "list_error", code: "r2_list_error" };
  const match = listing.find((item) => String(item.name || "") === name);
  if (!match) return { kind: "missing" };
  return { kind: "present" };
}

export function r2Sentinel() {
  return { schema: R2_SENTINEL_SCHEMA };
}

export function isKnownMailboxSchema(tables) {
  if (!Array.isArray(tables)) return false;
  const names = tables.map((row) => String(row.name || "")).filter(Boolean);
  if (names.length === 0) return { ok: true, empty: true };
  const known = new Set(KNOWN_MAILBOX_TABLES);
  const allKnown = names.every((name) => known.has(name));
  return { ok: allKnown, empty: false, unknown: names.filter((name) => !known.has(name)) };
}

export function buildSecretPlan(env) {
  const present = (name) => Boolean(env[name]);
  const required = present("AUTH_PEPPER") && present("ADMIN_BOOTSTRAP_TOKEN");
  return {
    auth_pepper: present("AUTH_PEPPER"),
    admin_bootstrap_token: present("ADMIN_BOOTSTRAP_TOKEN"),
    cloudflare_routing_read_token: present("CLOUDFLARE_ROUTING_READ_TOKEN"),
    resend_api_key: present("RESEND_API_KEY"),
    resend_webhook_secret: present("RESEND_WEBHOOK_SECRET"),
    requiredPresent: required,
  };
}

export function configHash(config) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}