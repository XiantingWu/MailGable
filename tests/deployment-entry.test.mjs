import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const guarded = await readFile("scripts/deploy-production.ps1", "utf8");
const core = await readFile("scripts/provision.ps1", "utf8");
const devVarsRunner = await readFile("scripts/run-production-with-dev-vars.ps1", "utf8");
const credentialForwarding = await readFile("scripts/production-credential-forwarding.ps1", "utf8");
const devVarsExample = await readFile(".dev.vars.example", "utf8");
const opsEnvExample = await readFile("ops.env.example", "utf8");
const gitignore = await readFile(".gitignore", "utf8");

test("package configuration defines standalone check, test, and deploy entrypoints", () => {
  assert.equal(packageJson.name, "mailgable");
  assert.ok(!packageJson.scripts.check.includes("tsc --noEmit"), "check must delegate to avoid duplicate execution");
  assert.ok(!packageJson.scripts.check.includes("generate"));
  assert.ok(packageJson.scripts.check.includes("check:core"));
  assert.ok(packageJson.scripts.check.includes("test:worker"));
  assert.ok(packageJson.scripts["check:core"].includes("tsc --noEmit"));
  assert.ok(packageJson.scripts["check:core"].includes("run-tests.mjs"));
  assert.ok(packageJson.scripts["check:core"].includes("verify-migration.mjs"));
  assert.ok(packageJson.scripts["check:core"].includes("wrangler deploy --dry-run"));
  assert.ok(!("deploy" in packageJson.scripts), "deploy must not point at the dev config");
  assert.ok(!("deploy:dev" in packageJson.scripts), "deploy:dev must not exist: remote deploys go through the central operator runner (setup:deploy)");
  assert.ok(packageJson.scripts["setup:deploy"].includes("setup.mjs"), "setup:deploy is the central production deployment entrypoint");
  assert.ok(packageJson.scripts["db:migrate:remote"].includes("db-remote.mjs"), "db:migrate:remote runs through the central runner, never raw wrangler");
  assert.ok(packageJson.scripts.test.includes("run-tests.mjs"));
});


test("guarded deployment verifies exact R2 and removes bootstrap secrets fail-closed", () => {
  assert.match(guarded, /r2 bucket info \$Name --json/);
  assert.match(guarded, /ADMIN_BOOTSTRAP_TOKEN = \$null/);
  assert.match(guarded, /ADMIN_BOOTSTRAP_TOKEN remains after cleanup/);
  assert.match(guarded, /finally \{\s*try \{ Remove-TemporaryBootstrapSecret \}/);
  assert.match(guarded, /if \(\$cleanupError\)/);
  assert.match(guarded, /GuardedInvocation = \$true/);
  assert.match(core, /if \(-not \$GuardedInvocation\)/);
  assert.match(core, /Use scripts\/deploy-production\.ps1/);
});

test("the core creates a GET and HEAD only redirect and rejects POST redirection", () => {
  assert.match(core, /http\.request\.method eq `"GET`"/);
  assert.match(core, /http\.request\.method eq `"HEAD`"/);
  assert.match(core, /\[string\]\$rule\.expression -ne \[string\]\$desired\.expression/);
  assert.match(core, /Assert-MainNotRedirected "https:\/\/\$Domain\/admin\/mail" "Post"/);
  assert.match(guarded, /Assert-MainPostNotRedirected/);
  assert.match(guarded, /Invoke-WebRequest -Method Post/);
  assert.match(guarded, /\$status -eq 307 -or \$status -eq 308/);
});

test("email routing final verification is inside the rollback boundary", () => {
  assert.match(
    core,
    /try \{[\s\S]*Final Email Routing verification failed[\s\S]*\} catch \{[\s\S]*Inbound route update or verification failed\. Restoring previous managed rules/,
  );
  assert.match(core, /Could not delete newly created rule/);
  assert.match(core, /Could not restore rule/);
});

test("runtime config and setup-only operator credentials are separated and gitignored", () => {
  assert.doesNotMatch(devVarsExample, /CLOUDFLARE_READ_TOKEN|CLOUDFLARE_DEPLOY_TOKEN|RESEND_SETUP_FULL_ACCESS_KEY|MAILBOX_ADMIN_PASSWORD/);
  assert.match(devVarsExample, /^AUTH_PEPPER=""$/m);
  assert.match(devVarsExample, /^RESEND_API_KEY=""$/m);
  assert.match(opsEnvExample, /^CLOUDFLARE_READ_TOKEN=""$/m);
  assert.match(opsEnvExample, /^CLOUDFLARE_DEPLOY_TOKEN=""$/m);
  assert.match(opsEnvExample, /^RESEND_SETUP_FULL_ACCESS_KEY=""$/m);
  assert.match(opsEnvExample, /^RESEND_PRODUCTION_SENDING_ACCESS_KEY=""$/m);
  assert.match(opsEnvExample, /^MAILBOX_ADMIN_PASSWORD=""$/m);
  assert.match(gitignore, /^\.dev\.vars$/m);
  assert.match(gitignore, /^!ops\.env\.example$/m);
  assert.match(devVarsRunner, /Join-Path \$RepositoryRoot "\.dev\.vars"/);
  assert.match(credentialForwarding, /check-ignore --quiet --no-index/);
  assert.match(credentialForwarding, /ls-files --error-unmatch/);
  assert.match(devVarsRunner, /Invoke-WithProductionCredentials/);
  assert.match(credentialForwarding, /CLOUDFLARE_API_TOKEN/);
  assert.match(credentialForwarding, /CLOUDFLARE_READ_TOKEN/);
  assert.match(credentialForwarding, /CLOUDFLARE_DEPLOY_TOKEN/);
  assert.match(credentialForwarding, /RESEND_SETUP_FULL_ACCESS_KEY/);
  assert.match(credentialForwarding, /RESEND_PRODUCTION_SENDING_ACCESS_KEY/);
  assert.match(devVarsRunner, /\$requiredVariableNames\.Add\("RESEND_SETUP_FULL_ACCESS_KEY"\)/);
  assert.match(devVarsRunner, /\$requiredVariableNames\.Add\("RESEND_PRODUCTION_SENDING_ACCESS_KEY"\)/);
  assert.match(devVarsRunner, /preflight-production\.ps1/);
  assert.match(devVarsRunner, /deploy-production\.ps1/);
  assert.match(devVarsRunner, /reconcile-legacy-resources\.ps1/);
  assert.match(devVarsRunner, /if \(-not \$Apply\) \{ \$arguments\.WhatIf = \$true \}/);
  assert.doesNotMatch(devVarsRunner, /"Mailbox administrator password[^\n]*\{\s*"/);
  assert.doesNotMatch(devVarsRunner, /Write-Host\s+\$value/);
});
