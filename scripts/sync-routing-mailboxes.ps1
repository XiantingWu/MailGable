[CmdletBinding()]
param(
  [ValidateSet("Sync", "Check")]
  [string]$Mode = "Sync",
  [string]$Phase = "",
  [string]$AccountId = "",
  [string]$ZoneId = "",
  [string]$Domain = "example.com",
  [string]$WorkerName = "mailgable-dev",
  [string]$DatabaseName = "mailgable-dev",
  [string[]]$RequiredAddresses = @(),
  [Security.SecureString]$CloudflareToken,
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$tokenPlaintext = $null

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
  [object]$Body = $null
) {
  try {
    $arguments = @{ Method = $Method; Uri = $Uri; Headers = $Headers }
    if ($null -ne $Body) { $arguments.Body = ($Body | ConvertTo-Json -Depth 20) }
    $response = Invoke-RestMethod @arguments
    if ($null -ne $response.success -and -not $response.success) {
      throw "Cloudflare request failed: $Uri"
    }
    return $response
  } catch {
    $status = Get-HttpStatus $_
    throw "Cloudflare request failed with HTTP $status for ${Uri}: $($_.Exception.Message)"
  }
}

function Get-AllEmailRoutingRules([hashtable]$Headers) {
  $all = New-Object System.Collections.Generic.List[object]
  $page = 1
  do {
    $uri = "https://api.cloudflare.com/client/v4/zones/$ZoneId/email/routing/rules?page=$page&per_page=50"
    $response = Invoke-Cf Get $uri $Headers
    foreach ($rule in @($response.result)) { if ($null -ne $rule) { $all.Add($rule) } }
    $pages = if ($response.result_info -and $response.result_info.total_pages) {
      [int]$response.result_info.total_pages
    } else { 1 }
    $page += 1
  } while ($page -le $pages)
  return $all.ToArray()
}

function Get-CanonicalRouteAddresses([object[]]$Rules) {
  $addresses = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $domainPattern = [regex]::Escape($Domain)
  foreach ($rule in @($Rules)) {
    if (-not [bool]$rule.enabled) { continue }
    $matchers = @($rule.matchers)
    if ($matchers.Count -ne 1) { continue }
    $matcher = $matchers[0]
    if ($matcher.type -ne "literal" -or $matcher.field -ne "to") { continue }
    $address = ([string]$matcher.value).Trim().ToLowerInvariant()
    if ($address -notmatch "^[^@\s]+@$domainPattern$") { continue }

    $actions = @($rule.actions)
    if ($actions.Count -ne 1 -or $actions[0].type -ne "worker") { continue }
    $targets = @($actions[0].value | ForEach-Object { [string]$_ })
    if ($targets.Count -ne 1 -or $targets[0] -ne $WorkerName) { continue }
    $null = $addresses.Add($address)
  }
  return @($addresses | Sort-Object)
}

function Get-SendableAddresses([object[]]$Rules) {
  # Every enabled, single literal "to" address inside the domain can be used
  # as a sender identity, regardless of its route action (worker, forward, ...).
  # Only the canonical Worker route addresses receive mail in this Worker.
  $addresses = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $domainPattern = [regex]::Escape($Domain)
  foreach ($rule in @($Rules)) {
    if (-not [bool]$rule.enabled) { continue }
    $matchers = @($rule.matchers)
    if ($matchers.Count -ne 1) { continue }
    $matcher = $matchers[0]
    if ($matcher.type -ne "literal" -or $matcher.field -ne "to") { continue }
    $address = ([string]$matcher.value).Trim().ToLowerInvariant()
    if ($address -notmatch "^[^@\s]+@$domainPattern$") { continue }
    $null = $addresses.Add($address)
  }
  return @($addresses | Sort-Object)
}

function Get-DesiredAddresses([object[]]$Rules) {
  $addresses = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($address in @($RequiredAddresses)) {
    $null = $addresses.Add(([string]$address).Trim().ToLowerInvariant())
  }
  foreach ($address in @(Get-SendableAddresses $Rules)) { $null = $addresses.Add($address) }
  return @($addresses | Sort-Object)
}

function Get-StableMailboxId([string]$Address) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Address.ToLowerInvariant())
    $hash = $sha.ComputeHash($bytes)
    $hex = -join ($hash | ForEach-Object { $_.ToString("x2") })
    return "route_$($hex.Substring(0, 24))"
  } finally {
    $sha.Dispose()
  }
}

function Get-DisplayName([string]$Address) {
  $localPart = $Address.Split('@')[0]
  $words = [regex]::Replace($localPart, '[._+\-]+', ' ').Trim()
  if (-not $words) { return "MailGable" }
  $title = [Globalization.CultureInfo]::InvariantCulture.TextInfo.ToTitleCase($words.ToLowerInvariant())
  return "$title"
}

function Get-Database([hashtable]$Headers) {
  $escaped = [Uri]::EscapeDataString($DatabaseName)
  $response = Invoke-Cf Get "https://api.cloudflare.com/client/v4/accounts/$AccountId/d1/database?name=$escaped&per_page=100" $Headers
  $matches = @($response.result | Where-Object { [string]$_.name -eq $DatabaseName })
  if ($matches.Count -ne 1) {
    throw "Expected exactly one D1 database named $DatabaseName; found $($matches.Count)."
  }
  $databaseId = if ($matches[0].uuid) { [string]$matches[0].uuid } else { [string]$matches[0].id }
  if (-not $databaseId) { throw "D1 database $DatabaseName has no UUID." }
  return [ordered]@{ id = $databaseId; name = $DatabaseName }
}

function Invoke-D1Query(
  [string]$DatabaseId,
  [string]$Sql,
  [object[]]$Params,
  [hashtable]$Headers
) {
  $body = [ordered]@{ sql = $Sql; params = @($Params) }
  $response = Invoke-Cf Post "https://api.cloudflare.com/client/v4/accounts/$AccountId/d1/database/$DatabaseId/query" $Headers $body
  $entries = @($response.result)
  foreach ($entry in $entries) {
    if ($null -ne $entry.success -and -not [bool]$entry.success) {
      throw "D1 query failed: $Sql"
    }
  }
  return $entries
}

function Get-D1Rows(
  [string]$DatabaseId,
  [string]$Sql,
  [object[]]$Params,
  [hashtable]$Headers
) {
  $rows = New-Object System.Collections.Generic.List[object]
  foreach ($entry in @(Invoke-D1Query $DatabaseId $Sql $Params $Headers)) {
    foreach ($row in @($entry.results)) { if ($null -ne $row) { $rows.Add($row) } }
  }
  return $rows.ToArray()
}

function Compare-AddressSets([string[]]$Expected, [string[]]$Actual) {
  $expectedSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $actualSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($item in @($Expected)) { if ($item) { $null = $expectedSet.Add($item.ToLowerInvariant()) } }
  foreach ($item in @($Actual)) { if ($item) { $null = $actualSet.Add($item.ToLowerInvariant()) } }
  $missing = @($expectedSet | Where-Object { -not $actualSet.Contains($_) } | Sort-Object)
  $unexpected = @($actualSet | Where-Object { -not $expectedSet.Contains($_) } | Sort-Object)
  return [ordered]@{ equal = ($missing.Count -eq 0 -and $unexpected.Count -eq 0); missing = $missing; unexpected = $unexpected }
}

function Write-Report($Report) {
  if (-not $OutputPath) {
    $directory = Join-Path (Get-Location) "deployment-backups"
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $suffix = if ($Phase) { "-$Phase" } else { "" }
    $script:OutputPath = Join-Path $directory ("routing-mailboxes-{0}{1}-{2}.json" -f $Mode.ToLowerInvariant(), $suffix, (Get-Date -Format "yyyyMMdd-HHmmss"))
  }
  $Report | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 $OutputPath
  Write-Host "Routing mailbox report: $OutputPath"
}

try {
  $tokenPlaintext = ConvertFrom-Secure $CloudflareToken
  if ([string]::IsNullOrWhiteSpace($tokenPlaintext)) { throw "Cloudflare token cannot be empty." }
  $headers = @{ Authorization = "Bearer $tokenPlaintext"; "Content-Type" = "application/json" }
  $rules = Get-AllEmailRoutingRules $headers
  $canonicalRouteAddresses = @(Get-CanonicalRouteAddresses $rules)
  $sendableAddresses = @(Get-SendableAddresses $rules)
  $desiredAddresses = @(Get-DesiredAddresses $rules)
  $receiveSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($address in $canonicalRouteAddresses) { $null = $receiveSet.Add($address) }
  $database = Get-Database $headers

  $rows = @(Get-D1Rows $database.id "SELECT mailbox_id,address,display_name,can_receive,can_send,active,COALESCE(routing_managed,0) AS routing_managed FROM mailboxes ORDER BY address" @() $headers)
  $inserted = New-Object System.Collections.Generic.List[string]
  $activated = New-Object System.Collections.Generic.List[string]
  $deactivated = New-Object System.Collections.Generic.List[string]

  if ($Mode -eq "Sync") {
    $byAddress = @{}
    foreach ($row in $rows) { $byAddress[([string]$row.address).ToLowerInvariant()] = $row }
    $desiredSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($address in $desiredAddresses) { $null = $desiredSet.Add($address) }

    foreach ($address in $desiredAddresses) {
      $canReceive = if ($receiveSet.Contains($address)) { 1 } else { 0 }
      $existing = $byAddress[$address]
      if ($existing) {
        Invoke-D1Query $database.id "UPDATE mailboxes SET can_receive=?,can_send=1,active=1,routing_managed=1,updated_at=datetime('now') WHERE mailbox_id=?" @($canReceive,[string]$existing.mailbox_id) $headers | Out-Null
        if (-not [bool]$existing.active -or -not [bool]$existing.can_send -or -not [bool]$existing.routing_managed) {
          $activated.Add($address)
        }
      } else {
        $mailboxId = Get-StableMailboxId $address
        $displayName = Get-DisplayName $address
        Invoke-D1Query $database.id "INSERT INTO mailboxes(mailbox_id,address,display_name,can_receive,can_send,active,routing_managed,created_at,updated_at) VALUES(?,?,?,?,1,1,1,datetime('now'),datetime('now'))" @($mailboxId,$address,$displayName,$canReceive) $headers | Out-Null
        $inserted.Add($address)
      }
    }

    foreach ($row in $rows) {
      $address = ([string]$row.address).ToLowerInvariant()
      if ([bool]$row.routing_managed -and -not $desiredSet.Contains($address)) {
        Invoke-D1Query $database.id "UPDATE mailboxes SET can_receive=0,can_send=0,active=0,updated_at=datetime('now') WHERE mailbox_id=? AND routing_managed=1" @([string]$row.mailbox_id) $headers | Out-Null
        $deactivated.Add($address)
      }
    }
  }

  $activeRows = @(Get-D1Rows $database.id "SELECT address FROM mailboxes WHERE active=1 AND routing_managed=1 ORDER BY address" @() $headers)
  $actualAddresses = @($activeRows | ForEach-Object { ([string]$_.address).ToLowerInvariant() })
  $comparison = Compare-AddressSets $desiredAddresses $actualAddresses
  $report = [ordered]@{
    schema_version = 1
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
    mode = $Mode
    phase = $Phase
    domain = $Domain
    worker = $WorkerName
    database = $DatabaseName
    database_id = $database.id
    canonical_route_addresses = $canonicalRouteAddresses
    send_only_addresses = @($desiredAddresses | Where-Object { -not $receiveSet.Contains($_) })
    desired_active_addresses = $desiredAddresses
    actual_active_addresses = $actualAddresses
    inserted = $inserted.ToArray()
    activated = $activated.ToArray()
    deactivated = $deactivated.ToArray()
    missing = $comparison.missing
    unexpected = $comparison.unexpected
    ready = [bool]$comparison.equal
  }
  Write-Report $report
  if (-not $comparison.equal) {
    throw "Routing-managed D1 mailboxes do not match the required route-derived identities. Missing=$($comparison.missing -join ','); unexpected=$($comparison.unexpected -join ',')."
  }
  Write-Host "Routing-managed mailbox identities are synchronized: $($actualAddresses -join ', ')"
} finally {
  $tokenPlaintext = $null
}
