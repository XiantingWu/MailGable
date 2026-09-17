// Provider webhook/queue reconciliation.
//
//   reconcileResend({ appOrigin, credentials, writeSecret })
//   reconcileBrevo({ appOrigin, credentials, writeSecret })
//   reconcileCloudflare({ workerName, mailDomain, zoneId, runCaptureWrangler, runInheritWrangler })
//   deleteResendWebhook({ appOrigin, credentials })
//   deleteBrevoWebhook({ appOrigin, credentials })
//   deleteCloudflareSubscription({ workerName, mailDomain, zoneId, runCaptureWrangler, runInheritWrangler })
//
// Every reconcile is idempotent: running it twice never duplicates a
// webhook, queue, or subscription. Ownership is always EXACT (full
// endpoint equality / exact source+domain+zone), never a path suffix.
// Secrets are written only via the caller-supplied writeSecret() (stdin)
// and never printed.
//
// Cloudflare reconciliation is Wrangler-only: runCaptureWrangler and
// runInheritWrangler are the sole accepted runners, so every authenticated
// `queues`/`deploy` invocation flows through operator-runner.mjs and the
// central credential store. A generic spawn runner is never accepted here.
import path from "node:path";
import { runInheritWrangler, runCaptureWrangler } from "./operator-runner.mjs";
import { loadOperatorConfig } from "./config/operator-config.mjs";

const RESEND_API = "https://api.resend.com";
const BREVO_API = "https://api.brevo.com/v3";
const GENERATED = path.join(process.cwd(), "wrangler.deploy.jsonc");

// Phase D: full official Resend event names (email.* namespace).
export const RESEND_WEBHOOK_EVENTS = [
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
];

export const BREVO_WEBHOOK_EVENTS = ["sent", "delivered", "hardBounce", "softBounce", "blocked", "spam", "invalid", "deferred"];

export const CLOUDFLARE_QUEUE_EVENTS = [
  "message.delivered",
  "message.deferred",
  "message.bounced",
  "message.failed",
  "message.rejected",
  "message.complained",
];

// Phase I: pure argv builders, tested argument by argument.
export function cloudflareQueueSubscriptionCreateArgv(queueName, { zoneId, mailDomain }) {
  const argv = ["wrangler", "queues", "subscription", "create", queueName, "--source", "email.sending"];
  argv.push("--events", CLOUDFLARE_QUEUE_EVENTS.join(","));
  if (zoneId) argv.push("--zone-id", zoneId);
  if (mailDomain) argv.push("--domain", mailDomain);
  argv.push("--config", GENERATED);
  return argv;
}

export function cloudflareQueueSubscriptionUpdateArgv(queueName, subscriptionId) {
  return [
    "wrangler", "queues", "subscription", "update", queueName,
    "--id", String(subscriptionId),
    "--events", CLOUDFLARE_QUEUE_EVENTS.join(","),
    "--config", GENERATED,
  ];
}

export function cloudflareQueueSubscriptionDeleteArgv(queueName, subscriptionId) {
  return [
    "wrangler", "queues", "subscription", "delete", queueName,
    "--id", String(subscriptionId),
    "--force",
    "--config", GENERATED,
  ];
}

export function cloudflareQueueListArgv() {
  return ["wrangler", "queues", "list", "--config", GENERATED, "--json"];
}

export function cloudflareQueueSubscriptionListArgv(queueName) {
  return ["wrangler", "queues", "subscription", "list", queueName, "--config", GENERATED, "--json"];
}

// Phase J: EXACT ownership. A subscription is MailGable-owned only when
// source == email.sending AND domain == the exact configured sending
// domain AND (when the zone id is known) the zone matches.
export function isCloudflareSubscriptionOwned(subscription, { mailDomain, zoneId }) {
  if (!subscription || subscription.source !== "email.sending") return false;
  if (subscription.domain !== mailDomain) return false;
  if (zoneId && subscription.zone_id && subscription.zone_id !== zoneId) return false;
  return true;
}

// Canonical .mailbox/config.json read through the single operator-config
// parser (scripts/config/operator-config.mjs). No second parser here.
export function readConfig() {
  return loadOperatorConfig();
}

// Brevo management key: a single BREVO_API_KEY is the default credential for
// both sending and webhook management; BREVO_SETUP_API_KEY is an OPTIONAL
// advanced isolation override when the operator keeps a separate
// management key.
export function brevoManagementKey(credentials) {
  return credentials.BREVO_SETUP_API_KEY || credentials.BREVO_API_KEY || "";
}

function apiHeaders(credentials) {
  const headers = { "Content-Type": "application/json" };
  if (credentials.RESEND_SETUP_API_KEY) headers.Authorization = `Bearer ${credentials.RESEND_SETUP_API_KEY}`;
  const brevoKey = brevoManagementKey(credentials);
  if (brevoKey) headers["api-key"] = brevoKey;
  return headers;
}

async function resendFetch(path, options = {}, credentials) {
  const response = await fetch(`${RESEND_API}${path}`, { ...options, headers: { ...apiHeaders(credentials), ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`Resend ${options.method || "GET"} ${path} failed (HTTP ${response.status}).`);
  return response.json();
}

async function brevoFetch(path, options = {}, credentials) {
  const response = await fetch(`${BREVO_API}${path}`, { ...options, headers: { ...apiHeaders(credentials), ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`Brevo ${options.method || "GET"} ${path} failed (HTTP ${response.status}).`);
  return response.json();
}

// Phase D: Resend contract — endpoint (not url), email.* events, status
// enabled; reconciliation checks endpoint + event set + status.
export async function reconcileResend({ appOrigin, credentials, writeSecret }) {
  if (!credentials.RESEND_SETUP_API_KEY) {
    return { status: "manual", message: "RESEND_SETUP_API_KEY absent — configure the webhook manually (docs/providers/RESEND.md)." };
  }
  const canonical = `${appOrigin}/webhooks/resend`;
  const list = await resendFetch("/webhooks", {}, credentials);
  const existing = (list.data || []).find((webhook) => webhook.endpoint === canonical);
  let webhookId = existing?.id;
  if (existing) {
    const events = Array.isArray(existing.events) ? existing.events : [];
    const exactEvents = events.length === RESEND_WEBHOOK_EVENTS.length && RESEND_WEBHOOK_EVENTS.every((event) => events.includes(event));
    if (!exactEvents || existing.status !== "enabled") {
      const updated = await resendFetch(`/webhooks/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ endpoint: canonical, events: RESEND_WEBHOOK_EVENTS, status: "enabled" }),
      }, credentials);
      webhookId = String(updated.id || existing.id || "");
    }
  } else {
    const created = await resendFetch("/webhooks", {
      method: "POST",
      body: JSON.stringify({ endpoint: canonical, events: RESEND_WEBHOOK_EVENTS }),
    }, credentials);
    webhookId = String(created.id || "");
  }
  // Phase E: the only legitimate signing secret source is the Resend API.
  // Always re-read the webhook detail and overwrite any stale/random local
  // value with provider truth.
  const detail = await resendFetch(`/webhooks/${webhookId}`, {}, credentials);
  const signingSecret = String(detail.signing_secret || "");
  if (!signingSecret) {
    return { status: "manual", message: "webhook exists but Resend returned no signing_secret; retrieve it manually." };
  }
  await writeSecret("RESEND_WEBHOOK_SECRET", signingSecret);
  return { status: "pass", message: `canonical webhook ${webhookId} reconciled with provider signing secret (never printed).` };
}

export async function reconcileBrevo({ appOrigin, credentials, writeSecret }) {
  if (!brevoManagementKey(credentials)) {
    return { status: "manual", message: "BREVO_API_KEY absent — configure the webhook manually (docs/providers/BREVO.md)." };
  }
  if (!credentials.BREVO_WEBHOOK_TOKEN) {
    throw new Error("BREVO_WEBHOOK_TOKEN is required for Brevo webhook setup (npm run configure, then provider:set brevo).");
  }
  const canonical = `${appOrigin}/webhooks/brevo`;
  const list = await brevoFetch("/webhooks", {}, credentials);
  const existing = (list.webhooks || []).find(
    (webhook) => webhook.type === "transactional" && webhook.url === canonical,
  );
  const desired = {
    url: canonical,
    events: BREVO_WEBHOOK_EVENTS,
    type: "transactional",
    batched: false,
    description: "MailGable delivery events",
    auth: { type: "bearer", token: credentials.BREVO_WEBHOOK_TOKEN },
  };
  if (existing) {
    const drifted = JSON.stringify(existing.events || []) !== JSON.stringify(BREVO_WEBHOOK_EVENTS) || existing.batched !== false;
    if (drifted) {
      await brevoFetch(`/webhooks/${existing.id}`, {
        method: "PUT",
        body: JSON.stringify({ events: BREVO_WEBHOOK_EVENTS, batched: false, auth: desired.auth }),
      }, credentials);
    }
  } else {
    await brevoFetch("/webhooks", { method: "POST", body: JSON.stringify(desired) }, credentials);
  }
  return { status: "pass", message: `canonical Brevo transactional webhook reconciled (batched=false, bearer auth).` };
}

// Phase H: every runner call is awaited. Missing await on a Promise-based
// runner is caught by the argv/await tests. The runners are the Wrangler
// runners from operator-runner.mjs; no generic spawn runner is accepted.
export async function reconcileCloudflare({ workerName, mailDomain, zoneId, runCaptureWrangler: capture = runCaptureWrangler, runInheritWrangler: inherit = runInheritWrangler }) {
  const queueName = `${workerName}-email-events`;
  const listQueues = await capture(cloudflareQueueListArgv());
  if (!listQueues.ok) throw new Error(`cannot list queues (${listQueues.stderr || "unknown"}) — no mutation performed.`);
  let owned = false;
  try {
    const queues = JSON.parse(listQueues.stdout || "[]");
    owned = Array.isArray(queues) && queues.some((queue) => queue.queue_name === queueName || queue.name === queueName);
  } catch {
    throw new Error("cannot parse the queue list output.");
  }
  if (!owned) {
    const created = await inherit(["queues", "create", queueName, "--config", GENERATED]);
    if (!created) throw new Error(`queue '${queueName}' could not be created.`);
  }
  const subscriptions = await capture(cloudflareQueueSubscriptionListArgv(queueName));
  if (!subscriptions.ok) throw new Error(`cannot list queue subscriptions (${subscriptions.stderr || "unknown"}).`);
  let subscription = null;
  try {
    const parsed = JSON.parse(subscriptions.stdout || "[]");
    const entries = Array.isArray(parsed) ? parsed : parsed.subscriptions || [];
    subscription = entries.find((entry) => isCloudflareSubscriptionOwned(entry, { mailDomain, zoneId })) || null;
  } catch {
    throw new Error("cannot parse the queue subscription list output.");
  }
  if (subscription) {
    const events = Array.isArray(subscription.events) ? subscription.events : [];
    const exact = events.length === CLOUDFLARE_QUEUE_EVENTS.length && CLOUDFLARE_QUEUE_EVENTS.every((event) => events.includes(event));
    if (!exact) {
      const subscriptionId = String(subscription.id || subscription.subscription_id || "");
      if (!subscriptionId) throw new Error("existing subscription has no id; update it manually.");
      const updated = await inherit(cloudflareQueueSubscriptionUpdateArgv(queueName, subscriptionId));
      if (!updated) throw new Error("queue subscription event drift could not be reconciled.");
    }
  } else {
    const created = await inherit(cloudflareQueueSubscriptionCreateArgv(queueName, { zoneId, mailDomain }));
    if (!created) throw new Error("queue event subscription could not be created (run it twice to confirm reuse if it was created concurrently).");
  }
  return { status: "pass", message: `queue '${queueName}' and its email.sending event subscription are reconciled.` };
}

// Phase F: EXACT endpoint scope for deletion — the full canonical URL, not
// a path suffix. Only the configured app origin is ever touched.
export async function deleteResendWebhook({ appOrigin, credentials }) {
  if (!credentials.RESEND_SETUP_API_KEY) return { status: "manual", message: "RESEND_SETUP_API_KEY absent — remove the canonical MailGable webhook manually." };
  const canonical = `${appOrigin}/webhooks/resend`;
  const list = await resendFetch("/webhooks", {}, credentials);
  const targets = (list.data || []).filter((webhook) => webhook.endpoint === canonical);
  for (const webhook of targets) {
    await resendFetch(`/webhooks/${webhook.id}`, { method: "DELETE" }, credentials);
  }
  return { status: "pass", message: `removed ${targets.length} webhook(s) with exact endpoint ${canonical}; unrelated endpoints untouched.` };
}

// Phase G: EXACT scope — transactional type + exact URL + canonical
// description. Exact duplicates under the same URL are cleaned up.
export async function deleteBrevoWebhook({ appOrigin, credentials }) {
  if (!brevoManagementKey(credentials)) return { status: "manual", message: "BREVO_API_KEY absent — remove the canonical MailGable webhook manually." };
  const canonical = `${appOrigin}/webhooks/brevo`;
  const list = await brevoFetch("/webhooks", {}, credentials);
  const targets = (list.webhooks || []).filter(
    (webhook) => webhook.type === "transactional" && webhook.url === canonical && webhook.description === "MailGable delivery events",
  );
  for (const webhook of targets) {
    await brevoFetch(`/webhooks/${webhook.id}`, { method: "DELETE" }, credentials);
  }
  return { status: "pass", message: `removed ${targets.length} canonical MailGable Brevo webhook(s) (exact URL + transactional + description); unrelated webhooks untouched.` };
}

// Phase J: EXACT source+domain+zone scope for subscription deletion. The
// runners are the Wrangler runners from operator-runner.mjs only.
export async function deleteCloudflareSubscription({ workerName, mailDomain, zoneId, runCaptureWrangler: capture = runCaptureWrangler, runInheritWrangler: inherit = runInheritWrangler }) {
  const queueName = `${workerName}-email-events`;
  const subscriptions = await capture(cloudflareQueueSubscriptionListArgv(queueName));
  if (!subscriptions.ok) return { status: "manual", message: "cannot list subscriptions; remove the MailGable event subscription manually." };
  try {
    const parsed = JSON.parse(subscriptions.stdout || "[]");
    const entries = Array.isArray(parsed) ? parsed : parsed.subscriptions || [];
    const canonical = entries.filter((entry) => isCloudflareSubscriptionOwned(entry, { mailDomain, zoneId }));
    for (const subscription of canonical) {
      const subscriptionId = String(subscription.id || subscription.subscription_id || "");
      if (!subscriptionId) continue;
      await inherit(cloudflareQueueSubscriptionDeleteArgv(queueName, subscriptionId));
    }
    return { status: "pass", message: `removed ${canonical.length} MailGable email.sending subscription(s) for exact domain ${mailDomain}; other domains untouched.` };
  } catch {
    return { status: "manual", message: "cannot parse subscriptions; remove the MailGable event subscription manually." };
  }
}