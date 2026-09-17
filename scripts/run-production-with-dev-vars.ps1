[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Preflight", "Deploy", "Reconcile")]
  [string]$Action,

  [ValidateSet("before-stage", "after-stage", "after-cutover")]
  [string]$Phase = "before-stage",

  [switch]$SkipEmailRouting,
  [switch]$RemoveLegacyRoutes,
  [switch]$RemoveLegacyWorkers,
  [switch]$RemoveLegacyResendWebhooks,
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
$MailboxRoot = Split-Path -Parent $PSScriptRoot
$RepositoryRoot = Split-Path -Parent $MailboxRoot
$DevVarsPath = Join-Path $RepositoryRoot ".dev.vars"
$CredentialForwardingHelper = Join-Path $PSScriptRoot "production-credential-forwarding.ps1"
$PreflightScript = Join-Path $PSScriptRoot "preflight-production.ps1"
$DeployScript = Join-Path $PSScriptRoot "deploy-production.ps1"
$ReconcileScript = Join-Path $PSScriptRoot "reconcile-legacy-resources.ps1"
$RoutingMailboxSync = Join-Path $PSScriptRoot "sync-routing-mailboxes.ps1"
Set-Location $MailboxRoot

if (-not (Test-Path -LiteralPath $CredentialForwardingHelper -PathType Leaf)) {
  throw "Credential forwarding helper not found: $CredentialForwardingHelper"
}
if (-not (Test-Path -LiteralPath $RoutingMailboxSync -PathType Leaf)) {
  throw "Routing mailbox synchronizer not found: $RoutingMailboxSync"
}
. $CredentialForwardingHelper

function Read-DevVarsFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Missing $Path. Copy .dev.vars.example to .dev.vars and fill the required production credential values."
  }

  $values = @{}
  $lineNumber = 0
  foreach ($rawLine in [IO.File]::ReadAllLines($Path)) {
    $lineNumber += 1
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith("#")) { continue }

    $match = [regex]::Match($line, '^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$')
    if (-not $match.Success) {
      throw "Invalid .dev.vars syntax on line $lineNumber. Expected NAME=value."
    }

    $name = $match.Groups[1].Value
    if ($values.ContainsKey($name)) {
      throw "Duplicate .dev.vars entry '$name' on line $lineNumber."
    }

    $value = $match.Groups[2].Value.Trim()
    if ($value.Length -ge 2) {
      $first = $value[0]
      $last = $value[$value.Length - 1]
      if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    $values[$name] = $value
  }
  return $values
}

function Get-RequiredDevVar([hashtable]$Values, [string]$Name) {
  if (-not $Values.ContainsKey($Name) -or [string]::IsNullOrWhiteSpace([string]$Values[$Name])) {
    throw "Required .dev.vars entry '$Name' is missing or empty."
  }
  return [string]$Values[$Name]
}

Assert-ProductionDevVarsLocalOnly $RepositoryRoot $DevVarsPath
$script:DevVarSecrets = Read-DevVarsFile $DevVarsPath

$requiredVariableNames = New-Object System.Collections.Generic.List[string]
switch ($Action) {
  "Preflight" {
    $requiredVariableNames.Add("CLOUDFLARE_READ_TOKEN")
  }
  "Deploy" {
    $requiredVariableNames.Add("CLOUDFLARE_DEPLOY_TOKEN")
    $requiredVariableNames.Add("RESEND_PRODUCTION_SENDING_ACCESS_KEY")
    $requiredVariableNames.Add("MAILBOX_ADMIN_PASSWORD")
  }
  "Reconcile" {
    $requiredVariableNames.Add("CLOUDFLARE_DEPLOY_TOKEN")
    if ($RemoveLegacyResendWebhooks) {
      $requiredVariableNames.Add("RESEND_SETUP_FULL_ACCESS_KEY")
    }
  }
}
foreach ($requiredVariableName in $requiredVariableNames) {
  $null = Get-RequiredDevVar $script:DevVarSecrets $requiredVariableName
}

try {
  $needsResendSetupKey = $Action -eq "Reconcile" -and $RemoveLegacyResendWebhooks
  $includeOptionalResendSetupKey = $Action -eq "Preflight" -or $Action -eq "Deploy"

  switch ($Action) {
    "Preflight" {
      $invocation = {
        param([hashtable]$Credentials)
        & $PreflightScript `
          -Phase $Phase `
          -CloudflareReadToken $Credentials.CloudflareReadToken `
          -ResendSetupKey $Credentials.ResendSetupKey
        if (-not $?) { throw "Production preflight failed." }
        if ($Phase -ne "before-stage") {
          & $RoutingMailboxSync `
            -Mode Check `
            -Phase $Phase `
            -CloudflareToken $Credentials.CloudflareReadToken
          if (-not $?) { throw "Routing mailbox consistency check failed." }
        }
      }
    }
    "Deploy" {
      $invocation = {
        param([hashtable]$Credentials)
        $arguments = @{
          CloudflareDeployToken = $Credentials.CloudflareDeployToken
          ResendSetupKey = $Credentials.ResendSetupKey
          ResendSendingKey = $Credentials.ResendSendingKey
          AdminPasswordSecure = $Credentials.AdminPasswordSecure
        }
        if ($SkipEmailRouting) { $arguments.SkipEmailRouting = $true }
        & $DeployScript @arguments
        if (-not $?) { throw "Production deployment failed." }
      }
    }
    "Reconcile" {
      if (-not ($RemoveLegacyRoutes -or $RemoveLegacyWorkers -or $RemoveLegacyResendWebhooks)) {
        throw "Reconcile requires at least one explicit RemoveLegacy* switch."
      }
      $invocation = {
        param([hashtable]$Credentials)
        $arguments = @{
          CloudflareDeployToken = $Credentials.CloudflareDeployToken
        }
        if ($RemoveLegacyRoutes) { $arguments.RemoveLegacyRoutes = $true }
        if ($RemoveLegacyWorkers) { $arguments.RemoveLegacyWorkers = $true }
        if ($RemoveLegacyResendWebhooks) {
          $arguments.RemoveLegacyResendWebhooks = $true
          $arguments.ResendSetupKey = $Credentials.ResendSetupKey
        }
        if (-not $Apply) { $arguments.WhatIf = $true }
        & $ReconcileScript @arguments
        if (-not $?) { throw "Legacy resource reconciliation failed." }
      }
    }
  }

  Invoke-WithProductionCredentials `
    -Action $Action `
    -Values $script:DevVarSecrets `
    -RequireResendSetupKey:$needsResendSetupKey `
    -IncludeResendSetupKeyIfPresent:$includeOptionalResendSetupKey `
    -RequireAdminPassword:($Action -eq "Deploy") `
    -Invocation $invocation
} finally {
  if ($script:DevVarSecrets) {
    foreach ($key in @($script:DevVarSecrets.Keys)) { $script:DevVarSecrets[$key] = $null }
    $script:DevVarSecrets.Clear()
  }
}
