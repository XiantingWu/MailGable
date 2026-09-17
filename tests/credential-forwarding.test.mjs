import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const helper = await readFile("scripts/production-credential-forwarding.ps1", "utf8");
const launcher = await readFile("scripts/run-production-with-dev-vars.ps1", "utf8");
const deploy = await readFile("scripts/deploy-production.ps1", "utf8");
const provision = await readFile("scripts/provision.ps1", "utf8");
const testRunner = await readFile("scripts/run-tests.mjs", "utf8");

test("production credential forwarding uses secure child parameters and restores Wrangler state", async () => {
  const shellCandidates = process.platform === "win32" ? ["pwsh.exe"] : ["pwsh", "pwsh.exe"];
  let shell = "";
  for (const candidate of shellCandidates) {
    const probe = spawnSync(candidate, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      shell = candidate;
      break;
    }
  }
  assert.ok(shell, "PowerShell Core is required for credential forwarding integration tests.");

  const windowsPowerShellFromWsl = process.platform !== "win32" && shell.toLowerCase().endsWith(".exe");
  const directory = await mkdtemp(join(windowsPowerShellFromWsl ? process.cwd() : tmpdir(), "mailbox-credential-forwarding-"));
  const probe = join(directory, "probe.ps1");
  const child = join(directory, "child.ps1");
  const childSource = String.raw`
param(
  [Parameter(Mandatory = $true)][ValidateSet("Preflight", "Deploy", "Reconcile")][string]$Action,
  [Security.SecureString]$CloudflareReadToken,
  [Security.SecureString]$CloudflareDeployToken,
  [Security.SecureString]$ResendSetupKey,
  [Security.SecureString]$ResendSendingKey,
  [Security.SecureString]$AdminPasswordSecure
)
$ErrorActionPreference = "Stop"
function Convert-ChildSecureString([Security.SecureString]$Value) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
function Assert-Child([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}
if ($Action -eq "Preflight") {
  Assert-Child ($env:CLOUDFLARE_API_TOKEN -eq "cf-read-sentinel") "Child did not receive the read environment token."
  Assert-Child ((Convert-ChildSecureString $CloudflareReadToken) -eq "cf-read-sentinel") "Child did not receive the read SecureString."
  Assert-Child ((Convert-ChildSecureString $ResendSetupKey) -eq "resend-setup-sentinel") "Child did not receive the setup SecureString."
}
if ($Action -eq "Deploy") {
  Assert-Child ($env:CLOUDFLARE_API_TOKEN -eq "cf-deploy-sentinel") "Child did not receive the deploy environment token."
  Assert-Child ((Convert-ChildSecureString $CloudflareDeployToken) -eq "cf-deploy-sentinel") "Child did not receive the deploy SecureString."
  Assert-Child ((Convert-ChildSecureString $ResendSetupKey) -eq "resend-setup-sentinel") "Child did not receive the setup SecureString."
  Assert-Child ((Convert-ChildSecureString $ResendSendingKey) -eq "resend-send-sentinel") "Child did not receive the sending SecureString."
  Assert-Child ((Convert-ChildSecureString $AdminPasswordSecure) -eq "short-admin") "Child did not receive the administrator password securely."
}
if ($Action -eq "Reconcile") {
  Assert-Child ($env:CLOUDFLARE_API_TOKEN -eq "cf-deploy-sentinel") "Child did not receive the reconcile environment token."
  Assert-Child ((Convert-ChildSecureString $CloudflareDeployToken) -eq "cf-deploy-sentinel") "Child did not receive the reconcile SecureString."
  Assert-Child ((Convert-ChildSecureString $ResendSetupKey) -eq "resend-setup-sentinel") "Child did not receive the reconcile setup SecureString."
}
Write-Output ("CHILD_OK:" + $Action)
`;
  const probeSource = String.raw`
param(
  [Parameter(Mandatory = $true)][string]$HelperPath,
  [Parameter(Mandatory = $true)][string]$ChildPath
)
$ErrorActionPreference = "Stop"
. $HelperPath

function Convert-TestSecureString([Security.SecureString]$Value) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function New-TestPreflightValues {
  return @{ CLOUDFLARE_READ_TOKEN = "cf-read-sentinel"; RESEND_SETUP_FULL_ACCESS_KEY = "resend-setup-sentinel" }
}
function New-TestDeployValues {
  return @{ CLOUDFLARE_DEPLOY_TOKEN = "cf-deploy-sentinel"; RESEND_SETUP_FULL_ACCESS_KEY = "resend-setup-sentinel"; RESEND_PRODUCTION_SENDING_ACCESS_KEY = "resend-send-sentinel"; MAILBOX_ADMIN_PASSWORD = "short-admin" }
}
function New-TestReconcileValues {
  return @{ CLOUDFLARE_DEPLOY_TOKEN = "cf-deploy-sentinel"; RESEND_SETUP_FULL_ACCESS_KEY = "resend-setup-sentinel" }
}
function Assert-Test([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$env:CLOUDFLARE_API_TOKEN = "original-cloudflare-environment"
$originalEnvironment = $env:CLOUDFLARE_API_TOKEN

$preflightOutput = Invoke-WithProductionCredentials -Action Preflight -Values (New-TestPreflightValues) -RequireResendSetupKey -Invocation {
  param([hashtable]$Credentials)
  & $ChildPath -Action Preflight -CloudflareReadToken $Credentials.CloudflareReadToken -ResendSetupKey $Credentials.ResendSetupKey
}
Assert-Test ($preflightOutput -match "CHILD_OK:Preflight") "Preflight mock child was not invoked."
Assert-Test ($env:CLOUDFLARE_API_TOKEN -eq $originalEnvironment) "Successful preflight did not restore CLOUDFLARE_API_TOKEN."

$deployOutput = Invoke-WithProductionCredentials -Action Deploy -Values (New-TestDeployValues) -RequireResendSetupKey -RequireAdminPassword -Invocation {
  param([hashtable]$Credentials)
  & $ChildPath -Action Deploy -CloudflareDeployToken $Credentials.CloudflareDeployToken -ResendSetupKey $Credentials.ResendSetupKey -ResendSendingKey $Credentials.ResendSendingKey -AdminPasswordSecure $Credentials.AdminPasswordSecure
}
Assert-Test ($deployOutput -match "CHILD_OK:Deploy") "Deploy mock child was not invoked."
Assert-Test ($env:CLOUDFLARE_API_TOKEN -eq $originalEnvironment) "Successful deploy did not restore CLOUDFLARE_API_TOKEN."

$reconcileOutput = Invoke-WithProductionCredentials -Action Reconcile -Values (New-TestReconcileValues) -RequireResendSetupKey -Invocation {
  param([hashtable]$Credentials)
  & $ChildPath -Action Reconcile -CloudflareDeployToken $Credentials.CloudflareDeployToken -ResendSetupKey $Credentials.ResendSetupKey
}
Assert-Test ($reconcileOutput -match "CHILD_OK:Reconcile") "Reconcile mock child was not invoked."
Assert-Test ($env:CLOUDFLARE_API_TOKEN -eq $originalEnvironment) "Successful reconcile did not restore CLOUDFLARE_API_TOKEN."

$failureRestored = $false
try {
  Invoke-WithProductionCredentials -Action Deploy -Values (New-TestDeployValues) -RequireResendSetupKey -RequireAdminPassword -Invocation {
    throw "synthetic child failure"
  }
} catch {
  $failureRestored = $env:CLOUDFLARE_API_TOKEN -eq $originalEnvironment
}
Assert-Test $failureRestored "Failed child did not restore CLOUDFLARE_API_TOKEN."

$missingRejected = $false
$missingChildInvoked = $false
try {
  Invoke-WithProductionCredentials -Action Deploy -Values @{ CLOUDFLARE_DEPLOY_TOKEN = "cf-deploy-sentinel"; RESEND_SETUP_FULL_ACCESS_KEY = "resend-setup-sentinel"; RESEND_PRODUCTION_SENDING_ACCESS_KEY = "resend-send-sentinel" } -RequireResendSetupKey -RequireAdminPassword -Invocation {
    $script:missingChildInvoked = $true
  }
} catch {
  $missingRejected = $true
}
Assert-Test $missingRejected "Missing deployment credential was not rejected."
Assert-Test (-not $missingChildInvoked) "Missing credential reached the mock child."
Assert-Test ($env:CLOUDFLARE_API_TOKEN -eq $originalEnvironment) "Missing credential did not restore CLOUDFLARE_API_TOKEN."

$emptyPasswordRejected = $false
try {
  Invoke-WithProductionCredentials -Action Deploy -Values @{ CLOUDFLARE_DEPLOY_TOKEN = "cf-deploy-sentinel"; RESEND_SETUP_FULL_ACCESS_KEY = "resend-setup-sentinel"; RESEND_PRODUCTION_SENDING_ACCESS_KEY = "resend-send-sentinel"; MAILBOX_ADMIN_PASSWORD = "" } -RequireResendSetupKey -RequireAdminPassword -Invocation {
    throw "empty password reached the child"
  }
} catch {
  $emptyPasswordRejected = $true
}
Assert-Test $emptyPasswordRejected "An empty administrator password was not rejected."
Assert-Test ($env:CLOUDFLARE_API_TOKEN -eq $originalEnvironment) "Empty password rejection did not restore CLOUDFLARE_API_TOKEN."

$whitespacePasswordRejected = $false
try {
  Invoke-WithProductionCredentials -Action Deploy -Values @{ CLOUDFLARE_DEPLOY_TOKEN = "cf-deploy-sentinel"; RESEND_SETUP_FULL_ACCESS_KEY = "resend-setup-sentinel"; RESEND_PRODUCTION_SENDING_ACCESS_KEY = "resend-send-sentinel"; MAILBOX_ADMIN_PASSWORD = "   " } -RequireResendSetupKey -RequireAdminPassword -Invocation {
    throw "whitespace password reached the child"
  }
} catch {
  $whitespacePasswordRejected = $true
}
Assert-Test $whitespacePasswordRejected "A whitespace-only administrator password was not rejected."
Assert-Test ($env:CLOUDFLARE_API_TOKEN -eq $originalEnvironment) "Whitespace password rejection did not restore CLOUDFLARE_API_TOKEN."

$trackedRoot = Join-Path ([IO.Path]::GetTempPath()) ("mailbox-tracked-dev-vars-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $trackedRoot -Force | Out-Null
try {
  Set-Content -LiteralPath (Join-Path $trackedRoot ".gitignore") -Value ".dev.vars" -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $trackedRoot ".dev.vars") -Value "SYNTHETIC=not-a-secret" -Encoding UTF8
  & git -C $trackedRoot init --quiet
  & git -C $trackedRoot add -f -- ".dev.vars"
  $trackedRejected = $false
  try { Assert-ProductionDevVarsLocalOnly $trackedRoot (Join-Path $trackedRoot ".dev.vars") }
  catch { $trackedRejected = $_.Exception.Message -match "tracked by Git" }
  Assert-Test $trackedRejected "A tracked .dev.vars was not rejected."
} finally {
  Remove-Item -LiteralPath $trackedRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Assert-Test ($env:CLOUDFLARE_API_TOKEN -eq $originalEnvironment) "Final environment restoration failed."
Write-Output "CREDENTIAL_FORWARDING_INTEGRATION_OK"
`;

  try {
    await writeFile(probe, probeSource, "utf8");
    await writeFile(child, childSource, "utf8");
    const toPowerShellPath = (value) => {
      if (!windowsPowerShellFromWsl) return value;
      const converted = spawnSync("wslpath", ["-w", value], { encoding: "utf8" });
      assert.equal(converted.status, 0, converted.stderr);
      return converted.stdout.trim();
    };
    const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", toPowerShellPath(probe), "-HelperPath", toPowerShellPath(join(process.cwd(), "scripts", "production-credential-forwarding.ps1")), "-ChildPath", toPowerShellPath(child)], {
      ...(windowsPowerShellFromWsl ? {} : { cwd: process.cwd() }),
      encoding: "utf8",
      timeout: 120000,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, output);
    assert.match(output, /CREDENTIAL_FORWARDING_INTEGRATION_OK/);
    for (const sentinel of ["cf-read-sentinel", "cf-deploy-sentinel", "resend-setup-sentinel", "resend-send-sentinel", "short-admin", "original-cloudflare-environment"]) {
      assert.doesNotMatch(output, new RegExp(sentinel));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production scripts keep the password hidden and wire action-specific credentials", () => {
  assert.match(launcher, /Invoke-WithProductionCredentials/);
  assert.match(helper, /CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(launcher, /function Read-Host/);
  assert.match(launcher, /-CloudflareReadToken \$Credentials\.CloudflareReadToken/);
  assert.match(launcher, /CloudflareDeployToken = \$Credentials\.CloudflareDeployToken/);
  assert.match(launcher, /ResendSetupKey = \$Credentials\.ResendSetupKey/);
  assert.match(launcher, /ResendSendingKey = \$Credentials\.ResendSendingKey/);
  assert.match(launcher, /requiredVariableNames\.Add\("MAILBOX_ADMIN_PASSWORD"\)/);
  assert.match(launcher, /-RequireAdminPassword:\(\$Action -eq "Deploy"\)/);
  assert.match(helper, /MAILBOX_ADMIN_PASSWORD/);
  assert.match(helper, /AdminPasswordSecure/);
  assert.doesNotMatch(helper, /MinimumLength|at least 16/);
  assert.match(deploy, /\[Security\.SecureString\]\$AdminPasswordSecure/);
  assert.match(deploy, /AdminPasswordSecure = \$AdminPasswordSecure/);
  assert.match(helper, /previousCloudflareApiToken/);
  assert.match(helper, /finally/);
  assert.match(helper, /Clear-ProductionSecureString/);
  assert.match(provision, /Read-Host \$Prompt -AsSecureString/);
  assert.match(provision, /\[Security\.SecureString\]\$AdminPasswordSecure/);
  assert.doesNotMatch(provision, /\$adminPassword\s*=/);
  assert.doesNotMatch(provision, /Set-WranglerSecret[^\n]*AdminPassword/);
  assert.doesNotMatch(provision, /at least 16|16-128/);
  assert.match(provision, /finally[\s\S]*adminPasswordPlaintext/);
  assert.doesNotMatch(provision, /\$resendSetupKey\s*=/);
  assert.doesNotMatch(provision, /\$resendSendingKey\s*=/);
  assert.match(provision, /\$resendSetupPlaintext/);
  assert.match(provision, /\$resendSendingPlaintext/);
  assert.match(testRunner, /fileURLToPath/);
  assert.doesNotMatch(testRunner, /npx\.cmd/);
});
