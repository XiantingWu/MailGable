[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact="High")]
param(
  [Parameter(Mandatory=$true)][string]$BackupPath,
  [string]$ZoneId = ""
)

$ErrorActionPreference = "Stop"
$RedirectPhase = "http_request_dynamic_redirect"
$RedirectRuleRef = "mailbox_admin_mail_to_dev"

function ConvertFrom-Secure([Security.SecureString]$Value) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Read-RequiredSecret([string]$Prompt) {
  $value = ConvertFrom-Secure (Read-Host $Prompt -AsSecureString)
  if ([string]::IsNullOrWhiteSpace($value)) { throw "$Prompt cannot be empty." }
  return $value
}

function Get-HttpStatus($ErrorRecord) {
  if ($ErrorRecord.Exception.Response) {
    return [int]$ErrorRecord.Exception.Response.StatusCode
  }
  return 0
}

function ConvertTo-RulesetRulePayload($Rule) {
  $copy = $Rule | ConvertTo-Json -Depth 50 | ConvertFrom-Json
  foreach ($field in @("id", "version", "last_updated")) {
    $copy.PSObject.Properties.Remove($field)
  }
  return $copy
}

function Get-DynamicRedirectEntrypoint([hashtable]$Headers) {
  $uri = "https://api.cloudflare.com/client/v4/zones/$ZoneId/rulesets/phases/$RedirectPhase/entrypoint"
  try {
    return Invoke-RestMethod -Method Get -Uri $uri -Headers $Headers
  } catch {
    if ((Get-HttpStatus $_) -eq 404) { return $null }
    throw
  }
}

function Get-ManagedRedirectRules($Entrypoint) {
  if (-not $Entrypoint) { return @() }
  return @($Entrypoint.result.rules) | Where-Object { [string]$_.ref -eq $RedirectRuleRef }
}

if (-not (Test-Path $BackupPath)) { throw "Backup file not found: $BackupPath" }
$backup = Get-Content -Raw $BackupPath | ConvertFrom-Json
if (
  $backup.schema_version -ne 1 -or
  $backup.complete -ne $true -or
  $backup.zone_id -ne $ZoneId -or
  $backup.phase -ne $RedirectPhase -or
  $backup.managed_ref -ne $RedirectRuleRef
) {
  throw "The backup is incomplete or belongs to another zone/phase."
}

$token = Read-RequiredSecret "Cloudflare API token with Dynamic URL Redirects Write"
$headers = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }
$entrypoint = Get-DynamicRedirectEntrypoint $headers
$matches = @(Get-ManagedRedirectRules $entrypoint)
if ($matches.Count -gt 1) { throw "Duplicate managed redirect refs exist. Resolve them before restoring." }

$action = if ([bool]$backup.managed_rule_present) {
  "restore the previous admin mail redirect rule"
} else {
  "remove the admin mail redirect rule"
}

if (-not $PSCmdlet.ShouldProcess("zone $ZoneId", $action)) {
  Write-Host "No changes were made."
  exit 0
}

if ([bool]$backup.managed_rule_present) {
  $savedRule = ConvertTo-RulesetRulePayload $backup.managed_rule
  if (-not $entrypoint) {
    $body = @{ description = "Zone-level dynamic redirects"; rules = @($savedRule) } | ConvertTo-Json -Depth 50
    $result = Invoke-RestMethod -Method Put -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/rulesets/phases/$RedirectPhase/entrypoint" -Headers $headers -Body $body
  } elseif ($matches.Count -eq 1) {
    $result = Invoke-RestMethod -Method Patch -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/rulesets/$($entrypoint.result.id)/rules/$($matches[0].id)" -Headers $headers -Body ($savedRule | ConvertTo-Json -Depth 50)
  } else {
    $result = Invoke-RestMethod -Method Post -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/rulesets/$($entrypoint.result.id)/rules" -Headers $headers -Body ($savedRule | ConvertTo-Json -Depth 50)
  }
  if (-not $result.success) { throw "Cloudflare did not restore the previous redirect rule." }
} elseif ($entrypoint -and $matches.Count -eq 1) {
  $result = Invoke-RestMethod -Method Delete -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/rulesets/$($entrypoint.result.id)/rules/$($matches[0].id)" -Headers $headers
  if (-not $result.success) { throw "Cloudflare did not remove the managed redirect rule." }
}

$verified = Get-DynamicRedirectEntrypoint $headers
$verifiedMatches = @(Get-ManagedRedirectRules $verified)
if ([bool]$backup.managed_rule_present -and $verifiedMatches.Count -ne 1) {
  throw "Restore verification failed: the previous managed rule is not present exactly once."
}
if (-not [bool]$backup.managed_rule_present -and $verifiedMatches.Count -ne 0) {
  throw "Restore verification failed: the managed rule is still present."
}

$token = $null
Write-Host "Admin mail Single Redirect state restored successfully."
Write-Host "Unrelated redirect rules were not modified."
