import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const launcher = await readFile("scripts/run-production-with-dev-vars.ps1", "utf8");
const helper = await readFile("scripts/production-credential-forwarding.ps1", "utf8");
const preflight = await readFile("scripts/preflight-production.ps1", "utf8");
const provision = await readFile("scripts/provision.ps1", "utf8");
const devVarsExample = await readFile(".dev.vars.example", "utf8");
const opsEnvExample = await readFile("ops.env.example", "utf8");

function actionBlock(source, action) {
  const marker = `  "${action}" {`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${action} block is missing`);
  const next = source.indexOf('\n  "', start + marker.length);
  return source.slice(start, next >= 0 ? next : source.length);
}

test("routine preflight and deploy no longer require the temporary Resend Full Access key", () => {
  const preflightRequirements = actionBlock(launcher, "Preflight");
  const deployRequirements = actionBlock(launcher, "Deploy");
  assert.doesNotMatch(preflightRequirements, /RESEND_SETUP_FULL_ACCESS_KEY/);
  assert.doesNotMatch(deployRequirements, /RESEND_SETUP_FULL_ACCESS_KEY/);
  assert.match(launcher, /IncludeResendSetupKeyIfPresent/);
  assert.match(helper, /\[switch\]\$IncludeResendSetupKeyIfPresent/);
  assert.match(preflight, /routine preflight remains least-privilege/);
  assert.doesNotMatch(preflight, /else\s*\{\s*Read-Secret "Temporary Resend Full Access key"/s);
  assert.match(provision, /preserving existing verified domain\/webhook configuration/);
  assert.match(provision, /RESEND_WEBHOOK_SECRET is absent[\s\S]*Supply RESEND_SETUP_FULL_ACCESS_KEY/);
  assert.match(provision, /Sending a real Resend smoke email and waiting for its signed webhook/);
  assert.doesNotMatch(devVarsExample, /RESEND_SETUP_FULL_ACCESS_KEY/, "setup-only credentials must not live in runtime dev vars");
  assert.match(opsEnvExample, /RESEND_SETUP_FULL_ACCESS_KEY/);
});

test("credential helper permits least-privilege deploys but still fails closed for privileged Resend operations", async () => {
  const shellCandidates = process.platform === "win32" ? ["pwsh.exe"] : ["pwsh", "pwsh.exe"];
  let shell = "";
  for (const candidate of shellCandidates) {
    const probe = spawnSync(candidate, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      shell = candidate;
      break;
    }
  }
  assert.ok(shell, "PowerShell Core is required for least-privilege credential tests.");

  const windowsPowerShellFromWsl = process.platform !== "win32" && shell.toLowerCase().endsWith(".exe");
  const directory = await mkdtemp(join(windowsPowerShellFromWsl ? process.cwd() : tmpdir(), "mailbox-least-privilege-"));
  const probePath = join(directory, "probe.ps1");
  const probeSource = String.raw`
param([Parameter(Mandatory=$true)][string]$HelperPath)
$ErrorActionPreference = "Stop"
. $HelperPath

$values = @{
  CLOUDFLARE_DEPLOY_TOKEN = "cf-deploy-sentinel"
  RESEND_PRODUCTION_SENDING_ACCESS_KEY = "resend-send-sentinel"
  MAILBOX_ADMIN_PASSWORD = "admin-sentinel"
}

$output = Invoke-WithProductionCredentials -Action Deploy -Values $values -IncludeResendSetupKeyIfPresent -RequireAdminPassword -Invocation {
  param([hashtable]$Credentials)
  if ($null -eq $Credentials.CloudflareDeployToken) { throw "missing Cloudflare token" }
  if ($null -eq $Credentials.ResendSendingKey) { throw "missing sending key" }
  if ($null -eq $Credentials.AdminPasswordSecure) { throw "missing admin password" }
  if ($Credentials.ContainsKey("ResendSetupKey")) { throw "unexpected setup key" }
  "LEAST_PRIVILEGE_OK"
}
if ($output -notmatch "LEAST_PRIVILEGE_OK") { throw "least-privilege child did not run" }

$requiredRejected = $false
try {
  Invoke-WithProductionCredentials -Action Reconcile -Values @{ CLOUDFLARE_DEPLOY_TOKEN = "cf-deploy-sentinel" } -RequireResendSetupKey -Invocation { throw "privileged child should not run" }
} catch {
  $requiredRejected = $_.Exception.Message -match "RESEND_SETUP_FULL_ACCESS_KEY"
}
if (-not $requiredRejected) { throw "missing privileged setup key was not rejected" }
"PROBE_OK"
`;

  try {
    await writeFile(probePath, probeSource, "utf8");
    const toPowerShellPath = (value) => {
      if (!windowsPowerShellFromWsl) return value;
      const converted = spawnSync("wslpath", ["-w", value], { encoding: "utf8" });
      assert.equal(converted.status, 0, converted.stderr);
      return converted.stdout.trim();
    };
    const result = spawnSync(shell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-File", toPowerShellPath(probePath),
      "-HelperPath", toPowerShellPath(join(process.cwd(), "scripts", "production-credential-forwarding.ps1")),
    ], {
      ...(windowsPowerShellFromWsl ? {} : { cwd: process.cwd() }),
      encoding: "utf8",
      timeout: 120000,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, output);
    assert.match(output, /PROBE_OK/);
    for (const sentinel of ["cf-deploy-sentinel", "resend-send-sentinel", "admin-sentinel"]) {
      assert.doesNotMatch(output, new RegExp(sentinel), `credential leaked: ${sentinel}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
