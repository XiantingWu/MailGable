[CmdletBinding()]
param(
  [ValidateSet("Check", "Reconcile")]
  [string]$Mode = "Check",
  [string]$AccountId = "",
  [string]$ZoneId = "",
  [string]$Domain = "example.com",
  [string]$WorkerName = "mailgable-dev",
  [string[]]$RequiredAddresses = @(),
  [string]$ForwardTo = "",
  [Security.SecureString]$CloudflareToken,
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$tokenPlaintext = $null
$rulesEndpoint = "https://api.cloudflare.com/client/v4/zones/$ZoneId/email/routing/rules"
$catchAllEndpoint = "$rulesEndpoint/catch_all"
$addressesEndpoint = "https://api.cloudflare.com/client/v4/accounts/$AccountId/email/routing/addresses"
$domainNormalized = $Domain.Trim().ToLowerInvariant()
$domainPattern = [regex]::Escape($domainNormalized)

function ConvertFrom-Secure([Security.SecureString]$Value) {
  if ($null -eq $Value) { throw "Cloudflare token is required." }
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Get-HttpStatus($ErrorRecord) {
  if ($ErrorRecord.Exception.Response) { return [int]$ErrorRecord.Exception.Response.StatusCode }
  return 0
}

function Invoke-Cf(
  [string]$Method,
  [string]$Uri,
  [hashtable]$Headers,
  [object]$Body = $null,
  [switch]$AllowNotFound
) {
  try {
    $arguments = @{ Method = $Method; Uri = $Uri; Headers = $Headers }
    if ($null -ne $Body) { $arguments.Body = ($Body | ConvertTo-Json -Depth 30) }
    $response = Invoke-RestMethod @arguments
    if ($null -ne $response.success -and -not $response.success) {
      throw "Cloudflare request reported failure."
    }
    return $response
  } catch {
    $status = Get-HttpStatus $_
    if ($AllowNotFound -and $status -eq 404) { return $null }
    throw "Cloudflare request failed with HTTP $status for ${Uri}: $($_.Exception.Message)"
  }
}

function Get-AllPagedResults([string]$Endpoint, [hashtable]$Headers) {
  $all = New-Object System.Collections.Generic.List[object]
  $page = 1
  do {
    if ($page -gt 1000) { throw "Cloudflare pagination exceeded the safety limit for $Endpoint." }
    $separator = if ($Endpoint.Contains("?")) { "&" } else { "?" }
    $response = Invoke-Cf Get "${Endpoint}${separator}page=${page}&per_page=50" $Headers
    foreach ($item in @($response.result)) { if ($null -ne $item) { $all.Add($item) } }
    $pages = if ($response.result_info -and $response.result_info.total_pages) {
      [int]$response.result_info.total_pages
    } else { 1 }
    $page += 1
  } while ($page -le $pages)
  return $all.ToArray()
}

function Normalize-Email([object]$Value) {
  return ([string]$Value).Trim().ToLowerInvariant()
}

function Get-LiteralDomainAddress($Rule) {
  $matchers = @($Rule.matchers)
  $domainMatchers = @($matchers | Where-Object {
    if ($_.type -ne "literal" -or $_.field -ne "to") { return $false }
    $candidate = Normalize-Email $_.value
    return $candidate -match "^[^@\s]+@$domainPattern$"
  })
  if ($domainMatchers.Count -eq 0) { return "" }
  if ($domainMatchers.Count -ne 1 -or $matchers.Count -ne 1) {
    throw "Email Routing rule $([string]$Rule.id) has an ambiguous matcher set for $domainNormalized. No routing changes were made."
  }
  return Normalize-Email $domainMatchers[0].value
}

function Test-CanonicalWorkerAction($Rule) {
  $actions = @($Rule.actions)
  if ($actions.Count -ne 1 -or [string]$actions[0].type -ne "worker") { return $false }
  $targets = @($actions[0].value)
  return $targets.Count -eq 1 -and [string]$targets[0] -eq $WorkerName
}

function Get-RulePayload($Rule) {
  $payload = [ordered]@{
    name = [string]$Rule.name
    enabled = [bool]$Rule.enabled
    matchers = @($Rule.matchers)
    actions = @($Rule.actions)
  }
  if ($null -ne $Rule.priority) { $payload.priority = [int]$Rule.priority }
  return $payload
}

function Get-CatchAllPayload($Rule) {
  return [ordered]@{
    name = if ([string]::IsNullOrWhiteSpace([string]$Rule.name)) { "MailGable catch-all" } else { [string]$Rule.name }
    enabled = [bool]$Rule.enabled
    matchers = @(@{ type = "all" })
    actions = @(@{ type = "worker"; value = @($WorkerName) })
  }
}

function Assert-ApiManaged([object[]]$Rules, [string]$Scope) {
  $wrangler = @($Rules | Where-Object { [string]$_.source -eq "wrangler" })
  if ($wrangler.Count -gt 0) {
    $ids = ($wrangler | ForEach-Object { [string]$_.id }) -join ", "
    throw "$Scope contains Wrangler-managed Email Routing rules ($ids). Remove the routes from Wrangler before API reconciliation."
  }
}

function Get-DomainGroups([object[]]$Rules) {
  $groups = @{}
  foreach ($rule in @($Rules)) {
    $address = Get-LiteralDomainAddress $rule
    if (-not $address) { continue }
    if (-not $groups.ContainsKey($address)) {
      $groups[$address] = New-Object System.Collections.Generic.List[object]
    }
    $groups[$address].Add($rule)
  }
  return $groups
}

function Select-CanonicalWinner([object[]]$Rules) {
  return @($Rules | Sort-Object `
    @{ Expression = { if ([bool]$_.enabled) { 0 } else { 1 } } }, `
    @{ Expression = { if (Test-CanonicalWorkerAction $_) { 0 } else { 1 } } }, `
    @{ Expression = { if ($null -ne $_.priority) { [int]$_.priority } else { [int]::MaxValue } } }, `
    @{ Expression = { [string]$_.id } }) | Select-Object -First 1
}

function New-CanonicalPayload([string]$Address, [object[]]$Rules) {
  $winner = if ($Rules.Count -gt 0) { Select-CanonicalWinner $Rules } else { $null }
  $enabled = if ($Rules.Count -gt 0) {
    @($Rules | Where-Object { [bool]$_.enabled }).Count -gt 0
  } else { $true }
  $payload = [ordered]@{
    name = if ($winner -and -not [string]::IsNullOrWhiteSpace([string]$winner.name)) {
      [string]$winner.name
    } else { "MailGable - $Address" }
    enabled = $enabled
    matchers = @(@{ type = "literal"; field = "to"; value = $Address })
    actions = @(@{ type = "worker"; value = @($WorkerName) })
  }
  if ($winner -and $null -ne $winner.priority) { $payload.priority = [int]$winner.priority }
  return $payload
}

function Assert-DestinationAddresses([object[]]$Addresses) {
  $destinations = @(Normalize-EmailList $ForwardTo)
  if ($destinations.Count -eq 0) { return @() }
  foreach ($destination in $destinations) {
    $matches = @($Addresses | Where-Object { (Normalize-Email $_.email) -eq $destination })
    if ($matches.Count -ne 1) {
      throw "Destination address $destination must exist exactly once in the Cloudflare account."
    }
    if ([string]::IsNullOrWhiteSpace([string]$matches[0].verified)) {
      throw "Destination address $destination is not verified."
    }
  }
  return $destinations
}

function Get-StateReport([object[]]$Rules, $CatchAll, [object[]]$Addresses) {
  $requiredDestinations = @(Assert-DestinationAddresses $Addresses)
  $groups = Get-DomainGroups $Rules
  $requiredAddresses = @($RequiredAddresses | ForEach-Object { Normalize-Email $_ } | Sort-Object -Unique)
  $issues = New-Object System.Collections.Generic.List[string]
  $inventory = New-Object System.Collections.Generic.List[object]

  foreach ($address in @($groups.Keys | Sort-Object)) {
    $matches = @($groups[$address].ToArray())
    $sources = @($matches | ForEach-Object { [string]$_.source } | Sort-Object -Unique)
    $canonical = $matches.Count -eq 1 -and (Test-CanonicalWorkerAction $matches[0]) -and -not ($sources -contains "wrangler")
    if (-not $canonical) { $issues.Add("$address is not represented by exactly one API-managed canonical Worker rule.") }
    $inventory.Add([ordered]@{
      address = $address
      count = $matches.Count
      enabled = @($matches | Where-Object { [bool]$_.enabled }).Count -gt 0
      canonical = $canonical
      sources = $sources
      rule_ids = @($matches | ForEach-Object { [string]$_.id })
    })
  }

  foreach ($required in $requiredAddresses) {
    if (-not $groups.ContainsKey($required)) { $issues.Add("Required route $required is missing.") }
    elseif (@($groups[$required].ToArray() | Where-Object { [bool]$_.enabled }).Count -eq 0) { $issues.Add("Required route $required is disabled.") }
  }

  $catchAllCanonical = $true
  if ($CatchAll) {
    if ([string]$CatchAll.source -eq "wrangler") {
      $issues.Add("Catch-all is Wrangler-managed.")
      $catchAllCanonical = $false
    } elseif (-not (Test-CanonicalWorkerAction $CatchAll)) {
      $issues.Add("Catch-all does not target the canonical Worker.")
      $catchAllCanonical = $false
    }
  }

  return [ordered]@{
    schema_version = 1
    checked_at = (Get-Date).ToUniversalTime().ToString("o")
    mode = $Mode
    account_id = $AccountId
    zone_id = $ZoneId
    domain = $domainNormalized
    worker = $WorkerName
    destination_addresses = @($requiredDestinations | ForEach-Object { [ordered]@{ email = $_; verified = $true } })
    literal_routes = $inventory.ToArray()
    catch_all = if ($CatchAll) {
      [ordered]@{ present = $true; enabled = [bool]$CatchAll.enabled; canonical = $catchAllCanonical; source = [string]$CatchAll.source }
    } else { [ordered]@{ present = $false; enabled = $false; canonical = $true; source = "" } }
    success = $issues.Count -eq 0
    issues = $issues.ToArray()
  }
}

function Write-Report($Report, [string]$Path) {
  if (-not $Path) { return }
  $parent = Split-Path -Parent $Path
  if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $Report | ConvertTo-Json -Depth 30 | Set-Content -Encoding UTF8 $Path
}

function Restore-RoutingState(
  [object[]]$OriginalRules,
  $OriginalCatchAll,
  [string[]]$CreatedRuleIds,
  [hashtable]$Headers
) {
  Write-Warning "Restoring the pre-reconciliation Email Routing state..."
  $current = @(Get-AllPagedResults $rulesEndpoint $Headers)
  $currentIds = @{}
  foreach ($rule in $current) { $currentIds[[string]$rule.id] = $true }

  foreach ($id in @($CreatedRuleIds | Sort-Object -Unique)) {
    if (-not $id -or -not $currentIds.ContainsKey($id)) { continue }
    try { Invoke-Cf Delete "$rulesEndpoint/$id" $Headers | Out-Null }
    catch { Write-Warning "Could not delete newly created routing rule $id during rollback." }
  }

  $current = @(Get-AllPagedResults $rulesEndpoint $Headers)
  $currentIds = @{}
  foreach ($rule in $current) { $currentIds[[string]$rule.id] = $true }
  foreach ($rule in $OriginalRules) {
    $id = [string]$rule.id
    $payload = Get-RulePayload $rule
    try {
      if ($id -and $currentIds.ContainsKey($id)) {
        Invoke-Cf Put "$rulesEndpoint/$id" $Headers $payload | Out-Null
      } else {
        Invoke-Cf Post $rulesEndpoint $Headers $payload | Out-Null
      }
    } catch {
      Write-Warning "Could not restore routing rule $id. Use the complete backup file."
    }
  }

  if ($OriginalCatchAll) {
    try {
      $payload = [ordered]@{
        name = [string]$OriginalCatchAll.name
        enabled = [bool]$OriginalCatchAll.enabled
        matchers = @($OriginalCatchAll.matchers)
        actions = @($OriginalCatchAll.actions)
      }
      Invoke-Cf Put $catchAllEndpoint $Headers $payload | Out-Null
    } catch {
      Write-Warning "Could not restore catch-all. Use the complete backup file."
    }
  }
}

try {
  $tokenPlaintext = ConvertFrom-Secure $CloudflareToken
  $headers = @{ Authorization = "Bearer $tokenPlaintext"; "Content-Type" = "application/json" }
  $rules = @(Get-AllPagedResults $rulesEndpoint $headers)
  $addresses = @(Get-AllPagedResults $addressesEndpoint $headers)
  $catchAllResponse = Invoke-Cf Get $catchAllEndpoint $headers $null -AllowNotFound
  $catchAll = if ($catchAllResponse) { $catchAllResponse.result } else { $null }

  # Destination verification is a hard gate before any routing mutation.
  $null = Assert-DestinationAddresses $addresses

  if ($Mode -eq "Check") {
    $report = Get-StateReport $rules $catchAll $addresses
    Write-Report $report $OutputPath
    if (-not $report.success) {
      throw "Email Routing consistency check failed: $($report.issues -join ' ')"
    }
    Write-Host "Email Routing check passed: every literal $domainNormalized route and catch-all target $WorkerName."
    Write-Host "Verified destinations: $(@($requiredDestinations) -join ', ')"
    return
  }

  $groups = Get-DomainGroups $rules
  $affectedRules = @($rules | Where-Object { Get-LiteralDomainAddress $_ })
  Assert-ApiManaged $affectedRules "Literal domain routing"
  if ($catchAll -and [string]$catchAll.source -eq "wrangler") {
    throw "Catch-all is Wrangler-managed. Remove it from Wrangler before API reconciliation."
  }

  if (-not $OutputPath) {
    $backupDirectory = Join-Path (Join-Path (Get-Location) "deployment-backups") (Get-Date -Format "yyyyMMdd-HHmmss-fff")
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    $OutputPath = Join-Path $backupDirectory "email-routing-reconcile.json"
  }
  $backup = [ordered]@{
    schema_version = 1
    complete = $true
    captured_at = (Get-Date).ToUniversalTime().ToString("o")
    account_id = $AccountId
    zone_id = $ZoneId
    domain = $domainNormalized
    worker = $WorkerName
    rules = @($rules)
    catch_all = $catchAll
    destinations = @($addresses | ForEach-Object { [ordered]@{ email = [string]$_.email; verified = [string]$_.verified } })
  }
  Write-Report $backup $OutputPath
  Write-Host "Complete Email Routing backup: $OutputPath"

  $createdRuleIds = New-Object System.Collections.Generic.List[string]
  try {
    $allAddresses = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($address in @($groups.Keys)) { $null = $allAddresses.Add([string]$address) }
    foreach ($address in $requiredAddresses) { $null = $allAddresses.Add([string]$address) }

    foreach ($address in @($allAddresses | Sort-Object)) {
      $matches = if ($groups.ContainsKey($address)) { @($groups[$address].ToArray()) } else { @() }
      $payload = New-CanonicalPayload $address $matches
      $winner = if ($matches.Count -gt 0) { Select-CanonicalWinner $matches } else { $null }
      if ($winner) {
        $result = Invoke-Cf Put "$rulesEndpoint/$($winner.id)" $headers $payload
        if (-not $result.result.id) { throw "Cloudflare did not return the updated rule for $address." }
      } else {
        $result = Invoke-Cf Post $rulesEndpoint $headers $payload
        $createdId = [string]$result.result.id
        if (-not $createdId) { throw "Cloudflare did not return the created rule for $address." }
        $createdRuleIds.Add($createdId)
      }

      foreach ($duplicate in @($matches | Where-Object { -not $winner -or [string]$_.id -ne [string]$winner.id })) {
        Invoke-Cf Delete "$rulesEndpoint/$($duplicate.id)" $headers | Out-Null
      }
      Write-Host "  Reconciled $address -> $WorkerName"
    }

    if ($catchAll -and -not (Test-CanonicalWorkerAction $catchAll)) {
      Invoke-Cf Put $catchAllEndpoint $headers (Get-CatchAllPayload $catchAll) | Out-Null
      Write-Host "  Reconciled catch-all -> $WorkerName (enabled=$([bool]$catchAll.enabled))"
    }

    $finalRules = @(Get-AllPagedResults $rulesEndpoint $headers)
    $finalAddresses = @(Get-AllPagedResults $addressesEndpoint $headers)
    $finalCatchAllResponse = Invoke-Cf Get $catchAllEndpoint $headers $null -AllowNotFound
    $finalCatchAll = if ($finalCatchAllResponse) { $finalCatchAllResponse.result } else { $null }
    $report = Get-StateReport $finalRules $finalCatchAll $finalAddresses
    if (-not $report.success) {
      throw "Post-reconciliation verification failed: $($report.issues -join ' ')"
    }
    $report["backup_path"] = $OutputPath
    $report["reconciled"] = $true
    $resultPath = if ($OutputPath -match '(?i)\.json$') {
      $OutputPath -replace '(?i)\.json$', '.result.json'
    } else { "$OutputPath.result.json" }
    Write-Report $report $resultPath
    Write-Host "Email Routing reconciliation passed."
  } catch {
    Restore-RoutingState $affectedRules $catchAll $createdRuleIds.ToArray() $headers
    throw
  }
} finally {
  $tokenPlaintext = $null
}
