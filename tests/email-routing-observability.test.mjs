import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const inbound = await readFile("src/inbound-forwarding.ts", "utf8");
const inspector = await readFile("scripts/inspect-email-routing-activity.ps1", "utf8");
const runbook = await readFile("docs/inbound-routing-runbook.md", "utf8");
const routingUi = await readFile("public/js/routing.mjs", "utf8");

test("native forwarding keeps RFC identity and adds only X-Mailbox correlation headers", () => {
  assert.match(inbound, /message\.forward\(target, forwardAuditHeaders\(/);
  assert.match(inbound, /X-Mailbox-Archive-ID/);
  assert.match(inbound, /X-Mailbox-Original-Recipient/);
  assert.match(inbound, /X-Mailbox-Forward-Target/);
  assert.match(inbound, /X-Mailbox-Original-Message-ID/);
  assert.doesNotMatch(inbound, /headers\.set\(["']Message-ID["']/i);
  assert.doesNotMatch(inbound, /FORWARD_COPY_GAP_MS/);
  assert.doesNotMatch(inbound, /setTimeout\(/);
});

test("Worker-side accepted state is documented as submission acceptance rather than delivery proof", () => {
  assert.match(inbound, /accepted.*message\.forward\(\).*returned successfully/s);
  assert.match(inbound, /not proof.*destination MX.*delivered/s);
  assert.match(runbook, /accepted.*does \*\*not\*\* mean Hotmail or Yahoo ultimately delivered/s);
  assert.match(runbook, /Never report `8\/8 accepted` as `8\/8 delivered`/);
  assert.match(routingUi, /failed_attempts/);
  assert.match(routingUi, /verify final delivery in Cloudflare/);
});

test("routing activity inspector is read-only and exposes final delivery evidence", () => {
  assert.match(inspector, /emailRoutingAdaptive/);
  assert.match(inspector, /sessionId/);
  assert.match(inspector, /messageId/);
  assert.match(inspector, /status/);
  assert.match(inspector, /eventType/);
  assert.match(inspector, /errorDetail/);
  assert.match(inspector, /isLastEvent/);
  assert.match(inspector, /Analytics Read/);
  assert.match(inspector, /\$apiErrors = @\(\$response\.errors \| Where-Object/);
  assert.match(inspector, /if \(\$apiErrors\.Count -gt 0\)/);
  assert.match(inspector, /datetime_geq: "\$startLiteral"/);
  assert.match(inspector, /datetime_leq: "\$endLiteral"/);
  assert.doesNotMatch(inspector, /\bmutation\b/i);
  assert.doesNotMatch(inspector, /email\/routing\/rules/i);
  assert.doesNotMatch(inspector, /wrangler\s+d1\s+execute/i);
});
