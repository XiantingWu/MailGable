import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readyCss = await readFile("public/mail-ready.css", "utf8");
const routingCss = await readFile("public/routing-status.css", "utf8");
const routingUi = await readFile("public/js/routing.mjs", "utf8");
const html = await readFile("public/index.html", "utf8");
const worker = await readFile("src/index.ts", "utf8");
const mailFive = await readFile("src/mail/status.ts", "utf8");
const uiOne = await readFile("public/js/compose.mjs", "utf8");
const uiThree = await readFile("public/js/compose.mjs", "utf8");
const mailboxJs = await readFile("public/js/mailbox.mjs", "utf8");
const composeJs = await readFile("public/js/compose.mjs", "utf8");
const sync = await readFile("scripts/sync-routing-mailboxes.ps1", "utf8");
const deploy = await readFile("scripts/deploy-production.ps1", "utf8");
const launcher = await readFile("scripts/run-production-with-dev-vars.ps1", "utf8");
const migration = await readFile("migrations/0006_routing_managed_mailboxes.sql", "utf8");
const migrationVerifier = await readFile("scripts/verify-migration.mjs", "utf8");

test("hidden state always wins over component display rules", () => {
  assert.match(readyCss, /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*\}/i);
});

test("compose UI exposes an explicit no-sender state", () => {
  assert.match(uiOne, /t\("noSenders"\)/);
  assert.match(uiThree, /state\.mailboxes\.filter\(\(item\) => Number\(item\.can_send\) === 1 && Number\(item\.active\) === 1\)/);
  assert.match(uiThree, /new Option\(t\("noSenders"\), ""\)/);
  assert.match(uiThree, /\$\("compose-button"\)\.disabled = true/);
  assert.match(composeJs, /renderSendAvailability\(\);/);
});

test("routing sync imports every enabled literal domain address as a sender and only canonical Worker routes as receivers", () => {
  assert.match(sync, /if \(-not \[bool\]\$rule\.enabled\) \{ continue \}/);
  assert.match(sync, /\$matchers\.Count -ne 1/);
  assert.match(sync, /\$matcher\.type -ne "literal" -or \$matcher\.field -ne "to"/);
  assert.match(sync, /\$address -notmatch "\^\[\^@\\s\]\+@\$domainPattern\$"/);
  assert.match(sync, /function Get-SendableAddresses/);
  assert.match(sync, /\$actions\.Count -ne 1 -or \$actions\[0\]\.type -ne "worker"/);
  assert.match(sync, /\$targets\.Count -ne 1 -or \$targets\[0\] -ne \$WorkerName/);
  assert.match(sync, /\$null = \$addresses\.Add\(\(\[string\]\$address\)\.Trim\(\)\.ToLowerInvariant\(\)\)/);
  assert.doesNotMatch(sync, /@\("support", "contact", "privacy"\)/);
  const canonicalAfter = sync.indexOf("$targets[0] -ne $WorkerName");
  const sendableAfter = sync.indexOf("function Get-SendableAddresses");
  assert.ok(canonicalAfter < sendableAfter, "canonical Worker receive filter must stay separate from sender collection");
});

test("routing sync preserves history and deactivates only routing-managed identities", () => {
  assert.match(migration, /ADD COLUMN routing_managed/);
  assert.doesNotMatch(migration, /support@example\.com/);

  assert.match(sync, /INSERT INTO mailboxes\(mailbox_id,address,display_name,can_receive,can_send,active,routing_managed/);
  assert.match(sync, /UPDATE mailboxes SET can_receive=\?,can_send=1,active=1,routing_managed=1/);
  assert.match(sync, /UPDATE mailboxes SET can_receive=0,can_send=0,active=0[\s\S]*routing_managed=1/);
  assert.match(sync, /send_only_addresses = @\(\$desiredAddresses \| Where-Object \{ -not \$receiveSet\.Contains\(\$_\) \}\)/);
  assert.doesNotMatch(sync, /DELETE FROM mailboxes/i);
  assert.doesNotMatch(sync, /DELETE FROM mail_messages|DELETE FROM mail_threads|MAIL_R2\.delete/i);
});

test("routing sync uses scoped Cloudflare and D1 APIs without creating Worker secrets", () => {
  assert.match(sync, /zones\/\$ZoneId\/email\/routing\/rules/);
  assert.match(sync, /accounts\/\$AccountId\/d1\/database\?name=/);
  assert.match(sync, /accounts\/\$AccountId\/d1\/database\/\$DatabaseId\/query/);
  assert.doesNotMatch(sync, /wrangler secret|RESEND_API_KEY|AUTH_PEPPER|ADMIN_BOOTSTRAP_TOKEN/);
});

test("deploy synchronizes and post-stage preflight verifies route-derived identities", () => {
  const corePosition = deploy.indexOf("& $CoreProvisioner @coreArgs");
  const syncPosition = deploy.indexOf("& $RoutingMailboxSync");
  assert.ok(corePosition >= 0 && syncPosition > corePosition, "mailbox sync must run after route provisioning");
  assert.match(deploy, /-Mode Sync/);
  assert.match(launcher, /if \(\$Phase -ne "before-stage"\)/);
  assert.match(launcher, /-Mode Check/);
  assert.match(launcher, /-CloudflareToken \$Credentials\.CloudflareReadToken/);
});

test("migration smoke includes routing-managed mailbox state", () => {
  assert.match(migrationVerifier, /0006_routing_managed_mailboxes\.sql/);
  assert.match(migrationVerifier, /Missing migrated column: routing_managed/);
  assert.match(migrationVerifier, /must not seed hardcoded mailbox identities/);
});

test("authenticated routing status API derives the latest successful sync timestamp from route-managed D1 rows", () => {
  assert.match(mailFive, /export async function routingStatus\(env: Env\)/);
  assert.match(mailFive, /WHERE routing_managed=1 AND active=1/);
  assert.match(mailFive, /SELECT MAX\(datetime\(updated_at\)\) AS finished_at/);
  assert.match(mailFive, /Array<Row & \{ route_status: string \}>/);
  assert.doesNotMatch(mailFive, /support|contact|privacy/);
  assert.match(mailFive, /route_status: status/);
  assert.match(mailFive, /everyManagedRouteReady/);
  assert.match(mailFive, /forwardingReady/);
  assert.match(mailFive, /const ready = everyManagedRouteReady/);
  assert.match(mailFive, /status: ready \? "success" : "attention"/);
  assert.match(mailFive, /failed_attempts: unresolvedForwardFailures/);
  assert.match(worker, /routingStatus,/);
  assert.match(worker, /pathname === "\/api\/routing-status"/);
  assert.match(worker, /return routingStatus\(env\)/);
});

test("mail UI shows active sync controls and per-address routing status", () => {
  assert.match(html, /<button id="sync-status"[^>]*type="button"[^>]*>Not synced<\/button>/);
  assert.match(html, /id="routing-sync-button"[\s\S]*id="routing-status-title">Routing status/);
  assert.match(html, /id="system-status" class="routing-status"/);
  assert.match(html, /routing-status\.css/);
  assert.match(html, /js\/app\.mjs/);
  assert.match(worker, /"\/routing-status\.css"/);
  assert.match(worker, /"\/js\/app\.mjs"/);
  assert.match(mailboxJs, /refreshMailboxView/);
  assert.match(routingUi, /\/api\/admin\/mail\/routing-status/);
  assert.match(routingUi, /syncState === "success" \? labels\.synced : labels\.syncAttention/);
  assert.match(routingUi, /raw\.replace\(" ", "T"\)/);
  assert.match(routingUi, /setSyncing/);
  assert.match(routingUi, /setSyncFailure/);
  assert.match(routingUi, /route\.route_status/);
  assert.match(routingUi, /Receive and send/);
  assert.match(routingCss, /\.routing-route/);
  assert.match(routingCss, /\.status-pill\[data-state="success"\]/);
  assert.match(routingCss, /\.status-pill\[data-state="syncing"\]/);
});
