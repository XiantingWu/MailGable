import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

async function joinedDir(dir, ext) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(ext)).sort();
  return (await Promise.all(names.map((name) => readFile(`${dir}/${name}`, "utf8")))).join("\n");
}

const auth = await readFile("src/auth.ts", "utf8");
const providers = await joinedDir("src/providers", ".ts");
const mail = (await joinedDir("src/mail", ".ts")) + "\n" + providers;
const provision = await readFile("scripts/provision.ps1", "utf8");
const restoreRouting = await readFile("scripts/restore-email-routing.ps1", "utf8");
const syncRouting = await readFile("scripts/sync-routing-mailboxes.ps1", "utf8");
const reconcile = await readFile("scripts/reconcile-legacy-resources.ps1", "utf8");

test("upgrades legacy password hashes after successful verification", () => {
  assert.match(auth, /async function upgradePasswordHash/);
  assert.match(auth, /needsIterationsUpgrade = Number\(admin\.password_iterations \|\| 0\) < targetIterations/);
  assert.match(auth, /SET password_hash=\?,password_salt=\?,password_iterations=\?,password_scheme=\?/);
  assert.match(auth, /await upgradePasswordHash\(password, admin, env\)/);
});

test("does not expose provider and storage internals in thread detail", () => {
  const detailSelect = mail.match(/SELECT message_id,thread_id,mailbox_id,direction[\s\S]*?FROM mail_messages WHERE thread_id=\?/i)?.[0] || "";
  assert.ok(detailSelect);
  for (const internal of ["idempotency_key", "request_hash", "raw_r2_key", "x_mailbox_mail_id", "provider_internet_message_id"]) {
    assert.equal(detailSelect.includes(internal), false, `${internal} must not be browser-visible`);
  }
});

test("incoming resource guards report skipped attachments", () => {
  assert.match(mail, /MAX_INCOMING_ATTACHMENTS = 50/);
  assert.match(mail, /return \{ stored, skipped \}/);
  assert.match(mail, /attachment_limit_exceeded:\$\{attachmentResult\.skipped\}/);
});

test("provisioning tolerates a redirect ruleset whose rules list is absent or has null placeholders", () => {
  assert.match(provision, /foreach \(\$rule in @\(\$entrypoint\.result\.rules\) \| Where-Object \{ \$null -ne \$_ \}\)/);
});

test("interpolated API URLs never place '?' directly after a bare variable", () => {
  for (const src of [provision, restoreRouting, syncRouting, reconcile]) {
    assert.doesNotMatch(src, /"\$[A-Za-z_][A-Za-z0-9_]*\?/, "variable immediately followed by '?' corrupts interpolation");
  }
});

test("interpolated strings never place ':' directly after a bare variable", () => {
  // "$Uri:" parses the colon as a scope qualifier candidate and throws
  // "Variable reference is not valid" at runtime; ${Uri}: is the valid form.
  // $env: / $script: / $global: / $local: / $private: scope qualifiers are legal.
  const scopeAware = /\$(?!(?:env|script|global|local|private):)[A-Za-z_][A-Za-z0-9_]*(?=[:?])/;
  for (const src of [provision, restoreRouting, syncRouting, reconcile]) {
    assert.doesNotMatch(src, scopeAware, "bare variable followed by ':' or '?' corrupts interpolation");
  }
  assert.match(syncRouting, /for \$\{Uri\}: \$\(\$_\.Exception\.Message\)/);
  assert.match(reconcile, /workers\/scripts\/\$\{worker\}\?force=true/);
});

test("provisioning verifies the redirect through an external non-following client", () => {
  const redirectAssert = provision.match(/^function Assert-MainRedirect[\s\S]*?^(?=function Assert-MainNotRedirected)/m)?.[0] || "";
  assert.ok(redirectAssert, "Assert-MainRedirect body must be locatable");
  assert.match(redirectAssert, /curl -s -D - -o \/dev\/null --max-time 30/);
  assert.match(redirectAssert, /curl -s -I --max-time 30/);
  assert.equal(redirectAssert.includes("Invoke-WebRequest"), false, "redirect verification must not rely on the Invoke-WebRequest exception path");
  assert.equal(redirectAssert.includes("MaximumRedirection"), false);
});

test("provisioning paginates webhooks and reconciles unique provider and Cloudflare rules", () => {
  assert.match(provision, /function Get-AllResendWebhooks/);
  assert.match(provision, /webhooks\?limit=100/);
  assert.match(provision, /if \(\$matchingWebhooks\.Count -gt 1\)/);
  assert.match(provision, /\$webhookId = \[string\]\$matchingWebhooks\[0\]\.id/);
  assert.match(provision, /Invoke-RestMethod -Method Patch -Uri "https:\/\/api\.resend\.com\/webhooks\/\$webhookId"/);
  assert.match(provision, /status = "enabled"/);
  assert.match(provision, /Multiple Email Routing rules already match/);
  assert.match(provision, /No routing changes were made/);
  assert.match(provision, /Multiple redirect rules use ref \$RedirectRuleRef/);
  assert.match(provision, /package-lock\.json is required for production provisioning/);
});
