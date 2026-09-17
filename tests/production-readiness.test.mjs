import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

async function joinedDir(dir, ext) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(ext)).sort();
  return (await Promise.all(names.map((name) => readFile(`${dir}/${name}`, "utf8")))).join("\n");
}

const providers = await joinedDir("src/providers", ".ts");
const mail = (await joinedDir("src/mail", ".ts")) + "\n" + providers;
const ui = await joinedDir("public/js", ".mjs");
const preflight = await readFile("scripts/preflight-production.ps1", "utf8");
const reconcile = await readFile("scripts/reconcile-legacy-resources.ps1", "utf8");
const harden = await readFile("scripts/harden-admin-mail-redirect.ps1", "utf8");
const wranglerConfig = await readFile("wrangler.jsonc", "utf8");
const deliveryEvents = await readFile("src/mail/delivery-events.ts", "utf8");
const resendProvider = await readFile("src/providers/resend.ts", "utf8");
const migration = await readFile("migrations/0004_ops_probe.sql", "utf8");

test("concurrent duplicate inbound deliveries cannot delete the winning raw object", () => {
  assert.match(mail, /export function incomingRawObjectName/);
  assert.match(mail, /original-\$\{randomToken\(12\)\}\.eml/);
  assert.match(mail, /INSERT OR IGNORE INTO mail_messages/);
  assert.match(mail, /archive_status[\s\S]*"pending"/);
  assert.match(mail, /archive_status='archived'/);
  assert.doesNotMatch(mail, /objectPath\("incoming", mailboxId, messageId, "original\.eml"\)/);
});

test("outgoing raw archives roll back on D1 update failure", () => {
  assert.match(mail, /const rawKey = objectPath\("outgoing"[\s\S]*original-\$\{randomToken\(12\)\}\.eml/);
  assert.match(mail, /catch \(error\) \{\s*await env\.MAIL_R2\.delete\(rawKey\)\.catch/);
});

test("provider 2xx without a confirmation id remains safely retryable", () => {
  assert.match(mail, /if \(response\.ok && !result\.id\)/);
  assert.match(mail, /resend_success_without_confirmed_id/);
  assert.match(mail, /provider_outcome_unknown/);
});

test("the browser only offers safe retry when the archive is complete", () => {
  assert.match(ui, /message\.archive_status === "archived"/);
  assert.match(ui, /\["sending", "retryable_failed"\]\.includes\(message\.status\)/);
});

test("production preflight phases do not deadlock legacy reconciliation", () => {
  assert.match(preflight, /ValidateSet\("before-stage","after-stage","after-cutover"\)/);
  assert.match(preflight, /\$cutover = \$Phase -eq "after-cutover"/);
  assert.match(preflight, /legacy_workers_absent/);
  assert.match(preflight, /main_mail_worker_routes_absent/);
  assert.match(preflight, /production_api_offline/);
  assert.match(preflight, /main_redirect_post_blocked/);
  assert.match(preflight, /schema_version=2/);
  assert.match(preflight, /Get-AllR2Buckets/);
});

test("legacy cleanup is explicit, previewable, and never deletes D1 or R2", () => {
  assert.match(reconcile, /SupportsShouldProcess=\$true/);
  assert.match(reconcile, /never deletes D1 databases or R2 buckets/i);
  assert.match(reconcile, /if \(\$WhatIfPreference\)/);
  assert.match(reconcile, /No changes were made because -WhatIf was supplied/);
  assert.match(reconcile, /Canonical Worker health check failed/);
  assert.match(reconcile, /unexpectedLegacyRoutes/);
  assert.doesNotMatch(reconcile, /d1 delete|r2 bucket delete/i);
});

test("D1 and R2 readiness probe has an isolated migration", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS mail_ops_probes/);
  assert.match(mail, /database_read_write_delete: true/);
  assert.match(mail, /archive_read_write_delete: true/);
  assert.match(mail, /INSERT INTO mail_ops_probes/);
  assert.match(mail, /DELETE FROM mail_ops_probes/);
});

test("the main redirect can be restricted to GET and HEAD", () => {
  assert.match(harden, /http\.request\.method eq `"GET`"/);
  assert.match(harden, /http\.request\.method eq `"HEAD`"/);
  assert.match(harden, /starts_with\(http\.request\.uri\.path/);
});

test("production operations scripts are documented in scripts/README.md", async () => {
  const scriptsReadme = await readFile("scripts/README.md", "utf8");
  for (const name of [
    "preflight-production.ps1",
    "reconcile-legacy-resources.ps1",
    "harden-admin-mail-redirect.ps1",
    "setup.mjs",
    "db-remote.mjs",
    "live-validation.mjs",
  ]) assert.match(scriptsReadme, new RegExp(name.replaceAll(".", "\\.")));
});

test("observability keeps application logs PII-minimal and webhooks store minimal PII", () => {
  assert.match(wranglerConfig, /"head_sampling_rate": 1/);
  assert.doesNotMatch(deliveryEvents, /payload_json.*raw/s);
  assert.match(deliveryEvents, /normalizeResendEvent\(payload, svixId\)/);
  assert.match(resendProvider, /tags: \[{ name: "message_id", value: String\(row\.message_id\) }\]/);
  assert.doesNotMatch(resendProvider, /name: "mailbox_id"/);
});
