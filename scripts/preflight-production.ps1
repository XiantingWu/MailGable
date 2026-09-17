[CmdletBinding()]
param(
  [ValidateSet("before-stage","after-stage","after-cutover")]
  [string]$Phase = "before-stage",
  [string]$AccountId = "",
  [string]$ZoneId = "",
  [string]$Domain = "example.com",
  [string]$WorkerName = "mailgable-dev",
  [string]$DatabaseName = "mailgable-dev",
  [string]$BucketName = "mailgable-dev",
  [string[]]$LegacyWorkers = @("mailgable", "mailgable-redirect"),
  [string[]]$LegacyDatabases = @("mailgable"),
  [string[]]$LegacyBuckets = @("mailgable-production", "mailgable"),
  [string]$OutputPath = "",
  [Security.SecureString]$CloudflareReadToken,
  [Security.SecureString]$ResendSetupKey
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$RedirectPhase = "http_request_dynamic_redirect"
$RedirectRuleRef = "mailbox_admin_mail_to_dev"
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
function Get-HttpStatus($ErrorRecord) {
  if ($ErrorRecord.Exception.Response) { return [int]$ErrorRecord.Exception.Response.StatusCode }
  return 0
}
function Add-Check(
  [System.Collections.Generic.List[object]]$Checks,
  [string]$Name,
  [bool]$Pass,
  [string]$Detail,
  [bool]$Blocking = $true
) {
  $Checks.Add([ordered]@{ name=$Name; pass=$Pass; blocking=$Blocking; detail=$Detail })
  $label = if ($Pass) { "PASS" } elseif ($Blocking) { "BLOCK" } else { "WARN" }
  Write-Host ("{0,-7} {1}: {2}" -f $label, $Name, $Detail)
}
function Invoke-Cf([string]$Method, [string]$Uri, [hashtable]$Headers, [switch]$AllowNotFound) {
  try {
    $response = Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers
    if ($null -ne $response.success -and -not $response.success) { throw "Cloudflare request failed: $Uri" }
    return $response
  } catch {
    if ($AllowNotFound -and (Get-HttpStatus $_) -eq 404) { return $null }
    throw
  }
}
function Get-AllEmailRoutingRules([hashtable]$Headers) {
  $all = New-Object System.Collections.Generic.List[object]
  $page = 1
  do {
    $response = Invoke-Cf Get "https://api.cloudflare.com/client/v4/zones/$ZoneId/email/routing/rules?page=$page&per_page=50" $Headers
    foreach ($item in @($response.result)) { $all.Add($item) }
    $pages = if ($response.result_info -and $response.result_info.total_pages) { [int]$response.result_info.total_pages } else { 1 }
    $page += 1
  } while ($page -le $pages)
  return $all.ToArray()
}
function Get-AllR2Buckets([hashtable]$Headers) {
  $all = New-Object System.Collections.Generic.List[object]
  $cursor = ""
  do {
    $uri = "https://api.cloudflare.com/client/v4/accounts/$AccountId/r2/buckets?per_page=1000"
    if ($cursor) { $uri += "&cursor=$([Uri]::EscapeDataString($cursor))" }
    $response = Invoke-Cf Get $uri $Headers
    foreach ($item in @($response.result.buckets)) { $all.Add($item) }
    $next = ""
    if ($response.result -and $response.result.PSObject.Properties["cursor"]) { $next = [string]$response.result.cursor }
    elseif ($response.result_info -and $response.result_info.PSObject.Properties["cursor"]) { $next = [string]$response.result_info.cursor }
    if (-not $next -or $next -eq $cursor) { break }
    $cursor = $next
  } while ($true)
  return $all.ToArray()
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
function Get-LiteralAddressRules([object[]]$Rules, [string]$Address) {
  return @($Rules | Where-Object {
    @($_.matchers) | Where-Object { $_.type -eq "literal" -and $_.field -eq "to" -and $_.value -eq $Address }
  })
}
function Get-HttpSnapshot([string]$Uri, [string]$Method = "Get") {
  $Method = $Method.ToUpperInvariant()
  $response = $null
  $redirectProbe = $false
  $redirectStatus = 0
  try {
    $response = Invoke-WebRequest -Method $Method -Uri $Uri -MaximumRedirection 0 -UseBasicParsing -ErrorAction Stop
  } catch {
    if ($_.Exception.Response) {
      $redirectStatus = [int]$_.Exception.Response.StatusCode
      if ($redirectStatus -ge 300 -and $redirectStatus -lt 400) { $redirectProbe = $true }
      else { $response = $_.Exception.Response }
    } else {
      return [ordered]@{ uri=$Uri; method=$Method; status=0; location=""; content=""; error=$_.Exception.Message }
    }
  }
  $content = ""
  try { $content = [string]$response.Content } catch { }
  $location = ""
  if ($redirectProbe) {
    $headerDump = & curl -s -D - -o /dev/null -X $Method --max-time 25 $Uri 2>$null
    $locationMatch = [regex]::Match([string]::Join("`n", $headerDump), '(?im)^location:\s*(.+?)\s*$')
    if ($locationMatch.Success) { $location = $locationMatch.Groups[1].Value.Trim() }
  } else {
    $location = [string]$response.Headers["Location"]
  }
  return [ordered]@{
    uri=$Uri
    method=$Method
    status=$(if ($redirectProbe) { $redirectStatus } else { [int]$response.StatusCode })
    location=$location
    content=$content.Substring(0,[Math]::Min($content.Length,2000))
    error=""
  }
}

Write-Host "MailGable production preflight: $Phase"
Write-Host "This command is read-only. No Cloudflare or Resend resource is modified."
& npx wrangler whoami --config wrangler.jsonc
if ($LASTEXITCODE -ne 0) { throw "Wrangler authentication failed." }

try {
  $cfToken = if ($null -ne $CloudflareReadToken) {
    ConvertFrom-Secure $CloudflareReadToken
  } else {
    Read-Secret "Cloudflare read token"
  }
  $resendKey = if ($null -ne $ResendSetupKey) { ConvertFrom-Secure $ResendSetupKey } else { "" }
  $cfHeaders = @{ Authorization="Bearer $cfToken"; "Content-Type"="application/json" }
  $resendHeaders = if ($resendKey) { @{ Authorization="Bearer $resendKey"; "Content-Type"="application/json" } } else { $null }
  $checks = New-Object System.Collections.Generic.List[object]
  $staged = $Phase -ne "before-stage"
  $cutover = $Phase -eq "after-cutover"

  $scriptsResponse = Invoke-Cf Get "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/scripts" $cfHeaders
  $workerNames = @($scriptsResponse.result | ForEach-Object { [string]$_.id })
  $canonicalWorkerExists = $workerNames -contains $WorkerName
  Add-Check $checks "canonical_worker" (-not $staged -or $canonicalWorkerExists) ($(if ($canonicalWorkerExists) { "Present" } else { "Absent" })) $staged
  $legacyWorkerHits = @($LegacyWorkers | Where-Object { $workerNames -contains $_ })
  Add-Check $checks "legacy_workers_absent" (-not $cutover -or $legacyWorkerHits.Count -eq 0) ($(if ($legacyWorkerHits.Count) { "Found: $($legacyWorkerHits -join ', ')" } else { "None" })) $cutover

  $routesResponse = Invoke-Cf Get "https://api.cloudflare.com/client/v4/zones/$ZoneId/workers/routes" $cfHeaders
  $domainPattern = [regex]::Escape($Domain)
  $mailRoutes = @($routesResponse.result | Where-Object { [string]$_.pattern -match "^(?:https?://)?$domainPattern/(admin/mail|api/admin/mail)(?:/|\*|$)" })
  Add-Check $checks "main_mail_worker_routes_absent" (-not $cutover -or $mailRoutes.Count -eq 0) ($(if ($mailRoutes.Count) { ($mailRoutes | ForEach-Object { "$($_.pattern) -> $($_.script)" }) -join '; ' } else { "None" })) $cutover

  $databases = @(& npx wrangler d1 list --json --config wrangler.jsonc | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0) { throw "Could not list D1 databases." }
  $dbNames = @($databases | ForEach-Object { [string]$_.name })
  $canonicalDbExists = $dbNames -contains $DatabaseName
  Add-Check $checks "canonical_d1" (-not $staged -or $canonicalDbExists) ($(if ($canonicalDbExists) { "Present" } else { "Absent" })) $staged
  $legacyDbHits = @($LegacyDatabases | Where-Object { $dbNames -contains $_ })
  Add-Check $checks "legacy_d1_inventory" $true ($(if ($legacyDbHits.Count) { "Found: $($legacyDbHits -join ', '); preserve until an explicit data decision" } else { "None" })) $false

  $r2Buckets = Get-AllR2Buckets $cfHeaders
  $r2Names = @($r2Buckets | ForEach-Object { [string]$_.name })
  $canonicalBucketExists = $r2Names -contains $BucketName
  Add-Check $checks "canonical_r2" (-not $staged -or $canonicalBucketExists) ($(if ($canonicalBucketExists) { "Present" } else { "Absent" })) $staged
  $legacyBucketHits = @($LegacyBuckets | Where-Object { $r2Names -contains $_ })
  Add-Check $checks "legacy_r2_inventory" $true ($(if ($legacyBucketHits.Count) { "Found: $($legacyBucketHits -join ', '); preserve until an explicit data decision" } else { "None" })) $false

  $subdomainResponse = Invoke-Cf Get "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/subdomain" $cfHeaders -AllowNotFound
  $workersSubdomain = if ($subdomainResponse) { [string]$subdomainResponse.result.subdomain } else { "" }
  $canonicalOrigin = if ($workersSubdomain) { "https://$WorkerName.$workersSubdomain.workers.dev" } else { "" }
  $health = if ($canonicalOrigin) { Get-HttpSnapshot "$canonicalOrigin/healthz" } else { $null }
  Add-Check $checks "canonical_health" (-not $staged -or ($health -and $health.status -eq 200 -and $health.content -match '"ok"\s*:\s*true')) "HTTP $($health.status)" $staged

  $redirectEntry = Invoke-Cf Get "https://api.cloudflare.com/client/v4/zones/$ZoneId/rulesets/phases/$RedirectPhase/entrypoint" $cfHeaders -AllowNotFound
  $managedRedirects = if ($redirectEntry) { @($redirectEntry.result.rules | Where-Object { [string]$_.ref -eq $RedirectRuleRef }) } else { @() }
  $expectedExpression = "((http.request.method eq `"GET`" or http.request.method eq `"HEAD`") and http.host eq `"$Domain`" and (http.request.uri.path eq `"/admin/mail`" or starts_with(http.request.uri.path, `"/admin/mail/`")))"
  $expectedTarget = if ($canonicalOrigin) { "concat(`"$canonicalOrigin`", http.request.uri.path)" } else { "" }
  $redirectValid = $managedRedirects.Count -eq 1 -and
    [string]$managedRedirects[0].expression -eq $expectedExpression -and
    [string]$managedRedirects[0].action -eq "redirect" -and
    [int]$managedRedirects[0].action_parameters.from_value.status_code -eq 308 -and
    [bool]$managedRedirects[0].action_parameters.from_value.preserve_query_string -and
    [string]$managedRedirects[0].action_parameters.from_value.target_url.expression -eq $expectedTarget
  Add-Check $checks "managed_redirect" (-not $staged -or $redirectValid) "matches=$($managedRedirects.Count); valid=$redirectValid" $staged

  $mainGet = Get-HttpSnapshot "https://$Domain/admin/mail"
  $mainPost = Get-HttpSnapshot "https://$Domain/admin/mail" "Post"
  Add-Check $checks "main_redirect_get" (-not $staged -or ($mainGet.status -eq 308 -and $mainGet.location -eq "$canonicalOrigin/admin/mail")) "HTTP $($mainGet.status); Location=$($mainGet.location)" $staged
  Add-Check $checks "main_redirect_post_blocked" (-not $staged -or ($mainPost.status -ne 307 -and $mainPost.status -ne 308)) "HTTP $($mainPost.status)" $staged

  $rules = Get-AllEmailRoutingRules $cfHeaders
  $routingInventory = @()
  foreach ($local in @("support", "contact", "privacy")) {
    $address = "$local@$Domain"
    $matches = @(Get-LiteralAddressRules $rules $address)
    $targets = @($matches | ForEach-Object { @($_.actions) | Where-Object { $_.type -eq "worker" } | ForEach-Object { @($_.value) } })
    $routingInventory += [ordered]@{ address=$address; count=$matches.Count; targets=@($targets) }
    $correct = $matches.Count -eq 1 -and $targets.Count -eq 1 -and $targets[0] -eq $WorkerName
    $pass = if ($cutover) { $correct } else { $matches.Count -le 1 }
    Add-Check $checks "routing_$local" $pass ($(if ($cutover) { "Expected one rule -> $WorkerName; found $($matches.Count), targets=$($targets -join ',')" } else { "Pre-cutover rules found: $($matches.Count)" }))
  }

  $webhooks = @()
  $legacyHooks = @()
  if ($resendHeaders) {
    $domains = Invoke-RestMethod -Method Get -Uri "https://api.resend.com/domains" -Headers $resendHeaders
    $domainRecord = @($domains.data | Where-Object { $_.name -eq $Domain }) | Select-Object -First 1
    Add-Check $checks "resend_domain" ($domainRecord -and $domainRecord.status -eq "verified") "Status: $($domainRecord.status)"
    $webhooks = Get-AllResendWebhooks $resendHeaders
    $canonicalEndpoint = if ($canonicalOrigin) { "$canonicalOrigin/webhooks/resend" } else { "" }
    $currentHooks = if ($canonicalEndpoint) { @($webhooks | Where-Object { [string]$_.endpoint -eq $canonicalEndpoint }) } else { @() }
    $legacyHooks = @($webhooks | Where-Object { [string]$_.endpoint -match "example\.com/api/admin/mail/webhooks/resend|mailgable(?!-dev).*workers\.dev" })

    Add-Check $checks "canonical_resend_webhook" (-not $staged -or ($currentHooks.Count -eq 1 -and $currentHooks[0].status -eq "enabled")) "Matching hooks: $($currentHooks.Count)" $staged
    Add-Check $checks "legacy_resend_webhooks_absent" (-not $cutover -or $legacyHooks.Count -eq 0) ($(if ($legacyHooks.Count) { ($legacyHooks.endpoint -join ', ') } else { "None" })) $cutover
  } else {
    $skipDetail = "Not checked because no temporary Resend Full Access key was supplied; routine preflight remains least-privilege."
    Add-Check $checks "resend_domain" $false $skipDetail $false
    Add-Check $checks "canonical_resend_webhook" $false $skipDetail $false
    Add-Check $checks "legacy_resend_webhooks_absent" $false $skipDetail $false
  }

  $productionApi = Get-HttpSnapshot "https://$Domain/healthz"
  $oldApiLive = $productionApi.content -match '"service"\s*:\s*"mailgable"'
  Add-Check $checks "production_api_offline" (-not $cutover -or -not $oldApiLive) "HTTP $($productionApi.status); old mailbox response=$oldApiLive" $cutover

  $blockingFailures = @($checks | Where-Object { $_.blocking -and -not $_.pass })
  $report = [ordered]@{
    schema_version=2
    generated_at=(Get-Date).ToUniversalTime().ToString("o")
    phase=$Phase
    account_id=$AccountId
    zone_id=$ZoneId
    domain=$Domain
    canonical_origin=$canonicalOrigin
    ready=($blockingFailures.Count -eq 0)
    inventory=[ordered]@{
      workers=$workerNames
      worker_routes=$routesResponse.result
      d1=$dbNames
      r2=$r2Names
      email_routing=$routingInventory
      resend_webhooks=@($webhooks | Select-Object id,status,endpoint,events)
      legacy_workers=$legacyWorkerHits
      legacy_databases=$legacyDbHits
      legacy_buckets=$legacyBucketHits
      legacy_webhooks=@($legacyHooks | Select-Object id,status,endpoint)
    }
    http=[ordered]@{ canonical_health=$health; main_get=$mainGet; main_post=$mainPost; production_api=$productionApi }
    checks=$checks.ToArray()
  }
  if (-not $OutputPath) {
    $directory = Join-Path (Get-Location) "deployment-backups"
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $OutputPath = Join-Path $directory ("preflight-{0}-{1}.json" -f $Phase,(Get-Date -Format "yyyyMMdd-HHmmss"))
  }
  $report | ConvertTo-Json -Depth 40 | Set-Content -Encoding UTF8 $OutputPath
  Write-Host "Report: $OutputPath"
  if ($blockingFailures.Count) {
    throw "Production preflight is blocked by $($blockingFailures.Count) check(s)."
  }
  Write-Host "READY: all blocking checks for phase '$Phase' passed."
} finally {
  $cfToken = $null
  $resendKey = $null
}
