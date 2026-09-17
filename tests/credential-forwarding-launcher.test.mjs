import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const launcherSource = await readFile("scripts/run-production-with-dev-vars.ps1", "utf8");
const helperSource = await readFile("scripts/production-credential-forwarding.ps1", "utf8");

const mockPreflight = String.raw`
param([Security.SecureString]$CloudflareReadToken, [Security.SecureString]$ResendSetupKey, [string]$Phase)
if ($env:CLOUDFLARE_API_TOKEN -ne "cf-read-sentinel") { throw "wrong preflight environment token" }
if ($null -eq $CloudflareReadToken -or $null -eq $ResendSetupKey) { throw "missing preflight SecureString" }
Write-Output "MOCK_PREFLIGHT_OK"
`;

const mockRoutingSync = String.raw`
param([ValidateSet("Sync", "Check")][string]$Mode, [string]$Phase, [Security.SecureString]$CloudflareToken)
if ($env:CLOUDFLARE_API_TOKEN -ne "cf-read-sentinel") { throw "wrong routing-check environment token" }
if ($Mode -ne "Check" -or $Phase -notin @("after-stage", "after-cutover")) { throw "wrong routing-check arguments" }
if ($null -eq $CloudflareToken) { throw "missing routing-check SecureString" }
function Convert-MockSecure([Security.SecureString]$Value) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
if ((Convert-MockSecure $CloudflareToken) -ne "cf-read-sentinel") { throw "wrong routing-check token" }
Write-Output "MOCK_ROUTING_CHECK_OK"
`;

const mockDeploy = String.raw`
param([Security.SecureString]$CloudflareDeployToken, [Security.SecureString]$ResendSetupKey, [Security.SecureString]$ResendSendingKey, [Security.SecureString]$AdminPasswordSecure, [switch]$SkipEmailRouting)
if ($env:CLOUDFLARE_API_TOKEN -ne "cf-deploy-sentinel") { throw "wrong deploy environment token" }
if ($null -eq $CloudflareDeployToken -or $null -eq $ResendSetupKey -or $null -eq $ResendSendingKey -or $null -eq $AdminPasswordSecure) { throw "missing deploy SecureString" }
function Convert-MockSecure([Security.SecureString]$Value) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
if ((Convert-MockSecure $AdminPasswordSecure) -ne "short-admin") { throw "wrong administrator password" }
Write-Output "MOCK_DEPLOY_OK"
`;

const mockReconcile = String.raw`
param([Security.SecureString]$CloudflareDeployToken, [Security.SecureString]$ResendSetupKey, [switch]$RemoveLegacyRoutes, [switch]$RemoveLegacyWorkers, [switch]$RemoveLegacyResendWebhooks, [switch]$WhatIf)
if ($env:CLOUDFLARE_API_TOKEN -ne "cf-deploy-sentinel") { throw "wrong reconcile environment token" }
if ($null -eq $CloudflareDeployToken -or $null -eq $ResendSetupKey) { throw "missing reconcile SecureString" }
if (-not $RemoveLegacyResendWebhooks -or -not $WhatIf) { throw "reconcile switches were not forwarded" }
Write-Output "MOCK_RECONCILE_OK"
`;

test("launcher forwards credentials to simulated nested production scripts without outputting values", async () => {
  const shellCandidates = process.platform === "win32" ? ["pwsh.exe"] : ["pwsh", "pwsh.exe"];
  let shell = "";
  for (const candidate of shellCandidates) {
    const probe = spawnSync(candidate, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      shell = candidate;
      break;
    }
  }
  assert.ok(shell, "PowerShell Core is required for launcher integration tests.");
  const windowsPowerShellFromWsl = process.platform !== "win32" && shell.toLowerCase().endsWith(".exe");
  const root = await mkdtemp(join(windowsPowerShellFromWsl ? process.cwd() : tmpdir(), "mailbox-launcher-forwarding-"));
  const mailbox = join(root, "mailbox");
  const scripts = join(mailbox, "scripts");
  const launcher = join(scripts, "run-production-with-dev-vars.ps1");
  const helper = join(scripts, "production-credential-forwarding.ps1");

  try {
    await mkdir(scripts, { recursive: true });
    await writeFile(join(root, ".gitignore"), ".dev.vars\n", "utf8");
    const devVarsPath = join(root, ".dev.vars");
    await writeFile(devVarsPath, [
      "CLOUDFLARE_READ_TOKEN=cf-read-sentinel",
      "CLOUDFLARE_DEPLOY_TOKEN=cf-deploy-sentinel",
      "RESEND_SETUP_FULL_ACCESS_KEY=resend-setup-sentinel",
      "RESEND_PRODUCTION_SENDING_ACCESS_KEY=resend-send-sentinel",
    ].join("\n") + "\n", "utf8");
    await writeFile(join(root, ".gitkeep"), "", "utf8");
    await writeFile(launcher, launcherSource, "utf8");
    await writeFile(helper, helperSource, "utf8");
    await writeFile(join(scripts, "preflight-production.ps1"), mockPreflight, "utf8");
    await writeFile(join(scripts, "sync-routing-mailboxes.ps1"), mockRoutingSync, "utf8");
    await writeFile(join(scripts, "deploy-production.ps1"), mockDeploy, "utf8");
    await writeFile(join(scripts, "reconcile-legacy-resources.ps1"), mockReconcile, "utf8");

    const init = spawnSync("git", ["-C", root, "init", "--quiet"], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);

    const toPowerShellPath = (value) => {
      if (!windowsPowerShellFromWsl) return value;
      const converted = spawnSync("wslpath", ["-w", value], { encoding: "utf8" });
      assert.equal(converted.status, 0, converted.stderr);
      return converted.stdout.trim();
    };
    const run = (args) => spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", toPowerShellPath(launcher), ...args], {
      ...(windowsPowerShellFromWsl ? {} : { cwd: mailbox }),
      encoding: "utf8",
      timeout: 120000,
    });

    const runCase = (label, args, expected) => {
      const result = run(args);
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
      assert.equal(result.status, 0, `${label}: ${output}`);
      assert.match(output, expected);
      for (const sentinel of ["cf-read-sentinel", "cf-deploy-sentinel", "resend-setup-sentinel", "resend-send-sentinel", "short-admin"]) {
        assert.doesNotMatch(output, new RegExp(sentinel), `${label} leaked a credential`);
      }
    };
    runCase("Before-stage preflight", ["-Action", "Preflight", "-Phase", "before-stage"], /MOCK_PREFLIGHT_OK/);
    runCase("After-stage preflight", ["-Action", "Preflight", "-Phase", "after-stage"], /MOCK_PREFLIGHT_OK[\s\S]*MOCK_ROUTING_CHECK_OK/);
    runCase("Reconcile", ["-Action", "Reconcile", "-RemoveLegacyResendWebhooks"], /MOCK_RECONCILE_OK/);
    await writeFile(devVarsPath, [
      "CLOUDFLARE_READ_TOKEN=cf-read-sentinel",
      "CLOUDFLARE_DEPLOY_TOKEN=cf-deploy-sentinel",
      "RESEND_SETUP_FULL_ACCESS_KEY=resend-setup-sentinel",
      "RESEND_PRODUCTION_SENDING_ACCESS_KEY=resend-send-sentinel",
      "MAILBOX_ADMIN_PASSWORD=short-admin",
    ].join("\n") + "\n", "utf8");
    runCase("Deploy", ["-Action", "Deploy", "-SkipEmailRouting"], /MOCK_DEPLOY_OK/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
