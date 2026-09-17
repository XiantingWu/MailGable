[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact="High")]
param(
  [string]$AccountId = "",
  [string]$ZoneId = "",
  [string]$Domain = "example.com",
  [string]$CanonicalWorker = "mailgable-dev",
  [string[]]$LegacyWorkers = @("mailgable", "mailgable-redirect"),
  [Security.SecureString]$CloudflareDeployToken,
  [Security.SecureString]$ResendSetupKey,
  [switch]$RemoveLegacyWorkers,
  [switch]$RemoveLegacyRoutes,
  [switch]$RemoveLegacyResendWebhooks
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$cfToken = $null
$resendKey = $null

function ConvertFrom-Secure([Security.SecureString]$Value) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
function Read-Secret([string]$Prompt) {
  $value = ConvertFrom-Secure (Read-Host $Prompt -AsSecureString)
  if ([string]::IsNullOrWhiteSpace($value)) { throw "$Prompt cannot be empty." }
  return $value
}
function Invoke-Cf([string]$Method, [string]$Uri, [hashtable]$Headers) {
  $response = Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers
  if ($null -ne $response.success -and -not $response.success) { throw "Cloudflare request failed: $Uri" }
  return $response
}
function Get-AllResendWebhooks([hashtable]$Headers) {
  $all = New-Object System.Collections.Generic.List[object]
  $after = ""
  do {
    $uri = "https://api.resend.com/webhooks?limit=100"
    if ($after) { $uri += "&after=$([Uri]::EscapeDataString($after))" }
    $response = Invoke-RestMethod -Method Get -Uri $uri -Headers $Headers
    foreach ($item in @($response.data)) { $all.Add($item) }
    if (-not $response.has_more) { break }
    $last = @($response.data) | Select-Object -Last 1
    if (-not $last.id) { throw "Resend webhook pagination cursor is missing." }
    $after = [string]$last.id
  } while ($true)
  return $all.ToArray()
}
function Get-HttpSnapshot([string]$Uri) {
  $response = $null
  try {
    $response = Invoke-WebRequest -Method Get -Uri $Uri -MaximumRedirection 0 -UseBasicParsing -ErrorAction Stop
  } catch {
    if ($_.Exception.Response) { $response = $_.Exception.Response }
    else { return [ordered]@{ status=0; content=""; error=$_.Exception.Message } }
  }
  $content = ""
  try { $content = [string]$response.Content } catch { }
  return [ordered]@{ status=[int]$response.StatusCode; content=$content.Substring(0,[Math]::Min($content.Length,2000)); error="" }
}

if (-not ($RemoveLegacyWorkers -or $RemoveLegacyRoutes -or $RemoveLegacyResendWebhooks)) {
  throw "Select at least one explicit removal switch. Use -WhatIf for preview."
}

Write-Host "This tool never deletes D1 databases or R2 buckets."
Write-Host "Inventory and migrate historical data before deleting those resources manually."

try {
  $cfToken = if ($null -ne $CloudflareDeployToken) {
    ConvertFrom-Secure $CloudflareDeployToken
  } else {
    Read-Secret "Cloudflare token with Workers Scripts/Routes Read/Write"
  }
  $resendKey = if ($RemoveLegacyResendWebhooks) {
    if ($null -ne $ResendSetupKey) { ConvertFrom-Secure $ResendSetupKey }
    else { Read-Secret "Temporary Resend Full Access key" }
  } else { "" }
  $cfHeaders = @{ Authorization="Bearer $cfToken"; "Content-Type"="application/json" }

  $scriptsResponse = Invoke-Cf Get "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/scripts" $cfHeaders
  $scriptNames = @($scriptsResponse.result | ForEach-Object { [string]$_.id })
  if ($scriptNames -notcontains $CanonicalWorker) { throw "Canonical Worker $CanonicalWorker is absent; refusing legacy cleanup." }

  $subdomain = Invoke-Cf Get "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/subdomain" $cfHeaders
  $workersSubdomain = [string]$subdomain.result.subdomain
  if (-not $workersSubdomain) { throw "Could not resolve the workers.dev account subdomain." }
  $canonicalOrigin = "https://$CanonicalWorker.$workersSubdomain.workers.dev"
  $health = Get-HttpSnapshot "$canonicalOrigin/healthz"
  if ($health.status -ne 200 -or $health.content -notmatch '"ok"\s*:\s*true') {
    throw "Canonical Worker health check failed; refusing legacy cleanup."
  }

  $routesResponse = Invoke-Cf Get "https://api.cloudflare.com/client/v4/zones/$ZoneId/workers/routes" $cfHeaders
  $routes = @($routesResponse.result)
  $domainPattern = [regex]::Escape($Domain)
  $mailboxRoutes = @($routes | Where-Object { [string]$_.pattern -match "^(?:https?://)?$domainPattern/(admin/mail|api/admin/mail)(?:/|\*|$)" })
  $unexpectedMailboxRoutes = @($mailboxRoutes | Where-Object { $LegacyWorkers -notcontains [string]$_.script })
  if ($unexpectedMailboxRoutes.Count) {
    $details = $unexpectedMailboxRoutes | ForEach-Object { "$($_.pattern) -> $($_.script)" }
    throw "Mailbox paths point to an unexpected Worker. Nothing was deleted: $($details -join '; ')"
  }
  $legacyRoutes = @($mailboxRoutes | Where-Object { $LegacyWorkers -contains [string]$_.script })
  $legacyScriptHits = @($LegacyWorkers | Where-Object { $scriptNames -contains $_ })
  $unexpectedLegacyRoutes = @($routes | Where-Object {
    ($LegacyWorkers -contains [string]$_.script) -and ($legacyRoutes.id -notcontains $_.id)
  })
  if ($RemoveLegacyWorkers -and $unexpectedLegacyRoutes.Count) {
    $details = $unexpectedLegacyRoutes | ForEach-Object { "$($_.pattern) -> $($_.script)" }
    throw "A legacy mailbox Worker also owns non-mailbox routes. Nothing was deleted: $($details -join '; ')"
  }

  $legacyHooks = @()
  if ($RemoveLegacyResendWebhooks) {
    $resendHeaders = @{ Authorization="Bearer $resendKey"; "Content-Type"="application/json" }
    $hooks = Get-AllResendWebhooks $resendHeaders
    $canonicalEndpoint = "$canonicalOrigin/webhooks/resend"
    $canonical = @($hooks | Where-Object { [string]$_.endpoint -eq $canonicalEndpoint })
    if ($canonical.Count -ne 1 -or $canonical[0].status -ne "enabled") {
      throw "Exactly one enabled canonical Resend webhook is required before legacy cleanup; found $($canonical.Count)."
    }
    $legacyHooks = @($hooks | Where-Object { [string]$_.endpoint -match "example\.com/api/admin/mail/webhooks/resend|mailgable(?!-dev).*workers\.dev" })

  }

  Write-Host "Canonical origin: $canonicalOrigin"
  Write-Host "Legacy mailbox routes: $($legacyRoutes.Count)"
  foreach ($route in $legacyRoutes) { Write-Host "  $($route.id): $($route.pattern) -> $($route.script)" }
  Write-Host "Legacy Worker scripts: $($legacyScriptHits -join ', ')"
  Write-Host "Legacy Resend webhooks: $($legacyHooks.Count)"
  foreach ($hook in $legacyHooks) { Write-Host "  $($hook.id): $($hook.endpoint)" }

  if ($WhatIfPreference) {
    if ($RemoveLegacyRoutes) {
      foreach ($route in $legacyRoutes) { $PSCmdlet.ShouldProcess($route.pattern, "Delete legacy mailbox Worker route") | Out-Null }
    }
    if ($RemoveLegacyResendWebhooks) {
      foreach ($hook in $legacyHooks) { $PSCmdlet.ShouldProcess($hook.endpoint, "Delete legacy Resend webhook") | Out-Null }
    }
    if ($RemoveLegacyWorkers) {
      foreach ($worker in $legacyScriptHits) { $PSCmdlet.ShouldProcess($worker, "Delete legacy mailbox Worker script") | Out-Null }
    }
    Write-Host "No changes were made because -WhatIf was supplied."
    return
  }

  if ($RemoveLegacyRoutes) {
    foreach ($route in $legacyRoutes) {
      if ($PSCmdlet.ShouldProcess($route.pattern, "Delete legacy mailbox Worker route")) {
        Invoke-Cf Delete "https://api.cloudflare.com/client/v4/zones/$ZoneId/workers/routes/$($route.id)" $cfHeaders | Out-Null
      }
    }
  }

  $productionApi = Get-HttpSnapshot "https://$Domain/healthz"
  if ($productionApi.content -match '"service"\s*:\s*"mailgable"') {
    throw "The old production mailbox API is still live. Do not switch inbound traffic."
  }

  if ($RemoveLegacyResendWebhooks) {
    foreach ($hook in $legacyHooks) {
      if ($PSCmdlet.ShouldProcess($hook.endpoint, "Delete legacy Resend webhook")) {
        Invoke-RestMethod -Method Delete -Uri "https://api.resend.com/webhooks/$($hook.id)" -Headers $resendHeaders | Out-Null
      }
    }
  }

  if ($RemoveLegacyWorkers) {
    $routesAfter = @((Invoke-Cf Get "https://api.cloudflare.com/client/v4/zones/$ZoneId/workers/routes" $cfHeaders).result)
    foreach ($worker in $legacyScriptHits) {
      $remaining = @($routesAfter | Where-Object { [string]$_.script -eq $worker })
      if ($remaining.Count) { throw "Worker $worker still owns $($remaining.Count) route(s); refusing deletion." }
      if ($PSCmdlet.ShouldProcess($worker, "Delete legacy mailbox Worker script")) {
        try {
          Invoke-Cf Delete "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/scripts/${worker}?force=true" $cfHeaders | Out-Null
        } catch {
          if (-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 404) { throw }
        }
      }
    }
  }

  $finalScripts = @((Invoke-Cf Get "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/scripts" $cfHeaders).result | ForEach-Object { [string]$_.id })
  $finalRoutes = @((Invoke-Cf Get "https://api.cloudflare.com/client/v4/zones/$ZoneId/workers/routes" $cfHeaders).result)
  if ($RemoveLegacyWorkers -and @($LegacyWorkers | Where-Object { $finalScripts -contains $_ }).Count) {
    throw "Legacy Worker scripts remain after reconciliation."
  }
  if ($RemoveLegacyRoutes -and @($finalRoutes | Where-Object { [string]$_.pattern -match "^(?:https?://)?$domainPattern/(admin/mail|api/admin/mail)(?:/|\*|$)" }).Count) {
    throw "Main-domain mailbox Worker routes remain after reconciliation."
  }
  if ($RemoveLegacyResendWebhooks) {
    $finalHooks = Get-AllResendWebhooks $resendHeaders
    $remainingHooks = @($finalHooks | Where-Object { [string]$_.endpoint -match "example\.com/api/admin/mail/webhooks/resend|mailgable(?!-dev).*workers\.dev" })

    if ($remainingHooks.Count) { throw "Legacy Resend webhooks remain after reconciliation." }
  }

  Write-Host "Legacy runtime reconciliation completed. D1/R2 were intentionally untouched."
} finally {
  $cfToken = $null
  $resendKey = $null
}
