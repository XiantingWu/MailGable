import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";

async function joinedDir(dir, ext) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(ext)).sort();
  return (await Promise.all(names.map((name) => readFile(`${dir}/${name}`, "utf8")))).join("\n");
}

const worker = await readFile("src/index.ts", "utf8");
const auth = await readFile("src/auth.ts", "utf8");
const lib = await readFile("src/lib.ts", "utf8");
const mail = await joinedDir("src/mail", ".ts");
const mailBarrel = await readFile("src/mail.ts", "utf8");
const mailAll = mail + "\n" + mailBarrel;
const hardening = await readFile("migrations/0002_mailbox_hardening.sql", "utf8");
const replySafety = await readFile("migrations/0003_mailbox_reply_safety.sql", "utf8");
const eventsSource = await readFile("src/providers/events.ts", "utf8");
const ui = await joinedDir("public/js", ".mjs");
const html = await readFile("public/index.html", "utf8");
const devWrangler = await readFile("wrangler.jsonc", "utf8");
const packageJson = await readFile("package.json", "utf8");
const provision = await readFile("scripts/provision.ps1", "utf8");
const setup = await readFile("scripts/setup.mjs", "utf8");
const restoreRouting = await readFile("scripts/restore-email-routing.ps1", "utf8");
const restoreRedirect = await readFile("scripts/restore-admin-mail-redirect.ps1", "utf8");
const resetAdmin = await readFile("scripts/reset-admin-password.ps1", "utf8");

test("protects mailbox APIs and account mutations", () => {
  assert.match(worker, /requireSession\(request, env, true\)/);
  assert.match(worker, /\/api\/auth\/password/);
  assert.match(worker, /\/api\/auth\/logout-all/);
  assert.match(worker, /\/api\/ops\/storage-probe/);
  assert.match(auth, /X-CSRF-Token/);
  assert.match(lib, /__Host-mailbox_session/);
  assert.match(lib, /SameSite=Strict/);
  assert.match(auth, /8_000/);
  assert.match(auth, /codePoints < 15/);
  assert.match(auth, /rejected, not truncated/);
  assert.doesNotMatch(html, /minlength="16"/);
  assert.match(html, /minlength="15"/);
  assert.match(lib, /if \(!origin \|\| origin !== expected\)/);
});

test("uses one canonical mailbox Worker and no redirect Worker", async () => {
  assert.match(devWrangler, /"name": "mailgable-dev"/);
  assert.match(devWrangler, /"workers_dev": true/);
  assert.match(devWrangler, /"database_name": "mailgable-db"/);
  assert.match(devWrangler, /"bucket_name": "mailgable-r2"/);

  assert.doesNotMatch(devWrangler, /"routes"/);
  assert.match(devWrangler, /"APP_ORIGIN": ""/);
  assert.doesNotMatch(packageJson, /deploy:redirect|wrangler\.redirect/);
  await assert.rejects(access("src/redirect.ts"));
  await assert.rejects(access("wrangler.redirect.jsonc"));
});

test("stores Reply-To and prevents client-selected cross-mailbox threads", () => {
  assert.match(replySafety, /reply_to_json/);
  assert.match(mail, /addressArray\(parsed\.replyTo\)/);
  assert.match(mail, /JSON\.stringify\(replyTo\)/);
  assert.match(mail, /reply_to_json,to_json/);
  assert.match(mail, /thread_parent_required/);
  assert.match(mail, /if \(!parent && requestedThreadId\)/);
  assert.match(mail, /reply_mailbox_mismatch/);
  assert.match(ui, /messageReplyAddresses/);
  assert.match(ui, /\["reply_to_json", "from_json"\]/);
});

test("forwarding and archived reuse are complete-or-fail", () => {
  assert.match(mail, /forward_archive_incomplete/);
  assert.match(mail, /forward_archive_missing/);
  assert.match(mail, /forward_archive_invalid/);
  assert.match(mail, /String\(original\.archive_status \|\| ""\) !== "archived"/);
  assert.doesNotMatch(mail, /bounded database preview remains available/);
  assert.match(mail, /SELECT filename,content_type,r2_object_key,size,sha256/);
  assert.match(mail, /timingSafeEqual\(expectedHash, actualHash\)/);
  assert.match(mail, /message_body_too_large/);
  assert.match(mail, /was not truncated/);
});

test("bounds untrusted webhook bodies before buffering and verifies callbacks", () => {
  assert.match(mail, /async function readTextLimited/);
  assert.match(mail, /request\.body\.getReader\(\)/);
  assert.match(mail, /reader\.cancel\("payload limit exceeded"\)/);
  assert.match(mail, /verifyResendWebhook/);
  assert.match(mail, /svix-id/);
  assert.match(eventsSource, /INSERT OR IGNORE INTO mail_delivery_events/);
});

test("keeps archives private and browser HTML sandboxed", () => {
  assert.match(mail, /MAIL_R2\.get/);
  assert.match(mail, /Cache-Control", "private, no-store/);
  assert.match(ui, /frame\.sandbox = "allow-popups allow-popups-to-escape-sandbox"/);
  assert.match(ui, /Content-Security-Policy/);
  assert.match(ui, /default-src 'none'/);
  assert.doesNotMatch(ui, /eval\s*\(/);
  assert.doesNotMatch(ui, /allow-scripts|allow-same-origin|allow-forms/);
  assert.match(html, /noindex,nofollow,noarchive/);
});

test("prevents stale rendering, preserves unread state, and paginates long threads", () => {
  assert.match(ui, /detailRequest: 0/);
  assert.match(ui, /const requestId = \+\+state\.detailRequest/);
  assert.match(ui, /requestId !== state\.detailRequest \|\| state\.selectedThread !== threadId/);
  assert.match(ui, /autoMarkRead: !markUnread/);
  assert.match(ui, /state\.detailRequest \+= 1/);
  assert.match(ui, /async function loadOlderMessages/);
  assert.match(ui, /offset=\$\{offset\}/);
  assert.match(ui, /messages: uniqueRows\(\[\.\.\.\(older\.messages/);
});

test("applies canonical English interface copy", () => {
  assert.match(html, /data-i18n="adminEmail"/);
  assert.match(html, /data-i18n="currentPassword"/);
  assert.match(html, /data-i18n-placeholder="multipleAddresses"/);
  assert.match(html, /data-i18n-aria="messageDetail"/);
  assert.match(ui, /querySelectorAll\("\[data-i18n\]"\)/);
  assert.match(ui, /querySelectorAll\("\[data-i18n-placeholder\]"\)/);
  assert.match(ui, /querySelectorAll\("\[data-i18n-aria\]"\)/);
  assert.match(ui, /replyMessage: "Reply"/);
  assert.match(ui, /forwardMessage: "Forward message"/);
  assert.match(ui, /document\.documentElement\.lang = "en"/);
  assert.doesNotMatch(ui, /state\.lang/);
  assert.doesNotMatch(ui, /mailbox_lang/);
  assert.doesNotMatch(ui, /zh-CN/);
  assert.doesNotMatch(html, /auth-language/);
  assert.doesNotMatch(html, /language-toggle/);
});

test("provisioning installs one path-preserving Single Redirect and removes the legacy Worker", () => {
  assert.match(provision, /\$RedirectPhase = "http_request_dynamic_redirect"/);
  assert.match(provision, /\$RedirectRuleRef = "mailbox_admin_mail_to_dev"/);
  assert.match(provision, /starts_with\(http\.request\.uri\.path/);
  assert.match(provision, /target_url = @\{ expression = \$targetExpression \}/);
  assert.match(provision, /status_code = 308/);
  assert.match(provision, /preserve_query_string = \$true/);
  assert.match(provision, /Save-AdminMailRedirectBackup/);
  assert.match(provision, /Restore-AdminMailRedirectBackup/);
  assert.match(provision, /Method Patch -Uri "https:\/\/api\.cloudflare\.com\/client\/v4\/zones\/\$ZoneId\/rulesets\/\$rulesetId\/rules\/\$ruleId"/);
  assert.match(provision, /Method Post -Uri "https:\/\/api\.cloudflare\.com\/client\/v4\/zones\/\$ZoneId\/rulesets\/\$rulesetId\/rules"/);
  assert.match(provision, /Remove-LegacyRedirectWorker/);
  assert.match(provision, /workers\/scripts\/\$LegacyRedirectWorkerName"/);
  assert.match(provision, /\$deleteUri = "\$\(\$probeUri\)\?force=true"/);
  assert.match(provision, /Assert-MainRedirect "https:\/\/\$Domain\/admin\/mail"/);
  assert.doesNotMatch(provision, /Write-RedirectConfig|wrangler\.redirect|RedirectConfigPath/);
});

test("provisioning validates dev storage, sending, webhooks, and complete routing pages", () => {
  assert.match(provision, /Get-AllEmailRoutingRules/);
  assert.match(provision, /per_page=50/);
  assert.match(provision, /Get-AllResendWebhooks/);
  assert.match(provision, /after=/);
  assert.match(provision, /workers\/subdomain/);
  assert.match(provision, /workers\/scripts\/\$WorkerName\/subdomain/);
  assert.match(provision, /api\/admin\/mail\/ops\/storage-probe/);
  assert.match(provision, /No signed Resend webhook was observed/);
  assert.match(provision, /complete = \$true/);
  assert.match(provision, /actions = @\(@\{ type = "worker"; value = @\(\$WorkerName\) \}\)/);
  assert.match(provision, /\[string\]\$ForwardTo = ""/);
  assert.match(provision, /Remove-WranglerSecret \$DevConfigPath "ADMIN_BOOTSTRAP_TOKEN"/);
  const initialDeploy = provision.indexOf('Invoke-Wrangler -ConfigPath $DevConfigPath -Arguments @("deploy")');
  const firstSecret = provision.indexOf('Set-WranglerSecret $DevConfigPath "AUTH_PEPPER"');
  assert.ok(initialDeploy >= 0 && firstSecret > initialDeploy, "dev Worker must exist before secret writes");
});

test("independent redirect restore mutates only the managed rule", () => {
  assert.match(restoreRedirect, /SupportsShouldProcess=\$true/);
  assert.match(restoreRedirect, /\$RedirectPhase = "http_request_dynamic_redirect"/);
  assert.match(restoreRedirect, /\$RedirectRuleRef = "mailbox_admin_mail_to_dev"/);
  assert.match(restoreRedirect, /managed_rule_present/);
  assert.match(restoreRedirect, /Method Patch/);
  assert.match(restoreRedirect, /Method Post/);
  assert.match(restoreRedirect, /Method Delete/);
  assert.match(restoreRedirect, /Unrelated redirect rules were not modified/);
  assert.doesNotMatch(restoreRedirect, /rules = @\(\$backup\.rules\)/i);
});

test("independent routing restore rejects incomplete backups and paginates", () => {
  assert.match(restoreRouting, /Get-AllPagedResults/);
  assert.match(restoreRouting, /per_page=50/);
  assert.match(restoreRouting, /result_info\.complete -ne \$true/);
  assert.match(restoreRouting, /Backup format is unsupported or incomplete/);
  assert.match(restoreRouting, /unrelated rules were not modified/);
});

test("local administrator recovery updates only canonical D1 and revokes sessions", () => {
  assert.match(resetAdmin, /DatabaseName = "mailgable-db"/);

  assert.match(resetAdmin, /Rfc2898DeriveBytes/);
  assert.match(resetAdmin, /HashAlgorithmName\]::SHA256/);
  assert.match(resetAdmin, /password_iterations=\$iterations/);
  assert.match(resetAdmin, /password_scheme='pbkdf2-sha256-legacy'/);
  assert.match(resetAdmin, /parsedIterations -ge 8000 -and \$parsedIterations -le 100000/);
  assert.match(resetAdmin, /UPDATE admin_sessions/);
  assert.match(resetAdmin, /auth_password_recovered/);
  assert.match(resetAdmin, /--remote --file \$tempSql --config \$tempConfig/);
  assert.doesNotMatch(resetAdmin, /RESEND|MAIL_R2|ADMIN_RECOVERY_TOKEN/);
});

test("respects D1 and Worker resource limits", () => {
  assert.match(mail, /MAX_TEXT_PREVIEW_BYTES = 300_000/);
  assert.match(mail, /MAX_HTML_PREVIEW_BYTES = 600_000/);
  assert.match(mail, /MAX_THREAD_PAGE = 100/);
  assert.match(mail, /MAX_RAW_BYTES = 20 \* 1024 \* 1024/);
  assert.match(mail, /MAX_INCOMING_TOTAL_ATTACHMENT_BYTES = 15 \* 1024 \* 1024/);
  assert.match(mail, /MAX_OUTGOING_TOTAL_ATTACHMENT_BYTES = 8 \* 1024 \* 1024/);
  assert.match(hardening, /body_truncated/);
});

test("dev and production deployment modes are explicit and non-confusable", () => {
  assert.match(devWrangler, /"compatibility_date": "2026-09-01"/);
  assert.match(devWrangler, /"workers_dev": true/);
  assert.match(setup, /--mode dev\|production/);
  assert.match(setup, /production mode performs remote mutation only after every deterministic/);
  assert.match(setup, /--adopt-empty-resources/);
  assert.match(setup, /setup:remove-bootstrap/);
});
