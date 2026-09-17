import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGeneratedConfig,
  buildSecretPlan,
  buildSetupPlan,
  classifyD1State,
  classifyR2State,
  configInvariants,
  isKnownMailboxSchema,
  parseSetupArgs,
  strictOrigin,
  validateProductionInputs,
} from "../scripts/setup-core.mjs";

const TEMPLATE = {
  name: "mailgable-dev",
  workers_dev: true,
  preview_urls: false,
  d1_databases: [{ binding: "DB", database_name: "mailgable-db", database_id: "x", migrations_dir: "migrations" }],
  r2_buckets: [{ binding: "MAIL_R2", bucket_name: "mailgable-r2" }],
  vars: { MAIL_WORKER_NAME: "mailgable-dev" },
};

const VALID_INPUTS = {
  appOrigin: "https://mail.mailgable-test.dev",
  mailDomain: "mailgable-test.dev",
  adminEmail: "admin@mailgable-test.dev",
  zoneId: "a".repeat(32),
  accountId: "a".repeat(32),
  workerName: "mailbox-test",
  d1Name: "mailbox-test-db",
  r2Name: "mailbox-test-r2",
};

test("strictOrigin rejects non-canonical origins", () => {
  assert.equal(strictOrigin("https://mail.example.test").ok, true);
  assert.equal(strictOrigin("http://mail.example.test").ok, false);
  assert.equal(strictOrigin("https://user@mail.example.test").ok, false);
  assert.equal(strictOrigin("https://mail.example.test/extra").ok, false);
  assert.equal(strictOrigin("https://mail.example.test/?q=1").ok, false);
  assert.equal(strictOrigin("https://mail.example.test/#frag").ok, false);
  assert.equal(strictOrigin("not a url").ok, false);
  assert.equal(strictOrigin("").ok, false);
});

test("validateProductionInputs rejects placeholders and bad values with zero-mutation semantics", () => {
  assert.equal(validateProductionInputs(VALID_INPUTS).ok, true);
  assert.equal(validateProductionInputs({ ...VALID_INPUTS, appOrigin: "https://example.com" }).ok, true, "app origin host may be any https host");
  const cases = [
    [{ ...VALID_INPUTS, mailDomain: "example.com" }, "placeholder_mail_domain"],
    [{ ...VALID_INPUTS, mailDomain: "example.org" }, "placeholder_mail_domain"],
    [{ ...VALID_INPUTS, mailDomain: "example.test" }, "placeholder_mail_domain"],
    [{ ...VALID_INPUTS, adminEmail: "admin@example.com" }, "placeholder_admin_email"],
    [{ ...VALID_INPUTS, adminEmail: "not-an-email" }, "invalid_admin_email"],
    [{ ...VALID_INPUTS, zoneId: "00000000000000000000000000000000" }, "invalid_zone_id"],
    [{ ...VALID_INPUTS, zoneId: "zz".repeat(16) }, "invalid_zone_id"],
    [{ ...VALID_INPUTS, zoneId: "" }, "invalid_zone_id"],
    [{ ...VALID_INPUTS, accountId: "00000000000000000000000000000000" }, "invalid_account_id"],
    [{ ...VALID_INPUTS, accountId: "zz".repeat(16) }, "invalid_account_id"],
    [{ ...VALID_INPUTS, accountId: "g".repeat(32) }, "invalid_account_id"],
    [{ ...VALID_INPUTS, accountId: "abc" }, "invalid_account_id"],
    [{ ...VALID_INPUTS, accountId: "" }, "invalid_account_id"],
    [{ ...VALID_INPUTS, accountId: undefined }, "invalid_account_id"],
    [{ ...VALID_INPUTS, workerName: "mailgable-dev" }, "invalid_worker_name"],
    [{ ...VALID_INPUTS, workerName: "" }, "invalid_worker_name"],
    [{ ...VALID_INPUTS, appOrigin: "" }, "origin_invalid"],
  ];
  for (const [inputs, code] of cases) {
    const result = validateProductionInputs(inputs);
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code, `expected ${code}, got ${result.code}`);
  }
});

test("account id contract: exactly 32 hex, not all zero, required in production only", () => {
  assert.equal(validateProductionInputs({ ...VALID_INPUTS, accountId: "0123456789abcdef0123456789abcdef" }).ok, true, "lowercase hex is valid");
  assert.equal(validateProductionInputs({ ...VALID_INPUTS, accountId: "0123456789ABCDEF0123456789ABCDEF" }).ok, true, "uppercase hex is valid");
  assert.equal(validateProductionInputs({ ...VALID_INPUTS, accountId: "0123456789abcdef0123456789abcde" }).ok, false, "31 hex is malformed");
  assert.equal(validateProductionInputs({ ...VALID_INPUTS, accountId: "0123456789abcdef0123456789abcdef0" }).ok, false, "33 hex is malformed");
  assert.equal(validateProductionInputs({ ...VALID_INPUTS, accountId: "0".repeat(32) }).ok, false, "all-zero account id is rejected");
  assert.equal(validateProductionInputs({ ...VALID_INPUTS, accountId: "x".repeat(32) }).ok, false, "non-hex account id is rejected");

  const devArgs = { ...parseSetupArgs([]), mode: "dev", outboundProvider: "none" };
  const devPlan = buildSetupPlan(TEMPLATE, devArgs, "db-id", {});
  assert.equal(devPlan.accountId, "", "dev mode never requires a Cloudflare account id");
  const devConfig = buildGeneratedConfig(TEMPLATE, devPlan);
  assert.deepEqual(configInvariants(devConfig), []);
});

test("generated production config enforces invariants and the custom-domain route", () => {
  const args = { ...parseSetupArgs([]), ...VALID_INPUTS, mode: "production" };
  const plan = buildSetupPlan({ ...TEMPLATE }, { ...args, outboundProvider: "none" }, "db-id", {});
  const config = buildGeneratedConfig(TEMPLATE, plan);
  assert.deepEqual(configInvariants(config), []);
  assert.equal(config.name, "mailbox-test");
  assert.equal(config.vars.MAIL_WORKER_NAME, "mailbox-test");
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.routes, [{ pattern: "mail.mailgable-test.dev", custom_domain: true }]);
  assert.equal(config.vars.APP_ORIGIN, "https://mail.mailgable-test.dev");
  assert.equal(config.d1_databases[0].database_name, "mailbox-test-db");
  assert.equal(config.r2_buckets[0].bucket_name, "mailbox-test-r2");
});

test("dev config never carries production routes and keeps workers.dev on", () => {
  const args = { ...parseSetupArgs([]), mode: "dev" };
  const plan = buildSetupPlan({ ...TEMPLATE }, { ...args, outboundProvider: "none" }, "db-id", {});
  const config = buildGeneratedConfig(TEMPLATE, plan);
  assert.deepEqual(configInvariants(config), []);
  assert.equal(config.workers_dev, true);
  assert.equal(config.routes, undefined);
});

test("resource discovery classifies auth errors separately from missing", () => {
  assert.deepEqual(classifyD1State([], "mailgable-db"), { kind: "missing" });
  assert.deepEqual(classifyD1State([{ name: "mailgable-db", uuid: "u1" }], "mailgable-db"), { kind: "present", id: "u1" });
  assert.deepEqual(classifyD1State(null, "mailgable-db"), { kind: "list_error", code: "d1_list_error" });
  assert.deepEqual(classifyR2State([{ name: "mailgable-r2" }], "mailgable-r2"), { kind: "present" });
  assert.deepEqual(classifyR2State([], "mailgable-r2"), { kind: "missing" });
  assert.deepEqual(classifyR2State("garbage", "mailgable-r2"), { kind: "list_error", code: "r2_list_error" });
});

test("D1 ownership: unknown tables block adoption", () => {
  assert.deepEqual(isKnownMailboxSchema([]), { ok: true, empty: true });
  assert.equal(isKnownMailboxSchema([{ name: "mailboxes" }, { name: "mail_messages" }]).ok, true);
  assert.equal(isKnownMailboxSchema([{ name: "secret_customer_data" }]).ok, false);
  assert.deepEqual(isKnownMailboxSchema([{ name: "mailboxes" }, { name: "other_thing" }]).unknown, ["other_thing"]);
});

test("secret plan classifies required vs optional", () => {
  const plan = buildSecretPlan({ AUTH_PEPPER: "x", ADMIN_BOOTSTRAP_TOKEN: "y" });
  assert.equal(plan.requiredPresent, true);
  assert.equal(plan.resend_api_key, false);
  assert.equal(plan.cloudflare_routing_read_token, false);
  assert.equal(buildSecretPlan({}).requiredPresent, false);
});

test("worker and MAIL_WORKER_NAME must match or invariants fail", () => {
  const args = { ...parseSetupArgs([]), ...VALID_INPUTS, mode: "production" };
  const plan = buildSetupPlan({ ...TEMPLATE }, { ...args, outboundProvider: "none" }, "db-id", {});
  const config = buildGeneratedConfig(TEMPLATE, plan);
  config.vars.MAIL_WORKER_NAME = "different";
  assert.deepEqual(configInvariants(config), ["name must equal MAIL_WORKER_NAME"]);
});

test("production generated config preserves every validated operator variable (P0)", () => {
  const args = { ...parseSetupArgs([]), ...VALID_INPUTS, mode: "production", outboundProvider: "brevo" };
  const plan = buildSetupPlan(TEMPLATE, args, "db-id", {});
  const config = buildGeneratedConfig(TEMPLATE, plan);
  assert.equal(config.vars.MAIL_DOMAIN, "mailgable-test.dev");
  assert.equal(config.vars.ADMIN_EMAIL, "admin@mailgable-test.dev");
  assert.equal(config.vars.CLOUDFLARE_ZONE_ID, "a".repeat(32));
  assert.equal(config.vars.APP_ORIGIN, "https://mail.mailgable-test.dev");
  assert.equal(config.vars.MAIL_WORKER_NAME, "mailbox-test");
  assert.equal(config.vars.OUTBOUND_PROVIDER, "brevo");
  assert.equal(config.name, "mailbox-test");
  for (const value of [config.vars.MAIL_DOMAIN, config.vars.ADMIN_EMAIL, config.vars.CLOUDFLARE_ZONE_ID]) {
    assert.notEqual(value, "", "no empty production vars");
  }
  assert.notEqual(config.vars.CLOUDFLARE_ZONE_ID, "00000000000000000000000000000000", "no placeholder zone id");
});

test("cloudflare mode adds the EMAIL binding and queue consumer; other modes never carry them", () => {
  const args = { ...parseSetupArgs([]), ...VALID_INPUTS, mode: "production", outboundProvider: "cloudflare" };
  const plan = buildSetupPlan(TEMPLATE, args, "db-id", {});
  const config = buildGeneratedConfig(TEMPLATE, plan);
  assert.deepEqual(config.send_email, [{ name: "EMAIL" }]);
  assert.ok(config.queues?.consumers?.some((c) => c.queue === "mailbox-test-email-events"));
  assert.equal(config.queues.producers, undefined, "no producer binding is needed (Event Subscription produces)");
  assert.equal(config.vars.OUTBOUND_PROVIDER, "cloudflare");

  const brevoArgs = { ...parseSetupArgs([]), ...VALID_INPUTS, mode: "production", outboundProvider: "brevo" };
  const brevoPlan = buildSetupPlan(TEMPLATE, brevoArgs, "db-id", {});
  const brevoConfig = buildGeneratedConfig(TEMPLATE, brevoPlan);
  assert.equal(brevoConfig.send_email, undefined);
  assert.equal(brevoConfig.queues, undefined);
});

test("provider switch sequence rebuilds the deployment config completely", () => {
  const base = { ...parseSetupArgs([]), ...VALID_INPUTS, mode: "production" };

  const resend = buildGeneratedConfig(TEMPLATE, buildSetupPlan(TEMPLATE, { ...base, outboundProvider: "resend" }, "db-id", {}));
  assert.equal(resend.vars.OUTBOUND_PROVIDER, "resend");
  assert.equal(resend.send_email, undefined);
  assert.equal(resend.queues, undefined);

  const brevo = buildGeneratedConfig(TEMPLATE, buildSetupPlan(TEMPLATE, { ...base, outboundProvider: "brevo" }, "db-id", {}));
  assert.equal(brevo.vars.OUTBOUND_PROVIDER, "brevo");
  assert.equal(brevo.send_email, undefined, "no Cloudflare binding after switching to Brevo");
  assert.equal(brevo.queues, undefined);

  const cf = buildGeneratedConfig(TEMPLATE, buildSetupPlan(TEMPLATE, { ...base, outboundProvider: "cloudflare" }, "db-id", {}));
  assert.equal(cf.vars.OUTBOUND_PROVIDER, "cloudflare");
  assert.deepEqual(cf.send_email, [{ name: "EMAIL" }]);
  assert.ok(cf.queues.consumers.some((c) => c.queue === "mailbox-test-email-events"));
  assert.equal(cf.queues.producers, undefined);
  assert.equal(brevo.vars.MAIL_DOMAIN, cf.vars.MAIL_DOMAIN, "runtime vars survive switching");
});

test("provider-aware secrets.required follows the hard-required matrix (Phase 24-25)", () => {
  const base = { ...parseSetupArgs([]), ...VALID_INPUTS, mode: "production" };
  const none = buildGeneratedConfig(TEMPLATE, buildSetupPlan(TEMPLATE, { ...base, outboundProvider: "none" }, "db-id", {}));
  assert.deepEqual(none.secrets.required, ["AUTH_PEPPER"]);
  const resend = buildGeneratedConfig(TEMPLATE, buildSetupPlan(TEMPLATE, { ...base, outboundProvider: "resend" }, "db-id", {}));
  assert.deepEqual(resend.secrets.required, ["AUTH_PEPPER", "RESEND_API_KEY"]);
  const brevo = buildGeneratedConfig(TEMPLATE, buildSetupPlan(TEMPLATE, { ...base, outboundProvider: "brevo" }, "db-id", {}));
  assert.deepEqual(brevo.secrets.required, ["AUTH_PEPPER", "BREVO_API_KEY"]);
  const cf = buildGeneratedConfig(TEMPLATE, buildSetupPlan(TEMPLATE, { ...base, outboundProvider: "cloudflare" }, "db-id", {}));
  assert.deepEqual(cf.secrets.required, ["AUTH_PEPPER"]);
  for (const config of [none, resend, brevo, cf]) {
    assert.ok(!config.secrets.required.includes("ADMIN_BOOTSTRAP_TOKEN"), "transient bootstrap token never required");
    assert.ok(!config.secrets.required.includes("CLOUDFLARE_API_TOKEN"), "setup-only token never required");
    assert.ok(!config.secrets.required.includes("RESEND_SETUP_API_KEY"), "setup-only key never required");
    assert.ok(!config.secrets.required.includes("BREVO_SETUP_API_KEY"), "setup-only key never required");
    assert.ok(!config.secrets.required.includes("CLOUDFLARE_ROUTING_READ_TOKEN"), "routing token is optional, never deploy-blocking");
    assert.ok(!config.secrets.required.includes("RESEND_WEBHOOK_SECRET"), "delivery-event capability, never deploy-blocking");
    assert.ok(!config.secrets.required.includes("BREVO_WEBHOOK_TOKEN"), "delivery-event capability, never deploy-blocking");
  }
});

test("first-run paradox: resend setup without webhook secret still deploys (Phase 31)", () => {
  const base = { ...parseSetupArgs([]), ...VALID_INPUTS, mode: "production", outboundProvider: "resend" };
  const config = buildGeneratedConfig(TEMPLATE, buildSetupPlan(TEMPLATE, base, "db-id", {}));
  assert.ok(!config.secrets.required.includes("RESEND_WEBHOOK_SECRET"), "first Worker deploy must not require the signing secret");
});
