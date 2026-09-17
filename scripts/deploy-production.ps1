[CmdletBinding()]
param(
  [string]$AdminEmail = "admin@example.com",
  [string]$Domain = "example.com",
  [string]$AccountId = "",
  [string]$ZoneId = "",
  [string]$WorkerName = "mailgable-dev",
  [string]$DatabaseName = "mailgable-dev",
  [string]$BucketName = "mailgable-dev",
  [string]$ForwardTo = "",
  [Security.SecureString]$CloudflareDeployToken,
  [Security.SecureString]$ResendSetupKey,
  [Security.SecureString]$ResendSendingKey,
  [Security.SecureString]$AdminPasswordSecure,
  [switch]$SkipEmailRouting
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$CoreProvisioner = Join-Path $PSScriptRoot "provision.ps1"
$RoutingReconciler = Join-Path $PSScriptRoot "reconcile-email-routing.ps1"
$RoutingMailboxSync = Join-Path $PSScriptRoot "sync-routing-mailboxes.ps1"
$TemplateConfig = Join-Path (Get-Location) "wrangler.jsonc"
$GeneratedConfig = Join-Path (Get-Location) "wrangler.dev.generated.jsonc"

function Normalize-EmailList([string]$Value) {
  return @($Value -split '[;,\r\n]+' | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
}

function Assert-GeneratedForwardingConfig {
  if (-not (Test-Path -LiteralPath $GeneratedConfig -PathType Leaf)) {
    throw "Generated Worker configuration is missing: $GeneratedConfig"
  }
  try { $config = Get-Content -Raw -LiteralPath $GeneratedConfig | ConvertFrom-Json }
  catch { throw "Generated Worker configuration is invalid JSON." }
  $configured = @(Normalize-EmailList ([string]$config.vars.INBOUND_FORWARD_TO))
  $expected = @(Normalize-EmailList $ForwardTo)
  if ((Compare-Object $configured $expected)) {
    throw "Generated Worker configuration does not match the requested INBOUND_FORWARD_TO value."
  }
  Write-Host "[guard] Generated Worker forwarding configuration matches the requested value."
}

function Get-ExactR2Bucket([string]$Name) {
  $raw = (& npx wrangler r2 bucket info $Name --json --config $TemplateConfig 2>$null | Out-String)
  if ($LASTEXITCODE -ne 0 -or -not $raw.Trim()) { return $null }
  try { $bucket = $raw | ConvertFrom-Json }
  catch { throw "Wrangler returned invalid JSON for R2 bucket '$Name'." }
  if ([string]$bucket.name -ne $Name) {
    throw "Wrangler returned a different R2 bucket. Expected '$Name', received '$($bucket.name)'."
  }
  return $bucket
}

function Ensure-ExactR2Bucket {
  Write-Host "[guard] Verifying the canonical R2 bucket by exact JSON name..."
  $bucket = Get-ExactR2Bucket $BucketName
  if (-not $bucket) {
    & npx wrangler r2 bucket create $BucketName --config $TemplateConfig
    if ($LASTEXITCODE -ne 0) { throw "Could not create exact R2 bucket '$BucketName'." }
    $bucket = Get-ExactR2Bucket $BucketName
    if (-not $bucket) { throw "The exact R2 bucket '$BucketName' is absent after creation." }
  }
  Write-Host "  Exact R2 bucket present: $($bucket.name)"
}

function Get-WorkerSecrets {
  if (-not (Test-Path $GeneratedConfig)) { return @() }
  $raw = (& npx wrangler secret list --format json --config $GeneratedConfig 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Could not list Worker secrets while verifying bootstrap cleanup." }
  if (-not $raw.Trim()) { return @() }
  try { return @($raw | ConvertFrom-Json) }
  catch { throw "Wrangler returned invalid JSON while listing Worker secrets." }
}

function Remove-TemporaryBootstrapSecret {
  if (-not (Test-Path $GeneratedConfig)) { return }
  $present = @(Get-WorkerSecrets | Where-Object { $_.name -eq "ADMIN_BOOTSTRAP_TOKEN" }).Count -gt 0
  if (-not $present) {
    Write-Host "[guard] ADMIN_BOOTSTRAP_TOKEN is absent."
    return
  }
  $temp = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($temp, (@{ ADMIN_BOOTSTRAP_TOKEN = $null } | ConvertTo-Json))
    Get-Content -Raw $temp | & npx wrangler secret bulk --config $GeneratedConfig
    if ($LASTEXITCODE -ne 0) { throw "Could not remove ADMIN_BOOTSTRAP_TOKEN." }
  } finally {
    Remove-Item $temp -Force -ErrorAction SilentlyContinue
  }
  if (@(Get-WorkerSecrets | Where-Object { $_.name -eq "ADMIN_BOOTSTRAP_TOKEN" }).Count -gt 0) {
    throw "ADMIN_BOOTSTRAP_TOKEN remains after cleanup. Production deployment is blocked."
  }
  Write-Host "[guard] Removed and verified ADMIN_BOOTSTRAP_TOKEN."
}

function Assert-MainPostNotRedirected {
  $uri = "https://$Domain/admin/mail"
  $response = $null
  try {
    $response = Invoke-WebRequest -Method Post -Uri $uri -MaximumRedirection 0 -UseBasicParsing -ErrorAction Stop
  } catch {
    if ($_.Exception.Response) { $response = $_.Exception.Response }
    else { throw "Could not verify that POST is excluded from the main-domain redirect: $($_.Exception.Message)" }
  }
  $status = [int]$response.StatusCode
  if ($status -eq 307 -or $status -eq 308) {
    throw "POST $uri is still redirected with HTTP $status. Production deployment is blocked."
  }
  Write-Host "[guard] POST is excluded from the main-domain mailbox redirect (HTTP $status)."
}

if (-not (Test-Path $CoreProvisioner)) { throw "Core provisioner not found: $CoreProvisioner" }
if (-not (Test-Path $RoutingReconciler)) { throw "Email Routing reconciler not found: $RoutingReconciler" }
if (-not (Test-Path $RoutingMailboxSync)) { throw "Routing mailbox synchronizer not found: $RoutingMailboxSync" }
if (-not (Test-Path $TemplateConfig)) { throw "Wrangler template not found: $TemplateConfig" }
if (-not (Test-Path "package-lock.json")) { throw "package-lock.json is required for production deployment." }

function Assert-ForwardToParam {
  $configured = @(Normalize-EmailList $ForwardTo)
  foreach ($address in $configured) {
    if ($address -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
      throw "ForwardTo contains an invalid address: $address (leave empty to disable inbound forwarding)."
    }
  }
}
Assert-ForwardToParam

Write-Host "[guard] Installing locked dependencies and validating the exact source before any cloud resource creation..."
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
npm run check
if ($LASTEXITCODE -ne 0) { throw "Mailbox validation failed." }

Ensure-ExactR2Bucket
$coreArgs = @{
  AdminEmail = $AdminEmail
  Domain = $Domain
  AccountId = $AccountId
  ZoneId = $ZoneId
  WorkerName = $WorkerName
  DatabaseName = $DatabaseName
  BucketName = $BucketName
  ForwardTo = $ForwardTo
  CloudflareDeployToken = $CloudflareDeployToken
  ResendSetupKey = $ResendSetupKey
  ResendSendingKey = $ResendSendingKey
  AdminPasswordSecure = $AdminPasswordSecure
  GuardedInvocation = $true
  # Route ownership belongs to reconcile-email-routing.ps1. The legacy core
  # implementation is intentionally skipped to keep one authoritative writer.
  SkipEmailRouting = $true
}

$coreError = $null
$cleanupError = $null
try {
  & $CoreProvisioner @coreArgs
  if (-not $?) { throw "Core provisioning failed." }
  Assert-GeneratedForwardingConfig
  Assert-MainPostNotRedirected

  if (-not $SkipEmailRouting) {
    & $RoutingReconciler `
      -Mode Reconcile `
      -AccountId $AccountId `
      -ZoneId $ZoneId `
      -Domain $Domain `
      -WorkerName $WorkerName `
      -ForwardTo $ForwardTo `
      -CloudflareToken $CloudflareDeployToken
    if (-not $?) { throw "Email Routing reconciliation failed." }

    & $RoutingMailboxSync `
      -Mode Sync `
      -AccountId $AccountId `
      -ZoneId $ZoneId `
      -Domain $Domain `
      -WorkerName $WorkerName `
      -DatabaseName $DatabaseName `
      -CloudflareToken $CloudflareDeployToken
    if (-not $?) { throw "Routing mailbox synchronization failed." }

    & $RoutingReconciler `
      -Mode Check `
      -AccountId $AccountId `
      -ZoneId $ZoneId `
      -Domain $Domain `
      -WorkerName $WorkerName `
      -ForwardTo $ForwardTo `
      -CloudflareToken $CloudflareDeployToken
    if (-not $?) { throw "Final Email Routing consistency check failed." }

    & $RoutingMailboxSync `
      -Mode Check `
      -Phase after-cutover `
      -AccountId $AccountId `
      -ZoneId $ZoneId `
      -Domain $Domain `
      -WorkerName $WorkerName `
      -DatabaseName $DatabaseName `
      -CloudflareToken $CloudflareDeployToken
    if (-not $?) { throw "Final routing mailbox consistency check failed." }
  } else {
    Write-Warning "Email Routing reconciliation was skipped. This deployment is not a complete production cutover."
  }
} catch {
  $coreError = $_
} finally {
  try { Remove-TemporaryBootstrapSecret }
  catch { $cleanupError = $_ }
}

if ($cleanupError) {
  if ($coreError) { Write-Error "Core provisioning also failed: $($coreError.Exception.Message)" }
  throw $cleanupError
}
if ($coreError) { throw $coreError }

Write-Host ""
Write-Host "Guarded deployment completed."
Write-Host "The one-time bootstrap secret is verified absent."
Write-Host "The main-domain mailbox redirect is verified to exclude POST requests."
if (-not $SkipEmailRouting) {
  Write-Host "All literal domain routes and catch-all are reconciled to the canonical Worker."
  Write-Host "Both required destination addresses are verified."
  Write-Host "All route-derived D1 mailbox identities passed the final consistency check."
}
