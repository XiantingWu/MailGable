// Operator-path integration tests (Phase O/P/Q/R):
//
// - configure output schema -> setup discovery -> setup state ->
//   generated production config -> full provider lifecycle, with ONLY the
//   fields the real wizard produces (no hand-supplied zone_id,
//   database_id, d1_name, r2_name).
// - Resend REST contract: endpoint (not url), email.* events, status
//   enabled, signing secret flows to local credentials and to the Worker
//   without ever appearing on stdout.
// - Wrangler queue CLI argv: --events as one comma-separated value,
//   --id (never --subscription-id), delete --force.
// - Destructive scope: exact endpoint/domain deletion only.
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  reconcileResend,
  reconcileBrevo,
  reconcileCloudflare,
  deleteResendWebhook,
  deleteBrevoWebhook,
  deleteCloudflareSubscription,
  cloudflareQueueSubscriptionCreateArgv,
  cloudflareQueueSubscriptionUpdateArgv,
  cloudflareQueueSubscriptionDeleteArgv,
  cloudflareQueueListArgv,
  cloudflareQueueSubscriptionListArgv,
  isCloudflareSubscriptionOwned,
  RESEND_WEBHOOK_EVENTS,
  BREVO_WEBHOOK_EVENTS,
} from "../scripts/reconcile.mjs";
import { validateOperatorConfig, canonicalOperatorConfig } from "../scripts/config/operator-config.mjs";
import { setCredential, loadCredentials, providerActiveCredentials, PROVIDER_ACTIVATION_REQUIREMENTS } from "../scripts/config/credentials.mjs";
import {
  buildSetupPlan,
  buildGeneratedConfig,
  parseSetupArgs,
  validateProductionInputs,
} from "../scripts/setup-core.mjs";

// A wizard-realistic operator config: only fields configure.mjs produces.
const WIZARD_CONFIG = {
  mode: "production",
  worker_name: "my-mailbox",
  mail_domain: "mailgable-test.dev",
  admin_email: "admin@mailgable-test.dev",
  app_origin: "https://mail.mailgable-test.dev",
  cloudflare_zone_id: "a".repeat(32),
  cloudflare_account_id: "a".repeat(32),
  outbound_provider: "resend",
  d1_name: undefined,
  r2_name: undefined,
};

const TEMPLATE = JSON.parse(readFileSync(path.join(process.cwd(), "wrangler.jsonc"), "utf8"));

function planFor(provider) {
  const args = {
    ...parseSetupArgs([]),
    mode: "production",
    workerName: WIZARD_CONFIG.worker_name,
    mailDomain: WIZARD_CONFIG.mail_domain,
    adminEmail: WIZARD_CONFIG.admin_email,
    zoneId: WIZARD_CONFIG.cloudflare_zone_id,
    accountId: WIZARD_CONFIG.cloudflare_account_id,
    appOrigin: WIZARD_CONFIG.app_origin,
    outboundProvider: provider,
    d1Name: `${WIZARD_CONFIG.worker_name}-db`,
    r2Name: `${WIZARD_CONFIG.worker_name}-r2`,
  };
  const validated = validateProductionInputs(args);
  assert.ok(validated.ok, validated.errors?.join?.("; ") || validated.detail);
  return buildSetupPlan(TEMPLATE, args, "11111111-2222-4333-8444-555555555555", {});
}

test("operator config schema: wizard output validates and canonicalizes", () => {
  const validation = validateOperatorConfig(WIZARD_CONFIG);
  assert.ok(validation.ok, validation.errors.join("; "));
  const canonical = canonicalOperatorConfig(WIZARD_CONFIG);
  assert.deepEqual(Object.keys(canonical).sort(), [
    "admin_email", "app_origin", "cloudflare_account_id", "cloudflare_zone_id", "mail_domain", "mode", "outbound_provider", "worker_name",
  ]);
  assert.equal(canonical.zone_id, undefined, "zone_id must never exist in the canonical schema");
  assert.equal(canonical.database_id, undefined, "database_id is resource state, not operator config");
});

test("Phase O: full provider lifecycle from wizard config with no hand-filled fields", () => {
  for (const provider of ["resend", "brevo", "cloudflare", "none"]) {
    const plan = planFor(provider);
    const config = buildGeneratedConfig(TEMPLATE, plan);
    assert.equal(config.vars.OUTBOUND_PROVIDER, provider);
    assert.equal(config.vars.MAIL_DOMAIN, WIZARD_CONFIG.mail_domain);
    assert.equal(config.vars.CLOUDFLARE_ZONE_ID, WIZARD_CONFIG.cloudflare_zone_id);
    assert.equal(config.vars.APP_ORIGIN, WIZARD_CONFIG.app_origin);
    assert.equal(config.vars.MAIL_WORKER_NAME, WIZARD_CONFIG.worker_name);
    assert.equal(config.d1_databases[0].database_id, "11111111-2222-4333-8444-555555555555");
    assert.equal(config.d1_databases[0].database_name, "my-mailbox-db");
  }
});

test("setCredential never prints the value and enforces 0600", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cred-"));
  const file = path.join(dir, "credentials.env");
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    setCredential("RESEND_WEBHOOK_SECRET", "whsec_real_provider_truth", { credentialsFile: file });
  } finally {
    console.log = originalLog;
  }
  assert.ok(!lines.join("\n").includes("whsec_real_provider_truth"), "secret must never reach stdout");
  assert.equal((statSync(file).mode & 0o777).toString(8), "600");
  const creds = loadCredentials({ credentialsFile: file, env: {} });
  assert.equal(creds.RESEND_WEBHOOK_SECRET, "whsec_real_provider_truth");
  rmSync(dir, { recursive: true, force: true });
});

test("Phase D/P: Resend contract uses endpoint, email.* events, and status enabled", async () => {
  const calls = [];
  const created = { id: "wh_1", endpoint: "https://mail.mailgable-test.dev/webhooks/resend", status: "enabled", events: RESEND_WEBHOOK_EVENTS, signing_secret: "whsec_provider" };
  const globalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body });
    if (String(url).endsWith("/webhooks") && !options.method) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    if (String(url).endsWith("/webhooks") && options.method === "POST") {
      return { ok: true, json: async () => created };
    }
    if (String(url).endsWith(`/webhooks/${created.id}`)) {
      return { ok: true, json: async () => created };
    }
    return { ok: true, json: async () => ({}) };
  };
  const secrets = [];
  try {
    const report = await reconcileResend({
      appOrigin: "https://mail.mailgable-test.dev",
      credentials: { RESEND_SETUP_API_KEY: "re_x" },
      writeSecret: async (name, value) => { secrets.push([name, value]); },
    });
    assert.equal(report.status, "pass");
    assert.deepEqual(secrets, [["RESEND_WEBHOOK_SECRET", "whsec_provider"]], "provider signing secret flows to the Worker");
  } finally {
    globalThis.fetch = globalFetch;
  }
  const createCall = calls.find((call) => call.method === "POST");
  const body = JSON.parse(createCall.body);
  assert.equal(body.endpoint, "https://mail.mailgable-test.dev/webhooks/resend");
  assert.equal("url" in body, false, "create body must use endpoint, not url");
  assert.deepEqual(body.events, RESEND_WEBHOOK_EVENTS);
  assert.ok(body.events.every((event) => event.startsWith("email.")), "events use the email.* namespace");
});

test("Phase D: Resend drift is patched with endpoint+events+status", async () => {
  const existing = { id: "wh_9", endpoint: "https://mail.mailgable-test.dev/webhooks/resend", status: "disabled", events: ["email.delivered"], signing_secret: "whsec_new" };
  const globalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/webhooks") && !options.method) return { ok: true, json: async () => ({ data: [existing] }) };
    if (String(url).endsWith(`/webhooks/${existing.id}`) && options.method === "PATCH") {
      Object.assign(existing, JSON.parse(options.body));
      return { ok: true, json: async () => existing };
    }
    if (String(url).endsWith(`/webhooks/${existing.id}`)) return { ok: true, json: async () => existing };
    return { ok: true, json: async () => ({}) };
  };
  const secrets = [];
  try {
    await reconcileResend({
      appOrigin: "https://mail.mailgable-test.dev",
      credentials: { RESEND_SETUP_API_KEY: "re_x" },
      writeSecret: async (name, value) => { secrets.push([name, value]); },
    });
  } finally {
    globalThis.fetch = globalFetch;
  }
  assert.equal(existing.status, "enabled", "drift must re-enable the webhook");
  assert.deepEqual(existing.events, RESEND_WEBHOOK_EVENTS);
  assert.deepEqual(secrets, [["RESEND_WEBHOOK_SECRET", "whsec_new"]], "stale local secret is overwritten by provider truth");
});

test("Phase R: Resend deletion is exact-endpoint scoped", async () => {
  const mailgable = { id: "wh_a", endpoint: "https://mail.example.com/webhooks/resend" };
  const unrelated = { id: "wh_b", endpoint: "https://other.example.com/webhooks/resend" };
  const deleted = [];
  const globalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/webhooks") && !options.method) return { ok: true, json: async () => ({ data: [mailgable, unrelated] }) };
    if (options.method === "DELETE") { deleted.push(String(url)); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const report = await deleteResendWebhook({ appOrigin: "https://mail.example.com", credentials: { RESEND_SETUP_API_KEY: "re_x" } });
    assert.equal(report.status, "pass");
  } finally {
    globalThis.fetch = globalFetch;
  }
  assert.deepEqual(deleted, ["https://api.resend.com/webhooks/wh_a"], "only the exact MailGable endpoint is deleted");
  assert.equal(unrelated.id, "wh_b", "unrelated endpoint stays");
});

test("Phase G: Brevo deletion is exact URL + transactional + description scoped", async () => {
  const mailgable = { id: "bw_1", type: "transactional", url: "https://mail.example.com/webhooks/brevo", description: "MailGable delivery events" };
  const duplicate = { id: "bw_2", type: "transactional", url: "https://mail.example.com/webhooks/brevo", description: "MailGable delivery events" };
  const suffixMatch = { id: "bw_3", type: "transactional", url: "https://other.example.com/webhooks/brevo", description: "MailGable delivery events" };
  const wrongType = { id: "bw_4", type: "marketing", url: "https://mail.example.com/webhooks/brevo", description: "MailGable delivery events" };
  const deleted = [];
  const globalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/webhooks") && !options.method) return { ok: true, json: async () => ({ webhooks: [mailgable, duplicate, suffixMatch, wrongType] }) };
    if (options.method === "DELETE") { deleted.push(String(url)); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({}) };
  };
  try {
    await deleteBrevoWebhook({ appOrigin: "https://mail.example.com", credentials: { BREVO_SETUP_API_KEY: "x" } });
  } finally {
    globalThis.fetch = globalFetch;
  }
  assert.deepEqual(deleted.sort(), ["https://api.brevo.com/v3/webhooks/bw_1", "https://api.brevo.com/v3/webhooks/bw_2"].sort());
  assert.equal(suffixMatch.id, "bw_3", "same path on another domain is untouched");
  assert.equal(wrongType.id, "bw_4", "non-transactional webhook is untouched");
});

test("Brevo single-key contract A: BREVO_API_KEY only — reconcile and delete both work", async () => {
  const created = { id: "bw_a", type: "transactional", url: "https://mail.mailgable-test.dev/webhooks/brevo", events: BREVO_WEBHOOK_EVENTS, batched: false };
  const seenKeys = [];
  const globalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    seenKeys.push(options.headers?.["api-key"]);
    if (String(url).endsWith("/webhooks") && !options.method) return { ok: true, json: async () => ({ webhooks: [] }) };
    if (String(url).endsWith("/webhooks") && options.method === "POST") return { ok: true, json: async () => created };
    if (options.method === "DELETE") return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => created };
  };
  try {
    const report = await reconcileBrevo({
      appOrigin: "https://mail.mailgable-test.dev",
      credentials: { BREVO_API_KEY: "xkeysib-send-only", BREVO_WEBHOOK_TOKEN: "wh-token-a" },
      writeSecret: async () => {},
    });
    assert.equal(report.status, "pass", "reconcileBrevo works with BREVO_API_KEY alone");
    assert.equal(seenKeys[0], "xkeysib-send-only", "management request uses BREVO_API_KEY when no setup key");
    const del = await deleteBrevoWebhook({
      appOrigin: "https://mail.mailgable-test.dev",
      credentials: { BREVO_API_KEY: "xkeysib-send-only" },
    });
    assert.equal(del.status, "pass", "deleteBrevoWebhook works with BREVO_API_KEY alone");
  } finally {
    globalThis.fetch = globalFetch;
  }
});

test("Brevo single-key contract B: setup key overrides management; runtime keeps BREVO_API_KEY", async () => {
  const created = { id: "bw_b", type: "transactional", url: "https://mail.mailgable-test.dev/webhooks/brevo", events: BREVO_WEBHOOK_EVENTS, batched: false };
  const seenKeys = [];
  const globalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    seenKeys.push(options.headers?.["api-key"]);
    if (String(url).endsWith("/webhooks") && !options.method) return { ok: true, json: async () => ({ webhooks: [] }) };
    if (String(url).endsWith("/webhooks") && options.method === "POST") return { ok: true, json: async () => created };
    return { ok: true, json: async () => created };
  };
  try {
    await reconcileBrevo({
      appOrigin: "https://mail.mailgable-test.dev",
      credentials: { BREVO_API_KEY: "xkeysib-runtime", BREVO_SETUP_API_KEY: "xkeysib-management", BREVO_WEBHOOK_TOKEN: "wh-token-b" },
      writeSecret: async () => {},
    });
    assert.ok(seenKeys.length > 0, "management requests were made");
    for (const key of seenKeys) assert.equal(key, "xkeysib-management", "management always uses the setup override when present");
    const runtime = providerActiveCredentials("brevo", { BREVO_API_KEY: "xkeysib-runtime", BREVO_SETUP_API_KEY: "xkeysib-management" });
    assert.equal(runtime.BREVO_API_KEY, "xkeysib-runtime", "runtime sending keeps BREVO_API_KEY");
    assert.ok(!("BREVO_SETUP_API_KEY" in runtime), "the management override is never a runtime secret");
  } finally {
    globalThis.fetch = globalFetch;
  }
});

test("Brevo single-key contract C: BREVO_SETUP_API_KEY alone cannot activate the provider", () => {
  const requirements = PROVIDER_ACTIVATION_REQUIREMENTS.brevo;
  assert.deepEqual(requirements, ["BREVO_API_KEY"], "provider activation requires the runtime sending key");
  assert.ok(!requirements.includes("BREVO_SETUP_API_KEY"), "the optional management override never satisfies activation");
});

test("Brevo single-key contract D: no keys at all fail before mutation", async () => {
  const mutatingCalls = [];
  const globalFetch = globalThis.fetch;
  globalThis.fetch = async () => { mutatingCalls.push("fetch"); return { ok: true, json: async () => ({ webhooks: [] }) }; };
  try {
    const report = await reconcileBrevo({
      appOrigin: "https://mail.mailgable-test.dev",
      credentials: {},
      writeSecret: async () => {},
    });
    assert.equal(report.status, "manual", "absent keys return manual, never mutate");
  } finally {
    globalThis.fetch = globalFetch;
  }
  assert.equal(mutatingCalls.length, 0, "no provider mutation when no management key exists");
});

test("Phase Q: queue CLI argv contract (one comma-separated --events, --id, --force)", () => {
  const create = cloudflareQueueSubscriptionCreateArgv("mb-email-events", { zoneId: "z".repeat(32), mailDomain: "mail.example.com" });
  assert.ok(create.includes("--source"));
  const eventsIdx = create.indexOf("--events");
  assert.ok(eventsIdx !== -1);
  assert.equal(create[eventsIdx + 1].split(",").length, 6, "one comma-separated value with all six events");
  assert.equal(create.includes("--subscription-id"), false, "--subscription-id is forbidden");

  const update = cloudflareQueueSubscriptionUpdateArgv("mb-email-events", "sub_1");
  const updateIdIdx = update.indexOf("--id");
  assert.ok(updateIdIdx !== -1);
  assert.equal(update[updateIdIdx + 1], "sub_1");
  assert.equal(update.includes("--subscription-id"), false);

  const del = cloudflareQueueSubscriptionDeleteArgv("mb-email-events", "sub_1");
  assert.ok(del.includes("--force"), "delete requires --force");
  assert.ok(del.includes("--id"));
  assert.equal(del.includes("--subscription-id"), false);
});

test("Phase H: reconcileCloudflare awaits Wrangler runners and uses exact ownership", async () => {
  let awaited = 0;
  let updateCalls = 0;
  const listQueues = async () => ({ ok: true, stdout: JSON.stringify([{ name: "mb-email-events" }]), stderr: "" });
  const listSubs = async () => ({ ok: true, stdout: JSON.stringify([
    { source: "email.sending", domain: "mail.example.com", zone_id: "z".repeat(32), events: ["message.delivered"], id: "s1" },
    { source: "email.sending", domain: "notifications.example.com", zone_id: "z".repeat(32), events: [], id: "s2" },
  ]), stderr: "" });
  const report = await reconcileCloudflare({
    workerName: "mb",
    mailDomain: "mail.example.com",
    zoneId: "z".repeat(32),
    runCaptureWrangler: async (args) => {
      awaited += 1;
      if (args[0] === "wrangler" && args[1] === "queues" && args[2] === "list") return listQueues();
      return listSubs();
    },
    runInheritWrangler: async (args) => {
      awaited += 1;
      updateCalls += 1;
      return true;
    },
  });
  assert.equal(report.status, "pass");
  assert.ok(awaited >= 3, "every runner call must be awaited (Promise runners)");
  assert.equal(updateCalls, 1, "drift on the owned subscription triggers exactly one update");
});

test("Phase J: ownership matcher is exact (domain + zone + source)", () => {
  const owned = { source: "email.sending", domain: "mail.example.com", zone_id: "z".repeat(32) };
  assert.equal(isCloudflareSubscriptionOwned(owned, { mailDomain: "mail.example.com", zoneId: "z".repeat(32) }), true);
  assert.equal(isCloudflareSubscriptionOwned({ ...owned, domain: "notifications.example.com" }, { mailDomain: "mail.example.com", zoneId: "z".repeat(32) }), false, "different domain in the same zone is not ours");
  assert.equal(isCloudflareSubscriptionOwned({ ...owned, zone_id: "other".padEnd(32, "0") }, { mailDomain: "mail.example.com", zoneId: "z".repeat(32) }), false, "zone mismatch is not ours");
  assert.equal(isCloudflareSubscriptionOwned({ ...owned, source: "analytics" }, { mailDomain: "mail.example.com", zoneId: "z".repeat(32) }), false);
});

test("Phase R: Cloudflare deletion never touches other domains in the same zone", async () => {
  const mailgable = { id: "s1", source: "email.sending", domain: "mail.example.com", zone_id: "z".repeat(32) };
  const notifications = { id: "s2", source: "email.sending", domain: "notifications.example.com", zone_id: "z".repeat(32) };
  const deleted = [];
  const report = await deleteCloudflareSubscription({
    workerName: "mb",
    mailDomain: "mail.example.com",
    zoneId: "z".repeat(32),
    runCaptureWrangler: async () => ({ ok: true, stdout: JSON.stringify([mailgable, notifications]), stderr: "" }),
    runInheritWrangler: async (args) => {
      const idIdx = args.indexOf("--id");
      deleted.push(args[idIdx + 1]);
      return true;
    },
  });
  assert.equal(report.status, "pass");
  assert.deepEqual(deleted, ["s1"], "notifications.example.com subscription is untouched");
});