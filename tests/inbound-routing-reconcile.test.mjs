import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const reconciler = await readFile("scripts/reconcile-email-routing.ps1", "utf8");
const restore = await readFile("scripts/restore-email-routing.ps1", "utf8");
const deploy = await readFile("scripts/deploy-production.ps1", "utf8");
const wrangler = await readFile("wrangler.jsonc", "utf8");
const mailInbound = await readFile("src/mail/inbound.ts", "utf8");
const mailStatus = await readFile("src/mail/status.ts", "utf8");
const mailRetention = await readFile("src/mail/retention.ts", "utf8");
const inboundForwarding = await readFile("src/inbound-forwarding.ts", "utf8");
const migration = await readFile("migrations/0007_inbound_forward_attempts.sql", "utf8");

const hotmail = "forward@example.org";
const yahoo = "backup@example.org";

test("production config treats inbound forwarding as deployment-owner optional", () => {
  assert.match(deploy, /\[string\]\$ForwardTo = ""/);
  assert.match(deploy, /Assert-ForwardToParam/);
  assert.match(deploy, /Assert-GeneratedForwardingConfig/);
  assert.match(deploy, /ForwardTo = \$ForwardTo/);
  assert.doesNotMatch(deploy, /RequiredForwardTargets/);
  assert.doesNotMatch(deploy, /forward@example\.org/);
  assert.doesNotMatch(deploy, /backup@example\.org/);
});


test("one reconciler owns route mutation and the legacy core writer is disabled", () => {
  assert.match(deploy, /\$RoutingReconciler = Join-Path \$PSScriptRoot "reconcile-email-routing\.ps1"/);
  assert.match(deploy, /SkipEmailRouting = \$true/);
  const reconcilePosition = deploy.indexOf("-Mode Reconcile");
  const syncPosition = deploy.indexOf("-Mode Sync");
  const finalRouteCheck = deploy.lastIndexOf("-Mode Check");
  assert.ok(reconcilePosition >= 0 && syncPosition > reconcilePosition && finalRouteCheck > syncPosition);
});

test("reconciler covers every literal domain route, duplicates, catch-all, verification, backup, and rollback", () => {
  assert.match(reconciler, /Get-AllPagedResults/);
  assert.match(reconciler, /email\/routing\/addresses/);
  assert.match(reconciler, /Assert-DestinationAddresses/);
  assert.match(reconciler, /Destination address \$destination is not verified/);
  assert.match(reconciler, /Normalize-EmailList \$ForwardTo/);
  assert.doesNotMatch(reconciler, /RequiredDestinationAddresses/);
  assert.doesNotMatch(reconciler, /RequiredLocalParts/);
  assert.match(reconciler, /Get-LiteralDomainAddress/);
  assert.match(reconciler, /ambiguous matcher set/);
  assert.match(reconciler, /Get-DomainGroups/);
  assert.match(reconciler, /Select-CanonicalWinner/);
  assert.match(reconciler, /HashSet\[string\]\]::new/);
  assert.match(reconciler, /Invoke-Cf Delete "\$rulesEndpoint\/\$\(\$duplicate\.id\)"/);
  assert.match(reconciler, /\$catchAllEndpoint = "\$rulesEndpoint\/catch_all"/);
  assert.match(reconciler, /Invoke-Cf Put \$catchAllEndpoint/);
  assert.match(reconciler, /Wrangler-managed/);
  assert.match(reconciler, /Complete Email Routing backup/);
  assert.match(reconciler, /Restore-RoutingState/);
  assert.match(reconciler, /Post-reconciliation verification failed/);
  assert.match(reconciler, /\$report\["backup_path"\]/);
  assert.match(reconciler, /\$OutputPath\.result\.json/);
});

test("independent restore covers the complete domain snapshot and catch-all fail-closed", () => {
  assert.match(restore, /SupportsShouldProcess=\$true/);
  assert.match(restore, /ConfirmImpact="High"/);
  assert.match(restore, /Backup belongs to a different Cloudflare account, zone, or domain/);
  assert.match(restore, /Apply-DomainSnapshot/);
  assert.match(restore, /Assert-SnapshotMatches/);
  assert.match(restore, /Get-ComparableMultiset/);
  assert.match(restore, /pre-restore-email-routing\.json/);
  assert.match(restore, /Attempting to return to the pre-restore safety snapshot/);
  assert.match(restore, /Cloudflare exposes no catch-all delete operation/);
  assert.match(restore, /Legacy backup detected/);
  assert.match(restore, /All literal @\$domainNormalized rules and catch-all match/);
});

test("inbound processing persists per-target forward acceptance and exposes bounded diagnostics", () => {
  assert.match(mailInbound, /forwardInboundCopies/);
  assert.match(mailInbound, /await forwardInboundCopies\(message, env, messageId, envelopeTo\)/);
  assert.match(mailInbound, /if \(!inserted\)[\s\S]*forwardInboundCopies/);
  assert.match(inboundForwarding, /export async function forwardInboundCopies/);
  assert.match(inboundForwarding, /message\.forward\(target, forwardAuditHeaders\(message, messageId, envelopeTo, target\)\)/);
  assert.match(inboundForwarding, /X-Mailbox-Archive-ID/);
  assert.match(inboundForwarding, /X-Mailbox-Original-Recipient/);
  assert.match(inboundForwarding, /X-Mailbox-Original-Message-ID/);
  assert.match(inboundForwarding, /X-Mailbox-Forward-Target/);
  assert.doesNotMatch(inboundForwarding, /FORWARD_COPY_GAP_MS/);
  assert.match(inboundForwarding, /accepted.*not proof.*destination MX.*delivered/s);
  assert.match(inboundForwarding, /status<>'accepted'/);
  assert.match(mailStatus, /everyManagedRouteReady/);
  assert.match(mailStatus, /forwardingReady/);
  assert.match(mailStatus, /inbound_forward_attempts WHERE status='failed'/);
  assert.match(mailStatus, /failed_attempts: unresolvedForwardFailures/);
  assert.match(mailStatus, /inboundForwardAddresses\(env\)/);
  assert.match(mailStatus, /forwarding:/);
  assert.match(mailRetention, /DELETE FROM inbound_forward_attempts/);
  assert.match(mailRetention, /status IN \('accepted','failed'\)/);
  assert.match(migration, /PRIMARY KEY \(message_id, target\)/);
  assert.match(migration, /'in_flight'/);
  assert.match(migration, /'accepted'/);
  assert.match(migration, /FOREIGN KEY \(message_id\).*ON DELETE CASCADE/);
});
