[CmdletBinding()]
param(
  [string]$AdminEmail = "admin@example.com",
  [string]$Domain = "example.com",
  [string]$AccountId = "",
  [string]$ZoneId = "",
  [string]$WorkerName = "mailgable-dev",
  [string]$LegacyRedirectWorkerName = "mailgable-redirect",
  [string]$DatabaseName = "mailgable-dev",
  [string]$BucketName = "mailgable-dev",
  [string]$ForwardTo = "",
  [string]$MailboxAddresses = "",
  [Security.SecureString]$CloudflareDeployToken,
  [Security.SecureString]$ResendSetupKey,
  [Security.SecureString]$ResendSendingKey,
  [Security.SecureString]$AdminPasswordSecure,
  [switch]$SkipEmailRouting,
  [switch]$GuardedInvocation
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not $GuardedInvocation) {
  throw "provision.ps1 is an internal core. Use scripts/deploy-production.ps1 so validation and bootstrap-secret cleanup remain fail-closed."
}

$DevTemplatePath = Join-Path (Get-Location) "wrangler.jsonc"
$DevConfigPath = Join-Path (Get-Location) "wrangler.dev.generated.jsonc"
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

function Resolve-RequiredSecret([Security.SecureString]$Provided, [string]$Prompt) {
  if ($null -ne $Provided) {
    $value = ConvertFrom-Secure $Provided
    if ([string]::IsNullOrWhiteSpace($value)) { throw "$Prompt cannot be empty." }
    return $value
  }
  return Read-RequiredSecret $Prompt
}

function New-RandomSecret([int]$Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+','-').Replace('/','_')
}

function Get-HttpStatus($ErrorRecord) {
  if ($ErrorRecord.Exception.Response) {
    return [int]$ErrorRecord.Exception.Response.StatusCode
  }
  return 0
}

function Invoke-Wrangler {
  param(
    [Parameter(Mandatory=$true)][string]$ConfigPath,
    [Parameter(Mandatory=$true)][string[]]$Arguments
  )
  & npx wrangler @Arguments --config $ConfigPath
  if ($LASTEXITCODE -ne 0) { throw "Wrangler failed: $($Arguments -join ' ')" }
}

function Set-WranglerSecret([string]$ConfigPath, [string]$Name, [string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Name cannot be empty." }
  $temp = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($temp, $Value)
    Get-Content -Raw $temp | & npx wrangler secret put $Name --config $ConfigPath
    if ($LASTEXITCODE -ne 0) { throw "Failed to set secret $Name." }
  } finally {
    Remove-Item $temp -Force -ErrorAction SilentlyContinue
  }
}

function Remove-WranglerSecret([string]$ConfigPath, [string]$Name) {
  $temp = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($temp, (@{ $Name = $null } | ConvertTo-Json))
    Get-Content -Raw $temp | & npx wrangler secret bulk --config $ConfigPath
    if ($LASTEXITCODE -ne 0) { throw "Failed to delete secret $Name." }
  } finally {
    Remove-Item $temp -Force -ErrorAction SilentlyContinue
  }
}

function Get-RulePayload($Rule) {
  $payload = [ordered]@{
    name = $Rule.name
    enabled = [bool]$Rule.enabled
    matchers = @($Rule.matchers)
    actions = @($Rule.actions)
  }
  if ($null -ne $Rule.priority) { $payload.priority = $Rule.priority }
  return ($payload | ConvertTo-Json -Depth 12)
}

function Get-AddressRules($Rules, [string]$Address) {
  return @($Rules) | Where-Object {
    @($_.matchers) | Where-Object {
      $_.type -eq "literal" -and $_.field -eq "to" -and $_.value -eq $Address
    }
  }
}

function Get-AllEmailRoutingRules([string]$Endpoint, [hashtable]$Headers) {
  $all = New-Object System.Collections.Generic.List[object]
  $pageNumber = 1
  do {
    $response = Invoke-RestMethod -Method Get -Uri "${Endpoint}?page=${pageNumber}&per_page=50" -Headers $Headers
    if (-not $response.success) { throw "Could not read Cloudflare Email Routing rules page $pageNumber." }
    foreach ($rule in @($response.result)) { $all.Add($rule) }
    $totalPages = if ($response.result_info -and $response.result_info.total_pages) {
      [int]$response.result_info.total_pages
    } else { 1 }
    $pageNumber += 1
  } while ($pageNumber -le $totalPages)
  return $all.ToArray()
}

function Get-AllResendWebhooks([hashtable]$Headers) {
  $all = New-Object System.Collections.Generic.List[object]
  $after = ""
  do {
    $uri = "https://api.resend.com/webhooks?limit=100"
    if ($after) { $uri += "&after=$([Uri]::EscapeDataString($after))" }
    $response = Invoke-RestMethod -Method Get -Uri $uri -Headers $Headers
    foreach ($webhook in @($response.data)) { $all.Add($webhook) }
    if (-not $response.has_more) { break }
    $last = @($response.data) | Select-Object -Last 1
    if (-not $last -or -not $last.id) { throw "Resend webhook pagination did not return a cursor." }
    $after = [string]$last.id
  } while ($true)
  return $all.ToArray()
}

function Assert-HttpOk([string]$Uri, [string]$Contains = "") {
  try {
    $response = Invoke-WebRequest -Method Get -Uri $Uri -UseBasicParsing
  } catch {
    $status = Get-HttpStatus $_
    throw "Health check failed for $Uri with HTTP $status."
  }
  if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
    throw "Health check failed for $Uri with HTTP $($response.StatusCode)."
  }
  if ($Contains -and $response.Content -notmatch [regex]::Escape($Contains)) {
    throw "Health check for $Uri did not contain expected content: $Contains"
  }
}

# Ruleset updates propagate to every edge point of presence gradually. Live GETs
# after install can observe stale origin 404 cache entries for well over a minute,
# so the verification polls for up to 120 seconds before failing.
function Assert-MainRedirect([string]$Uri, [string]$ExpectedLocation, [string]$Method = "Get", [int]$Retries = 24, [int]$DelaySeconds = 5) {
  $Method = $Method.ToUpperInvariant()
  $status = $null
  $location = ""
  for ($attempt = 1; $attempt -le $Retries; $attempt += 1) {
    if ($Method -eq "HEAD") {
      $headerDump = & curl -s -I --max-time 30 $Uri 2>$null
    } else {
      $headerDump = & curl -s -D - -o /dev/null --max-time 30 $Uri 2>$null
    }
    if ($LASTEXITCODE -ne 0) {
      if ($attempt -lt $Retries) { Start-Sleep -Seconds $DelaySeconds }
      continue
    }
    $status = $null
    $location = ""
    $statusMatch = [regex]::Match([string]::Join("`n", $headerDump), '(?im)^HTTP/\S+\s+(\d{3})\b')
    if ($statusMatch.Success) { $status = [int]$statusMatch.Groups[1].Value }
    $locationMatch = [regex]::Match([string]::Join("`n", $headerDump), '(?im)^location:\s*(.+?)\s*$')
    if ($locationMatch.Success) { $location = $locationMatch.Groups[1].Value.Trim() }
    if ($status -eq 308 -and $location -eq $ExpectedLocation) { return }
    if ($attempt -lt $Retries) { Start-Sleep -Seconds $DelaySeconds }
  }
  if ($status -ne 308) { throw "Expected $Method $Uri to return 308, received $status." }
  throw "Redirect target is incorrect. Expected $ExpectedLocation, received $location."
}

function Assert-MainNotRedirected([string]$Uri, [string]$Method) {
  $response = $null
  try {
    $response = Invoke-WebRequest -Method $Method -Uri $Uri -MaximumRedirection 0 -UseBasicParsing -ErrorAction Stop
  } catch {
    if ($_.Exception.Response) { $response = $_.Exception.Response } else { throw }
  }
  $status = [int]$response.StatusCode
  if ($status -eq 307 -or $status -eq 308) {
    throw "Expected $Method $Uri not to be redirected, received HTTP $status."
  }
}

function Write-DevConfig([string]$DatabaseId) {
  $config = Get-Content -Raw $DevTemplatePath | ConvertFrom-Json
  $config.name = $WorkerName
  $config.account_id = $AccountId
  $config.workers_dev = $true
  $config.d1_databases[0].database_name = $DatabaseName
  $config.d1_databases[0].database_id = $DatabaseId
  $config.r2_buckets[0].bucket_name = $BucketName
  $config.vars.ADMIN_EMAIL = $AdminEmail
  $config.vars.MAIL_DOMAIN = $Domain
  if ([string]::IsNullOrWhiteSpace($MailboxAddresses)) {
    $config.vars.PSObject.Properties.Remove("MAILBOX_ADDRESSES")
  } else {
    $config.vars.MAILBOX_ADDRESSES = $MailboxAddresses
  }
  $config.vars.PASSWORD_ITERATIONS = "8000"
  $config.vars.PSObject.Properties.Remove("APP_ORIGIN")
  if ([string]::IsNullOrWhiteSpace($ForwardTo)) {
    $config.vars.PSObject.Properties.Remove("INBOUND_FORWARD_TO")
  } else {
    $config.vars | Add-Member -NotePropertyName INBOUND_FORWARD_TO -NotePropertyValue $ForwardTo -Force
  }
  $config | ConvertTo-Json -Depth 30 | Set-Content -Encoding UTF8 $DevConfigPath
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

function New-AdminMailRedirectRule([string]$DevOrigin) {
  $matchExpression = "((http.request.method eq `"GET`" or http.request.method eq `"HEAD`") and http.host eq `"$Domain`" and (http.request.uri.path eq `"/admin/mail`" or starts_with(http.request.uri.path, `"/admin/mail/`")))"
  $targetExpression = "concat(`"$DevOrigin`", http.request.uri.path)"
  return [ordered]@{
    ref = $RedirectRuleRef
    description = "Main admin mail entry to canonical mailbox"
    expression = $matchExpression
    action = "redirect"
    action_parameters = @{
      from_value = @{
        target_url = @{ expression = $targetExpression }
        status_code = 308
        preserve_query_string = $true
      }
    }
    enabled = $true
  }
}

function Get-ManagedRedirectRules($Entrypoint) {
  if (-not $Entrypoint) { return @() }
  return @($Entrypoint.result.rules) | Where-Object { [string]$_.ref -eq $RedirectRuleRef }
}

function Save-AdminMailRedirectBackup([string]$Directory, [hashtable]$Headers) {
  $entrypoint = Get-DynamicRedirectEntrypoint $Headers
  $rules = @()
  $managed = @()
  if ($entrypoint) {
    foreach ($rule in @($entrypoint.result.rules) | Where-Object { $null -ne $_ }) {
      $rules += ConvertTo-RulesetRulePayload $rule
    }
    $managed = @(Get-ManagedRedirectRules $entrypoint)
    if ($managed.Count -gt 1) {
      throw "Multiple redirect rules use ref $RedirectRuleRef. No redirect changes were made."
    }
  }
  $backup = [ordered]@{
    schema_version = 1
    complete = $true
    captured_at = (Get-Date).ToUniversalTime().ToString("o")
    zone_id = $ZoneId
    phase = $RedirectPhase
    managed_ref = $RedirectRuleRef
    entrypoint_exists = [bool]$entrypoint
    ruleset_id = if ($entrypoint) { [string]$entrypoint.result.id } else { "" }
    description = if ($entrypoint) { [string]$entrypoint.result.description } else { "" }
    rules = @($rules)
    managed_rule_present = ($managed.Count -eq 1)
    managed_rule = if ($managed.Count -eq 1) { ConvertTo-RulesetRulePayload $managed[0] } else { $null }
  }
  $path = Join-Path $Directory "admin-mail-redirect-ruleset.json"
  $backup | ConvertTo-Json -Depth 50 | Set-Content -Encoding UTF8 $path
  return $backup
}

function Set-AdminMailRedirectRule([string]$DevOrigin, [hashtable]$Headers) {
  $entrypoint = Get-DynamicRedirectEntrypoint $Headers
  $desired = New-AdminMailRedirectRule $DevOrigin
  if (-not $entrypoint) {
    $body = @{
      description = "Zone-level dynamic redirects"
      rules = @($desired)
    } | ConvertTo-Json -Depth 50
    $result = Invoke-RestMethod -Method Put -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/rulesets/phases/$RedirectPhase/entrypoint" -Headers $Headers -Body $body
  } else {
    $matches = @(Get-ManagedRedirectRules $entrypoint)
    if ($matches.Count -gt 1) {
      throw "Multiple redirect rules use ref $RedirectRuleRef. Refusing an ambiguous update."
    }
    $rulesetId = [string]$entrypoint.result.id
    if ($matches.Count -eq 1) {
      $ruleId = [string]$matches[0].id
      $result = Invoke-RestMethod -Method Patch -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/rulesets/$rulesetId/rules/$ruleId" -Headers $Headers -Body ($desired | ConvertTo-Json -Depth 50)
    } else {
      $result = Invoke-RestMethod -Method Post -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/rulesets/$rulesetId/rules" -Headers $Headers -Body ($desired | ConvertTo-Json -Depth 50)
    }
  }
  if (-not $result.success) { throw "Cloudflare did not accept the admin mail Single Redirect rule." }

  $verified = Get-DynamicRedirectEntrypoint $Headers
  $verifiedMatches = @(Get-ManagedRedirectRules $verified)
  if ($verifiedMatches.Count -ne 1) { throw "The managed admin mail redirect rule is not unique after update." }
  $rule = $verifiedMatches[0]
  $fromValue = $rule.action_parameters.from_value
  if (
    [string]$rule.expression -ne [string]$desired.expression -or
    $rule.action -ne "redirect" -or
    [int]$fromValue.status_code -ne 308 -or
    -not [bool]$fromValue.preserve_query_string -or
    [string]$fromValue.target_url.expression -ne "concat(`"$DevOrigin`", http.request.uri.path)"
  ) {
    throw "The managed admin mail redirect rule does not match the required GET/HEAD-only 308 path-preserving configuration."
  }
}

function Restore-AdminMailRedirectBackup($Backup, [hashtable]$Headers) {
  if (-not $Backup.complete -or $Backup.zone_id -ne $ZoneId -or $Backup.phase -ne $RedirectPhase -or $Backup.managed_ref -ne $RedirectRuleRef) {
    throw "The admin mail redirect backup is incomplete or belongs to another zone/phase."
  }
  $entrypoint = Get-DynamicRedirectEntrypoint $Headers
  $matches = @(Get-ManagedRedirectRules $entrypoint)
  if ($matches.Count -gt 1) { throw "Cannot restore while duplicate managed redirect refs exist." }

  if ([bool]$Backup.managed_rule_present) {
    $savedRule = ConvertTo-RulesetRulePayload $Backup.managed_rule
    if (-not $entrypoint) {
      $body = @{ description = "Zone-level dynamic redirects"; rules = @($savedRule) } | ConvertTo-Json -Depth 50
      $result = Invoke-RestMethod -Method Put -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/rulesets/phases/$RedirectPhase/entrypoint" -Headers $Headers -Body $body
    } elseif ($matches.Count -eq 1) {
      $result = Invoke-RestMethod -Method Patch -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/rulesets/$($entrypoint.result.id)/rules/$($matches[0].id)" -Headers $Headers -Body ($savedRule | ConvertTo-Json -Depth 50)
    } else {
      $result = Invoke-RestMethod -Method Post -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/rulesets/$($entrypoint.result.id)/rules" -Headers $Headers -Body ($savedRule | ConvertTo-Json -Depth 50)
    }
    if (-not $result.success) { throw "Failed to restore the previous managed admin mail redirect rule." }
  } elseif ($entrypoint -and $matches.Count -eq 1) {
    $result = Invoke-RestMethod -Method Delete -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/rulesets/$($entrypoint.result.id)/rules/$($matches[0].id)" -Headers $Headers
    if (-not $result.success) { throw "Failed to remove the newly added admin mail redirect rule." }
  }
}

function Remove-LegacyRedirectWorker([hashtable]$Headers) {
  $probeUri = "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/scripts/$LegacyRedirectWorkerName"
  $deleteUri = "$($probeUri)?force=true"
  $exists = $false
  try {
    Invoke-RestMethod -Method Get -Uri $probeUri -Headers $Headers | Out-Null
    $exists = $true
  } catch {
    if ((Get-HttpStatus $_) -ne 404) {
      throw "Could not verify the legacy redirect Worker state: $($_.Exception.Message)"
    }
  }
  if (-not $exists) {
    Write-Host "  Legacy redirect Worker is already absent."
    return
  }
  try {
    Invoke-RestMethod -Method Delete -Uri $deleteUri -Headers $Headers | Out-Null
    Write-Host "  Removed legacy Worker: $LegacyRedirectWorkerName"
  } catch {
    $deleteStatus = Get-HttpStatus $_
    if ($deleteStatus -eq 404 -or $deleteStatus -eq 400) {
      Write-Host "  Legacy redirect Worker is already absent (HTTP $deleteStatus)."
      return
    }
    throw "The Single Redirect works, but the legacy redirect Worker could not be removed: $($_.Exception.Message)"
  }
}

$cloudflareApiToken = $null
$resendSetupPlaintext = $null
$resendSendingPlaintext = $null
$adminPasswordPlaintext = $null
$webhookSecret = $null
$bootstrapToken = $null

try {
Write-Host "[1/14] Installing locked dependencies and validating the canonical mailbox Worker..."
if (-not (Test-Path "package-lock.json")) { throw "package-lock.json is required for production provisioning." }
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
npm run check
if ($LASTEXITCODE -ne 0) { throw "Mailbox validation failed." }

Write-Host "[2/14] Checking Cloudflare authentication..."
Invoke-Wrangler -ConfigPath $DevTemplatePath -Arguments @("whoami")

Write-Host "[3/14] Resolving the single canonical dev D1 and R2 resources..."
$databases = (& npx wrangler d1 list --json --config $DevTemplatePath | ConvertFrom-Json)
$db = $databases | Where-Object { $_.name -eq $DatabaseName } | Select-Object -First 1
if (-not $db) {
  Invoke-Wrangler -ConfigPath $DevTemplatePath -Arguments @("d1", "create", $DatabaseName, "--location", "enam")
  $databases = (& npx wrangler d1 list --json --config $DevTemplatePath | ConvertFrom-Json)
  $db = $databases | Where-Object { $_.name -eq $DatabaseName } | Select-Object -First 1
}
$databaseId = if ($db.uuid) { [string]$db.uuid } elseif ($db.id) { [string]$db.id } else { "" }
if (-not $databaseId) { throw "Could not resolve the dev D1 database UUID." }
Write-DevConfig $databaseId

$r2List = (& npx wrangler r2 bucket list --config $DevConfigPath 2>&1 | Out-String)
if ($r2List -notmatch [regex]::Escape($BucketName)) {
  Invoke-Wrangler -ConfigPath $DevConfigPath -Arguments @("r2", "bucket", "create", $BucketName)
}
Invoke-Wrangler -ConfigPath $DevConfigPath -Arguments @("d1", "migrations", "apply", "DB", "--remote")

Write-Host "[4/14] Collecting scoped credentials (input is not echoed)..."
Write-Host "  Cloudflare token: Workers Scripts Read/Write, Dynamic URL Redirects Write, and Email Routing Rules Read/Write for this account/zone."
$cloudflareApiToken = Resolve-RequiredSecret $CloudflareDeployToken "Cloudflare automation API token"
if ($null -ne $ResendSetupKey) {
  Write-Host "  Resend setup key: temporary Full Access key supplied; Resend domain/webhook management will be reconciled."
  $resendSetupPlaintext = Resolve-RequiredSecret $ResendSetupKey "Temporary Resend Full Access key"
} else {
  Write-Host "  Resend setup key: not supplied; preserving existing verified domain/webhook configuration."
}
Write-Host "  Resend runtime key: Sending Access restricted to $Domain."
$resendSendingPlaintext = Resolve-RequiredSecret $ResendSendingKey "Resend Sending Access key"
$adminPasswordPlaintext = Resolve-RequiredSecret $AdminPasswordSecure "Mailbox administrator password"

Write-Host "[5/14] Creating or updating the dev Worker before non-interactive secret writes..."
Invoke-Wrangler -ConfigPath $DevConfigPath -Arguments @("deploy")

Write-Host "[6/14] Resolving and validating the workers.dev origin..."
$cfHeaders = @{ Authorization = "Bearer $cloudflareApiToken"; "Content-Type" = "application/json" }
$subdomainResponse = Invoke-RestMethod -Method Get -Uri "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/subdomain" -Headers $cfHeaders
if (-not $subdomainResponse.success -or -not $subdomainResponse.result.subdomain) {
  throw "Could not resolve the account workers.dev subdomain."
}
$workersSubdomain = [string]$subdomainResponse.result.subdomain
$devOrigin = "https://$WorkerName.$workersSubdomain.workers.dev"
$workerSubdomain = Invoke-RestMethod -Method Get -Uri "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/scripts/$WorkerName/subdomain" -Headers $cfHeaders
if (-not $workerSubdomain.success -or -not $workerSubdomain.result.enabled) {
  throw "The dev Worker is not enabled on workers.dev."
}
Write-Host "  Dev mailbox origin: $devOrigin"

Write-Host "[7/14] Configuring dev Worker secrets without rotating an existing AUTH_PEPPER..."
$secretListRaw = (& npx wrangler secret list --format json --config $DevConfigPath 2>$null | Out-String)
$secretList = if ($secretListRaw.Trim()) { $secretListRaw | ConvertFrom-Json } else { @() }
$hasAuthPepper = @($secretList) | Where-Object { $_.name -eq "AUTH_PEPPER" } | Select-Object -First 1
if (-not $hasAuthPepper) { Set-WranglerSecret $DevConfigPath "AUTH_PEPPER" (New-RandomSecret 48) }
$bootstrapToken = New-RandomSecret 32
Set-WranglerSecret $DevConfigPath "ADMIN_BOOTSTRAP_TOKEN" $bootstrapToken
Set-WranglerSecret $DevConfigPath "RESEND_API_KEY" $resendSendingPlaintext

if ($resendSetupPlaintext) {
  Write-Host "[8/14] Verifying the Resend domain and reconciling exactly one dev webhook..."
  $resendHeaders = @{ Authorization = "Bearer $resendSetupPlaintext"; "Content-Type" = "application/json" }
  $domains = Invoke-RestMethod -Method Get -Uri "https://api.resend.com/domains" -Headers $resendHeaders
  $domainRecord = @($domains.data) | Where-Object { $_.name -eq $Domain } | Select-Object -First 1
  if (-not $domainRecord -or $domainRecord.status -ne "verified") {
    throw "Resend domain $Domain is not verified. Verify it, then rerun this script."
  }
  $webhookUrl = "$devOrigin/webhooks/resend"
  $desiredWebhookEvents = @(
    "email.sent", "email.delivered", "email.delivery_delayed", "email.bounced",
    "email.complained", "email.opened", "email.clicked", "email.failed", "email.suppressed"
  )
  $webhooks = Get-AllResendWebhooks $resendHeaders
  $matchingWebhooks = @($webhooks | Where-Object { $_.endpoint -eq $webhookUrl })
  if ($matchingWebhooks.Count -gt 1) {
    throw "Multiple Resend webhooks target $webhookUrl. Remove duplicates before provisioning."
  }
  $webhookSecret = ""
  if ($matchingWebhooks.Count -eq 1) {
    $webhookId = [string]$matchingWebhooks[0].id
    $webhook = Invoke-RestMethod -Method Get -Uri "https://api.resend.com/webhooks/$webhookId" -Headers $resendHeaders
    $webhookSecret = [string]$webhook.signing_secret
    $updateWebhookBody = @{ endpoint = $webhookUrl; events = $desiredWebhookEvents; status = "enabled" } | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Method Patch -Uri "https://api.resend.com/webhooks/$webhookId" -Headers $resendHeaders -Body $updateWebhookBody | Out-Null
  } else {
    $createWebhookBody = @{ endpoint = $webhookUrl; events = $desiredWebhookEvents } | ConvertTo-Json -Depth 5
    $webhook = Invoke-RestMethod -Method Post -Uri "https://api.resend.com/webhooks" -Headers $resendHeaders -Body $createWebhookBody
    $webhookSecret = [string]$webhook.signing_secret
  }
  if ([string]::IsNullOrWhiteSpace($webhookSecret)) { throw "A Resend webhook signing secret is required." }
  Set-WranglerSecret $DevConfigPath "RESEND_WEBHOOK_SECRET" $webhookSecret
} else {
  Write-Host "[8/14] Preserving Resend management state under least privilege..."
  $hasWebhookSecret = @($secretList) | Where-Object { $_.name -eq "RESEND_WEBHOOK_SECRET" } | Select-Object -First 1
  if (-not $hasWebhookSecret) {
    throw "RESEND_WEBHOOK_SECRET is absent. Supply RESEND_SETUP_FULL_ACCESS_KEY for one guarded deployment to reconcile the verified Resend domain/webhook before routine least-privilege deploys."
  }
  Write-Host "  Existing RESEND_WEBHOOK_SECRET is present; domain/webhook management was not invoked."
}

Write-Host "[9/14] Running dev health, authentication, and real D1/R2 probes..."
Assert-HttpOk "$devOrigin/healthz" '"ok":true'
Assert-HttpOk "$devOrigin/admin/mail/" "MailGable"
$bootstrapHeaders = @{ "X-Bootstrap-Token" = $bootstrapToken; "Content-Type" = "application/json"; Origin = $devOrigin }
$bootstrapBody = @{ email = $AdminEmail; password = $adminPasswordPlaintext } | ConvertTo-Json
try {
  Invoke-RestMethod -Method Post -Uri "$devOrigin/api/admin/mail/auth/bootstrap" -Headers $bootstrapHeaders -Body $bootstrapBody | Out-Null
} catch {
  if ((Get-HttpStatus $_) -ne 409) { throw }
  Write-Host "  Administrator already exists; validating the supplied existing password."
}
$webSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$loginHeaders = @{ "Content-Type" = "application/json"; Origin = $devOrigin }
$loginBody = @{ email = $AdminEmail; password = $adminPasswordPlaintext } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri "$devOrigin/api/admin/mail/auth/login" -Headers $loginHeaders -Body $loginBody -WebSession $webSession
if (-not $login.authenticated -or -not $login.csrf_token) { throw "Administrator login smoke test failed." }
$configStatus = Invoke-RestMethod -Method Get -Uri "$devOrigin/api/admin/mail/config" -WebSession $webSession
if (
  $configStatus.deployment -ne "mailgable" -or
  -not $configStatus.database -or -not $configStatus.archive -or
  -not $configStatus.resend -or -not $configStatus.webhook -or
  -not $configStatus.auth -or $configStatus.mailboxes -lt 3
) { throw "Authenticated dev configuration smoke test failed." }
$probeHeaders = @{ "Content-Type" = "application/json"; Origin = $devOrigin; "X-CSRF-Token" = $login.csrf_token }
$probe = Invoke-RestMethod -Method Post -Uri "$devOrigin/api/admin/mail/ops/storage-probe" -Headers $probeHeaders -Body "{}" -WebSession $webSession
if (-not $probe.ok -or -not $probe.database_read_write_delete -or -not $probe.archive_read_write_delete) {
  throw "D1/R2 readiness probe failed."
}

Write-Host "[10/14] Sending a real Resend smoke email and waiting for its signed webhook..."
$sendHeaders = @{
  "Content-Type" = "application/json"
  Origin = $devOrigin
  "X-CSRF-Token" = $login.csrf_token
  "Idempotency-Key" = "provision/$([guid]::NewGuid())"
}
$sendBody = @{
  from_mailbox_id = "support"
  to = $AdminEmail
  subject = "MailGable dev production-readiness smoke test"
  text = "This message verifies the canonical dev Resend path and signed webhook."
  html = "<p>This message verifies the canonical dev Resend path and signed webhook.</p>"
  attachments = @()
} | ConvertTo-Json -Depth 5
$sent = Invoke-RestMethod -Method Post -Uri "$devOrigin/api/admin/mail/messages/send" -Headers $sendHeaders -Body $sendBody -WebSession $webSession
if ($sent.status -ne "sent" -or -not $sent.message_id -or -not $sent.thread_id) {
  throw "Outbound smoke test did not return a sent message."
}
$webhookObserved = $false
for ($attempt = 1; $attempt -le 12; $attempt += 1) {
  Start-Sleep -Seconds 5
  $detail = Invoke-RestMethod -Method Get -Uri "$devOrigin/api/admin/mail/threads/$($sent.thread_id)?limit=100" -WebSession $webSession
  $event = @($detail.events) | Where-Object { $_.message_id -eq $sent.message_id } | Select-Object -First 1
  if ($event) { $webhookObserved = $true; break }
}
if (-not $webhookObserved) {
  throw "No signed Resend webhook was observed for the smoke-test message within 60 seconds."
}

Write-Host "[11/14] Removing the one-time bootstrap secret..."
Remove-WranglerSecret $DevConfigPath "ADMIN_BOOTSTRAP_TOKEN"

Write-Host "[12/14] Installing the main-domain Single Redirect and removing the legacy redirect Worker..."
$backupDir = Join-Path (Join-Path (Get-Location) "deployment-backups") (Get-Date -Format "yyyyMMdd-HHmmss")
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$redirectBackup = Save-AdminMailRedirectBackup $backupDir $cfHeaders
try {
  Set-AdminMailRedirectRule $devOrigin $cfHeaders
  Assert-MainRedirect "https://$Domain/admin/mail" "$devOrigin/admin/mail" "Get"
  Assert-MainRedirect "https://$Domain/admin/mail" "$devOrigin/admin/mail" "Head"
  Assert-MainRedirect "https://$Domain/admin/mail/assets/check.js?source=provision" "$devOrigin/admin/mail/assets/check.js?source=provision" "Get"
  Assert-MainNotRedirected "https://$Domain/admin/mail" "Post"
  Assert-HttpOk "https://$Domain/" ""
  Remove-LegacyRedirectWorker $cfHeaders
} catch {
  Write-Warning "Admin mail redirect setup failed. Restoring the previous managed redirect state..."
  try { Restore-AdminMailRedirectBackup $redirectBackup $cfHeaders }
  catch { Write-Warning "Automatic redirect rollback failed. Use $backupDir/admin-mail-redirect-ruleset.json." }
  throw
}
Write-Host "  Single Redirect backup: $backupDir/admin-mail-redirect-ruleset.json"

if (-not $SkipEmailRouting) {
  Write-Host "[13/14] Backing up and switching all three inbound addresses to the dev Worker..."
  $rulesEndpoint = "https://api.cloudflare.com/client/v4/zones/$ZoneId/email/routing/rules"
  $currentRules = Get-AllEmailRoutingRules $rulesEndpoint $cfHeaders
  foreach ($localPart in @("support", "contact", "privacy")) {
    $address = "$localPart@$Domain"
    $matches = @(Get-AddressRules $currentRules $address)
    if ($matches.Count -gt 1) {
      throw "Multiple Email Routing rules already match $address. No routing changes were made; remove duplicates and rerun."
    }
  }

  $backup = [ordered]@{
    success = $true
    result = @($currentRules)
    result_info = @{ count = @($currentRules).Count; complete = $true }
  }
  $backup | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 (Join-Path $backupDir "email-routing-rules.json")
  Write-Host "  Complete routing backup: $backupDir/email-routing-rules.json"

  $updatedRules = New-Object System.Collections.Generic.List[object]
  $createdRuleIds = New-Object System.Collections.Generic.List[string]
  try {
    foreach ($localPart in @("support", "contact", "privacy")) {
      $address = "$localPart@$Domain"
      $rule = @(Get-AddressRules $currentRules $address) | Select-Object -First 1
      $payload = @{
        name = "MailGable dev - $address"
        enabled = $true
        matchers = @(@{ type = "literal"; field = "to"; value = $address })
        actions = @(@{ type = "worker"; value = @($WorkerName) })
      } | ConvertTo-Json -Depth 8
      if ($rule) {
        $updatedRules.Add($rule)
        $result = Invoke-RestMethod -Method Put -Uri "$rulesEndpoint/$($rule.id)" -Headers $cfHeaders -Body $payload
      } else {
        $result = Invoke-RestMethod -Method Post -Uri $rulesEndpoint -Headers $cfHeaders -Body $payload
        if ($result.result.id) { $createdRuleIds.Add([string]$result.result.id) }
      }
      if (-not $result.success) { throw "Failed to configure routing for $address." }
      Write-Host "  Routed $address -> $WorkerName"
    }

    $finalRules = Get-AllEmailRoutingRules $rulesEndpoint $cfHeaders
    foreach ($localPart in @("support", "contact", "privacy")) {
      $address = "$localPart@$Domain"
      $matches = @(Get-AddressRules $finalRules $address)
      $targets = @($matches | ForEach-Object { @($_.actions) | Where-Object { $_.type -eq "worker" } | ForEach-Object { @($_.value) } })
      if ($matches.Count -ne 1 -or $targets.Count -ne 1 -or $targets[0] -ne $WorkerName) {
        throw "Final Email Routing verification failed for $address."
      }
    }
  } catch {
    Write-Warning "Inbound route update or verification failed. Restoring previous managed rules..."
    foreach ($id in $createdRuleIds) {
      try { Invoke-RestMethod -Method Delete -Uri "$rulesEndpoint/$id" -Headers $cfHeaders | Out-Null }
      catch { Write-Warning "Could not delete newly created rule $id" }
    }
    foreach ($rule in $updatedRules) {
      try { Invoke-RestMethod -Method Put -Uri "$rulesEndpoint/$($rule.id)" -Headers $cfHeaders -Body (Get-RulePayload $rule) | Out-Null }
      catch { Write-Warning "Could not restore rule $($rule.id). Use the complete backup in $backupDir." }
    }
    throw
  }
} else {
  Write-Host "[13/14] Email Routing switch skipped. Dev mailbox and method-safe Single Redirect are deployed and verified."
}

Write-Host "[14/14] Provisioning complete."
Write-Host ""
Write-Host "Canonical mailbox: $devOrigin/admin/mail/"
Write-Host "Main entry: https://$Domain/admin/mail (Cloudflare Single Redirect, GET/HEAD only, HTTP 308)"
Write-Host "Canonical Worker: $WorkerName"
Write-Host "Canonical D1: $DatabaseName"
Write-Host "Canonical R2: $BucketName"
Write-Host "Mailbox addresses: $([string]::IsNullOrWhiteSpace($MailboxAddresses) ? 'none configured - create mailbox identities after bootstrap' : $MailboxAddresses)"
Write-Host "Legacy redirect Worker: removed"
if ($resendSetupPlaintext) {
  Write-Host "Delete the temporary Resend Full Access key after acceptance; routine deploys no longer require it."
} else {
  Write-Host "Routine deployment completed without using a Resend Full Access key."
}
Write-Host "Required final acceptance: test real inbound mail, attachments, Reply-To, and threading for all three addresses."
} finally {
  $resendSetupPlaintext = $null
  $resendSendingPlaintext = $null
  $adminPasswordPlaintext = $null
  $webhookSecret = $null
  $bootstrapToken = $null
  $cloudflareApiToken = $null
}
