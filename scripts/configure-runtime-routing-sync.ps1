[CmdletBinding()]
param(
  [string]$Domain = "example.com",
  [string]$ZoneId = "",
  [string]$WorkerName = "mailgable-dev"
)

$ErrorActionPreference = "Stop"
$MailboxRoot = Split-Path -Parent $PSScriptRoot
$RepositoryRoot = Split-Path -Parent $MailboxRoot
$DevVarsPath = Join-Path $RepositoryRoot ".dev.vars"
$GeneratedConfig = Join-Path $MailboxRoot "wrangler.dev.generated.jsonc"
$CredentialHelper = Join-Path $PSScriptRoot "production-credential-forwarding.ps1"
$previousCloudflareApiToken = $env:CLOUDFLARE_API_TOKEN
$values = @{}
$deployToken = $null
$routingToken = $null
$adminPassword = $null

Set-Location $MailboxRoot

if (-not (Test-Path -LiteralPath $CredentialHelper -PathType Leaf)) {
  throw "Credential helper not found: $CredentialHelper"
}
. $CredentialHelper

function Read-DevVarsFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Missing $Path. Copy .dev.vars.example to .dev.vars and fill the required production credentials."
  }
  $result = @{}
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
    if ($result.ContainsKey($name)) { throw "Duplicate .dev.vars entry '$name' on line $lineNumber." }
    $value = $match.Groups[2].Value.Trim()
    if ($value.Length -ge 2) {
      $first = $value[0]
      $last = $value[$value.Length - 1]
      if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    $result[$name] = $value
  }
  return $result
}

function Require-Value([hashtable]$Values, [string]$Name) {
  if (-not $Values.ContainsKey($Name) -or [string]::IsNullOrWhiteSpace([string]$Values[$Name])) {
    throw "Required .dev.vars entry '$Name' is missing or empty."
  }
  return [string]$Values[$Name]
}

function Get-HttpStatus($ErrorRecord) {
  if ($ErrorRecord.Exception.Response) { return [int]$ErrorRecord.Exception.Response.StatusCode }
  return 0
}

function Assert-RoutingReadToken([string]$Token) {
  $headers = @{ Authorization = "Bearer $Token"; Accept = "application/json" }
  try {
    $response = Invoke-RestMethod -Method Get -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/email/routing/rules?page=1&per_page=1" -Headers $headers
  } catch {
    $status = Get-HttpStatus $_
    throw "The runtime routing token could not read Cloudflare Email Routing rules (HTTP $status). Give it zone-scoped 'Email Routing Rules Read' permission."
  }
  if (-not $response.success -or $null -eq $response.result) {
    throw "The runtime routing token returned an invalid Cloudflare Email Routing response."
  }
  Write-Host "[runtime-routing-sync] Read-only Email Routing permission verified."
}

function Set-WorkerSecret([string]$Name, [string]$Value) {
  $temp = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($temp, $Value)
    Get-Content -Raw $temp | & npx wrangler secret put $Name --config $GeneratedConfig
    if ($LASTEXITCODE -ne 0) { throw "Failed to set Worker secret $Name." }
  } finally {
    Remove-Item $temp -Force -ErrorAction SilentlyContinue
  }
}

function Assert-WorkerSecret([string]$Name) {
  $raw = (& npx wrangler secret list --format json --config $GeneratedConfig 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Could not list Worker secrets after configuration." }
  $list = if ($raw.Trim()) { @($raw | ConvertFrom-Json) } else { @() }
  if (-not (@($list | Where-Object { [string]$_.name -eq $Name }).Count -eq 1)) {
    throw "Worker secret $Name was not present after configuration."
  }
  Write-Host "[runtime-routing-sync] Worker secret presence verified."
}

function Get-CanonicalWorkerOrigin {
  $uri = "https://$Domain/admin/mail"
  $response = $null
  try {
    $response = Invoke-WebRequest -Method Get -Uri $uri -MaximumRedirection 0 -UseBasicParsing -ErrorAction Stop
  } catch {
    if ($_.Exception.Response) { $response = $_.Exception.Response }
    else { throw "Could not resolve the canonical mailbox redirect: $($_.Exception.Message)" }
  }
  if ([int]$response.StatusCode -ne 308) {
    throw "Expected GET $uri to return the canonical 308 redirect; received HTTP $([int]$response.StatusCode)."
  }
  $location = [string]$response.Headers.Location
  if ([string]::IsNullOrWhiteSpace($location)) { throw "The canonical mailbox redirect did not include a Location header." }
  try { $target = [Uri]$location }
  catch { throw "The canonical mailbox redirect Location is invalid." }
  $expectedHostPattern = '^' + [regex]::Escape($WorkerName) + '\.[a-z0-9-]+\.workers\.dev$'
  if ($target.Scheme -ne "https" -or $target.Host -notmatch $expectedHostPattern) {
    throw "The canonical mailbox redirect does not target the expected $WorkerName workers.dev origin."
  }
  if ($target.AbsolutePath -ne "/admin/mail" -and $target.AbsolutePath -ne "/admin/mail/") {
    throw "The canonical mailbox redirect does not preserve the /admin/mail path."
  }
  return $target.GetLeftPart([UriPartial]::Authority)
}

function Invoke-LiveRoutingSync([string]$Origin, [string]$Password) {
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $loginHeaders = @{ "Content-Type" = "application/json"; Origin = $Origin }
  $adminEmail = Require-Value $values "MAILBOX_ADMIN_EMAIL"
  $loginBody = @{ email = $adminEmail; password = $Password } | ConvertTo-Json
  try {
    $login = Invoke-RestMethod -Method Post -Uri "$Origin/api/admin/mail/auth/login" -Headers $loginHeaders -Body $loginBody -WebSession $session
  } catch {
    throw "Runtime routing sync validation could not sign in to the mailbox admin."
  }
  if (-not $login.authenticated -or -not $login.csrf_token) {
    throw "Mailbox admin login did not return an authenticated CSRF session."
  }

  $syncHeaders = @{ "Content-Type" = "application/json"; Origin = $Origin; "X-CSRF-Token" = [string]$login.csrf_token }
  $lastError = $null
  for ($attempt = 1; $attempt -le 8; $attempt += 1) {
    try {
      $before = Invoke-RestMethod -Method Get -Uri "$Origin/api/admin/mail/routing-status" -WebSession $session
      $sync = Invoke-RestMethod -Method Post -Uri "$Origin/api/admin/mail/routing-sync" -Headers $syncHeaders -Body "{}" -WebSession $session
      if (-not $sync.ok -or $sync.source -ne "cloudflare" -or [int]$sync.route_count -lt 3) {
        throw "Runtime routing sync returned an invalid success response."
      }
      $status = Invoke-RestMethod -Method Get -Uri "$Origin/api/admin/mail/routing-status" -WebSession $session
      if (@($status.routes).Count -ne [int]$sync.route_count) {
        throw "Runtime routing status does not match the synchronized mailbox count."
      }
      $beforeFinished = [string]$before.sync.finished_at
      $afterFinished = [string]$status.sync.finished_at
      if ($beforeFinished -and $afterFinished -and ([datetime]$afterFinished -lt [datetime]$beforeFinished)) {
        throw "Runtime routing sync timestamp regressed."
      }
      Write-Host "[runtime-routing-sync] Live authenticated sync passed: $($sync.route_count) route-managed mailboxes."
      return
    } catch {
      $lastError = $_
      if ($attempt -lt 8) { Start-Sleep -Seconds 2 }
    }
  }
  throw "Runtime routing sync did not become healthy after the Worker secret update: $($lastError.Exception.Message)"
}

try {
  Assert-ProductionDevVarsLocalOnly $RepositoryRoot $DevVarsPath
  if (-not (Test-Path -LiteralPath $GeneratedConfig -PathType Leaf)) {
    throw "Generated production Worker config is missing: $GeneratedConfig. Run the guarded Deploy once before configuring runtime routing sync."
  }

  $values = Read-DevVarsFile $DevVarsPath
  $deployToken = Require-Value $values "CLOUDFLARE_DEPLOY_TOKEN"
  $adminPassword = Require-Value $values "MAILBOX_ADMIN_PASSWORD"
  if (-not $values.ContainsKey("MAILBOX_ADMIN_EMAIL") -or [string]::IsNullOrWhiteSpace([string]$values["MAILBOX_ADMIN_EMAIL"])) {
    $values["MAILBOX_ADMIN_EMAIL"] = "admin@example.com"
  }

  $routingToken = if (
    $values.ContainsKey("CLOUDFLARE_ROUTING_READ_TOKEN") -and
    -not [string]::IsNullOrWhiteSpace([string]$values["CLOUDFLARE_ROUTING_READ_TOKEN"])
  ) {
    Write-Host "[runtime-routing-sync] Using dedicated CLOUDFLARE_ROUTING_READ_TOKEN."
    [string]$values["CLOUDFLARE_ROUTING_READ_TOKEN"]
  } else {
    Write-Warning "CLOUDFLARE_ROUTING_READ_TOKEN is empty; reusing CLOUDFLARE_READ_TOKEN. A dedicated zone-scoped Email Routing Rules Read token is preferred."
    Require-Value $values "CLOUDFLARE_READ_TOKEN"
  }

  Assert-RoutingReadToken $routingToken
  $origin = Get-CanonicalWorkerOrigin

  # The deploy token is used only for the Wrangler secret mutation. Public
  # canonical-origin discovery and Email Routing reads do not use it.
  $env:CLOUDFLARE_API_TOKEN = $deployToken
  Set-WorkerSecret "CLOUDFLARE_ROUTING_READ_TOKEN" $routingToken
  Assert-WorkerSecret "CLOUDFLARE_ROUTING_READ_TOKEN"

  Invoke-LiveRoutingSync $origin $adminPassword
  Write-Host "[runtime-routing-sync] Configuration complete. Browser refresh and routing-status actions can now synchronize Cloudflare routes."
} finally {
  if ($null -eq $previousCloudflareApiToken) {
    Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
  } else {
    $env:CLOUDFLARE_API_TOKEN = $previousCloudflareApiToken
  }
  foreach ($name in @($values.Keys)) { $values[$name] = $null }
  $values.Clear()
  $deployToken = $null
  $routingToken = $null
  $adminPassword = $null
}
