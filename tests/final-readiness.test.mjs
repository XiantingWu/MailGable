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

test("duplicate inbound deliveries use delivery-unique raw object keys", () => {
  assert.match(mail, /original-\$\{randomToken\(12\)\}\.eml/);
  assert.doesNotMatch(mail, /objectPath\("incoming", mailboxId, messageId, "original\.eml"\)/);
});

test("outgoing raw archives roll back when D1 metadata fails", () => {
  assert.match(mail, /const rawKey = objectPath\("outgoing"[\s\S]*randomToken\(12\)/);
  assert.match(mail, /catch \(error\) \{\s*await env\.MAIL_R2\.delete\(rawKey\)\.catch/);
});

test("successful provider responses without confirmation remain safely retryable", () => {
  assert.match(mail, /response\.ok && !result\.id/);
  assert.match(mail, /resend_success_without_confirmed_id/);
  assert.match(mail, /provider_outcome_unknown/);
});

test("browser offers safe retry only for complete archives", () => {
  assert.match(ui, /message\.archive_status === "archived"/);
  assert.match(ui, /\["sending", "retryable_failed"\]\.includes\(message\.status\)/);
});

test("read-only preflight inventories all legacy control planes", () => {
  for (const marker of ["workers/scripts", "workers/routes", "d1 list", "r2/buckets", "email/routing/rules", "api.resend.com/webhooks", "production_api_offline"]) {
    assert.match(preflight, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(preflight, /ValidateSet\("before-stage","after-stage","after-cutover"\)/);
  assert.match(preflight, /ready=\(\$blockingFailures\.Count -eq 0\)/);
});

test("legacy reconciliation never deletes D1 or R2", () => {
  assert.match(reconcile, /never deletes D1 databases or R2 buckets/);
  assert.match(reconcile, /RemoveLegacyRoutes/);
  assert.match(reconcile, /RemoveLegacyWorkers/);
  assert.match(reconcile, /RemoveLegacyResendWebhooks/);
  assert.doesNotMatch(reconcile, /d1 delete|r2 bucket delete/i);
});

test("Single Redirect hardening restricts navigation to GET and HEAD", () => {
  assert.match(harden, /http\.request\.method eq `"GET`"/);
  assert.match(harden, /http\.request\.method eq `"HEAD`"/);
  assert.match(harden, /starts_with\(http\.request\.uri\.path/);
});
