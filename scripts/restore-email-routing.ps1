[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact="High")]
param(
  [Parameter(Mandatory=$true)][string]$BackupFile,
  [string]$AccountId = "",
  [string]$Domain = "example.com",
  [string]$ZoneId = "",
  [Security.SecureString]$CloudflareToken,
  [string]$SafetyBackupPath = ""
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath $BackupFile -PathType Leaf)) {
  throw "Backup file not found: $BackupFile"
}

$rulesEndpoint = "https://api.cloudflare.com/client/v4/zones/$ZoneId/email/routing/rules"
$catchAllEndpoint = "$rulesEndpoint/catch_all"
$domainNormalized = $Domain.Trim().ToLowerInvariant()
$domainPattern = [regex]::Escape($domainNormalized)
$tokenPlaintext = $null

function ConvertFrom-Secure([Security.SecureString]$Value) {
  if ($null -eq $Value) {
    $Value = Read-Host "Cloudflare API token with Email Routing Rules Read/Write" -AsSecureString
  }
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
    foreach ($item in @($response.result)) {
      if ($null -ne $item) { $all.Add($item) }
    }
    $pages = if ($response.result_info -and $response.result_info.total_pages) {
      [int]$response.result_info.total_pages
    } else { 1 }
    $page += 1
  } while ($page -le $pages)
  return $all.ToArray()
}

function Get-CatchAll([hashtable]$Headers) {
  $response = Invoke-Cf Get $catchAllEndpoint $Headers $null -AllowNotFound
  if ($response) { return $response.result }
  return $null
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
    throw "Email Routing rule $([string]$Rule.id) has an ambiguous matcher set for $domainNormalized."
  }
  return Normalize-Email $domainMatchers[0].value
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

function Assert-ApiManaged([object[]]$Rules, [string]$Scope) {
  $wrangler = @($Rules | Where-Object { [string]$_.source -eq "wrangler" })
  if ($wrangler.Count -gt 0) {
    $ids = ($wrangler | ForEach-Object { [string]$_.id }) -join ", "
    throw "$Scope contains Wrangler-managed Email Routing rules ($ids). Refusing API restoration."
  }
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
  if ($null -eq $Rule) { return $null }
  return [ordered]@{
    name = [string]$Rule.name
    enabled = [bool]$Rule.enabled
    matchers = @($Rule.matchers)
    actions = @($Rule.actions)
  }
}

function Get-ComparableJson($Rule, [switch]$CatchAll) {
  $payload = if ($CatchAll) { Get-CatchAllPayload $Rule } else { Get-RulePayload $Rule }
  if ($null -eq $payload) { return "null" }
  return ($payload | ConvertTo-Json -Depth 30 -Compress)
}

function Get-ComparableMultiset([object[]]$Rules) {
  return @($Rules | ForEach-Object { Get-ComparableJson $_ } | Sort-Object)
}

function Assert-SnapshotMatches([object[]]$ExpectedRules, $ExpectedCatchAll, [hashtable]$Headers) {
  $actualRules = @(Get-AllPagedResults $rulesEndpoint $Headers)
  $actualCatchAll = Get-CatchAll $Headers
  $expectedGroups = Get-DomainGroups $ExpectedRules
  $actualGroups = Get-DomainGroups $actualRules
  $addresses = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($address in @($expectedGroups.Keys)) { $null = $addresses.Add([string]$address) }
  foreach ($address in @($actualGroups.Keys)) { $null = $addresses.Add([string]$address) }

  foreach ($address in @($addresses | Sort-Object)) {
    $expected = if ($expectedGroups.ContainsKey($address)) {
      @(Get-ComparableMultiset -Rules @($expectedGroups[$address]))
    } else { @() }
    $actual = if ($actualGroups.ContainsKey($address)) {
      @(Get-ComparableMultiset -Rules @($actualGroups[$address]))
    } else { @() }
    if ($expected.Count -ne $actual.Count -or (Compare-Object $expected $actual)) {
      throw "Restored routing rules do not match the backup for $address."
    }
  }

  $expectedCatchAllJson = Get-ComparableJson $ExpectedCatchAll -CatchAll
  $actualCatchAllJson = Get-ComparableJson $actualCatchAll -CatchAll
  if ($expectedCatchAllJson -ne $actualCatchAllJson) {
    throw "Restored catch-all does not match the backup."
  }
}

function Apply-DomainSnapshot([object[]]$DesiredRules, $DesiredCatchAll, [hashtable]$Headers) {
  $currentRules = @(Get-AllPagedResults $rulesEndpoint $Headers)
  $currentCatchAll = Get-CatchAll $Headers
  $desiredGroups = Get-DomainGroups $DesiredRules
  $currentGroups = Get-DomainGroups $currentRules
  $desiredDomainRules = @($DesiredRules | Where-Object { Get-LiteralDomainAddress $_ })
  $currentDomainRules = @($currentRules | Where-Object { Get-LiteralDomainAddress $_ })
  Assert-ApiManaged $desiredDomainRules "Backup literal domain routing"
  Assert-ApiManaged $currentDomainRules "Current literal domain routing"
  if ($DesiredCatchAll -and [string]$DesiredCatchAll.source -eq "wrangler") {
    throw "Backup catch-all is Wrangler-managed and cannot be restored through this API script."
  }
  if ($currentCatchAll -and [string]$currentCatchAll.source -eq "wrangler") {
    throw "Current catch-all is Wrangler-managed and cannot be restored through this API script."
  }
  if (-not $DesiredCatchAll -and $currentCatchAll) {
    throw "The backup has no catch-all but the current zone does. Cloudflare exposes no catch-all delete operation; refusing an inexact restore."
  }

  $addresses = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($address in @($desiredGroups.Keys)) { $null = $addresses.Add([string]$address) }
  foreach ($address in @($currentGroups.Keys)) { $null = $addresses.Add([string]$address) }

  foreach ($address in @($addresses | Sort-Object)) {
    $desired = if ($desiredGroups.ContainsKey($address)) {
      @($desiredGroups[$address] | Sort-Object { [string]$_.id })
    } else { @() }
    $existing = if ($currentGroups.ContainsKey($address)) {
      @($currentGroups[$address] | Sort-Object { [string]$_.id })
    } else { @() }
    $usedIds = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

    foreach ($desiredRule in $desired) {
      $target = @($existing | Where-Object {
        -not $usedIds.Contains([string]$_.id) -and [string]$_.id -eq [string]$desiredRule.id
      }) | Select-Object -First 1
      if (-not $target) {
        $target = @($existing | Where-Object { -not $usedIds.Contains([string]$_.id) }) | Select-Object -First 1
      }
      $payload = Get-RulePayload $desiredRule
      if ($target) {
        Invoke-Cf Put "$rulesEndpoint/$($target.id)" $Headers $payload | Out-Null
        $null = $usedIds.Add([string]$target.id)
      } else {
        $result = Invoke-Cf Post $rulesEndpoint $Headers $payload
        $createdId = [string]$result.result.id
        if (-not $createdId) { throw "Cloudflare did not return the recreated rule ID for $address." }
        $null = $usedIds.Add($createdId)
      }
    }

    foreach ($extra in @($existing | Where-Object { -not $usedIds.Contains([string]$_.id) })) {
      Invoke-Cf Delete "$rulesEndpoint/$($extra.id)" $Headers | Out-Null
    }
  }

  if ($DesiredCatchAll) {
    Invoke-Cf Put $catchAllEndpoint $Headers (Get-CatchAllPayload $DesiredCatchAll) | Out-Null
  }
  Assert-SnapshotMatches $DesiredRules $DesiredCatchAll $Headers
}

function Write-Snapshot([string]$Path, [object[]]$Rules, $CatchAll, [string]$Kind) {
  $parent = Split-Path -Parent $Path
  if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $snapshot = [ordered]@{
    schema_version = 1
    complete = $true
    kind = $Kind
    captured_at = (Get-Date).ToUniversalTime().ToString("o")
    account_id = $AccountId
    zone_id = $ZoneId
    domain = $domainNormalized
    rules = @($Rules)
    catch_all = $CatchAll
  }
  $snapshot | ConvertTo-Json -Depth 30 | Set-Content -Encoding UTF8 -LiteralPath $Path
}

function Restore-LegacyManagedAddresses($Backup, [hashtable]$Headers) {
  if (-not $Backup.success -or -not $Backup.result_info -or $Backup.result_info.complete -ne $true) {
    throw "Legacy backup is incomplete."
  }
  $currentRules = @(Get-AllPagedResults $rulesEndpoint $Headers)
  foreach ($localPart in @("support", "contact", "privacy")) {
    $address = "$localPart@$domainNormalized"
    $backupRules = @($Backup.result | Where-Object { (Get-LiteralDomainAddress $_) -eq $address })
    $currentAddressRules = @($currentRules | Where-Object { (Get-LiteralDomainAddress $_) -eq $address })
    if ($backupRules.Count -gt 1) {
      throw "Legacy backup contains multiple rules for $address and cannot be restored automatically."
    }
    $backupRule = $backupRules | Select-Object -First 1
    $target = $null
    if ($backupRule) {
      $target = $currentAddressRules | Where-Object { $_.id -eq $backupRule.id } | Select-Object -First 1
      if (-not $target) { $target = $currentAddressRules | Select-Object -First 1 }
      if ($target) {
        Invoke-Cf Put "$rulesEndpoint/$($target.id)" $Headers (Get-RulePayload $backupRule) | Out-Null
      } else {
        Invoke-Cf Post $rulesEndpoint $Headers (Get-RulePayload $backupRule) | Out-Null
      }
    }
    foreach ($extra in $currentAddressRules) {
      if ($target -and $extra.id -eq $target.id) { continue }
      Invoke-Cf Delete "$rulesEndpoint/$($extra.id)" $Headers | Out-Null
    }
  }
}

try {
  $tokenPlaintext = ConvertFrom-Secure $CloudflareToken
  if ([string]::IsNullOrWhiteSpace($tokenPlaintext)) { throw "Cloudflare API token cannot be empty." }
  $headers = @{ Authorization = "Bearer $tokenPlaintext"; "Content-Type" = "application/json" }
  try { $backup = Get-Content -Raw -LiteralPath $BackupFile | ConvertFrom-Json }
  catch { throw "Backup is not valid JSON: $BackupFile" }

  $isFullBackup = $backup.schema_version -eq 1 -and $backup.complete -eq $true -and $null -ne $backup.rules
  $isLegacyBackup = $backup.success -eq $true -and $backup.result_info.complete -eq $true -and $null -ne $backup.result
  if (-not $isFullBackup -and -not $isLegacyBackup) {
    throw "Backup format is unsupported or incomplete."
  }

  if ($isFullBackup) {
    if ([string]$backup.account_id -ne $AccountId -or [string]$backup.zone_id -ne $ZoneId -or [string]$backup.domain -ne $domainNormalized) {
      throw "Backup belongs to a different Cloudflare account, zone, or domain."
    }
    $desiredRules = @($backup.rules)
    $desiredCatchAll = $backup.catch_all
    $null = Get-DomainGroups $desiredRules
    $currentRules = @(Get-AllPagedResults $rulesEndpoint $headers)
    $currentCatchAll = Get-CatchAll $headers
    $null = Get-DomainGroups $currentRules
    if (-not $desiredCatchAll -and $currentCatchAll) {
      throw "Exact restore is impossible because the backup has no catch-all while the current zone has one."
    }
    Write-Host "Full restore plan: all literal @$domainNormalized rules plus catch-all."
    $action = "Restore complete literal-domain routing snapshot and catch-all"
  } else {
    $desiredRules = @()
    $desiredCatchAll = $null
    $currentRules = @(Get-AllPagedResults $rulesEndpoint $headers)
    $currentCatchAll = Get-CatchAll $headers
    Write-Warning "Legacy backup detected. Only support/contact/privacy will be restored; unrelated routes and catch-all remain unchanged."
    $action = "Restore legacy managed mailbox routes"
  }

  if (-not $PSCmdlet.ShouldProcess("Cloudflare zone $ZoneId ($domainNormalized)", $action)) {
    Write-Host "No Email Routing changes were made."
    return
  }

  if (-not $SafetyBackupPath) {
    $safetyDirectory = Join-Path (Join-Path (Get-Location) "deployment-backups") (Get-Date -Format "yyyyMMdd-HHmmss-fff")
    $SafetyBackupPath = Join-Path $safetyDirectory "pre-restore-email-routing.json"
  }
  Write-Snapshot $SafetyBackupPath $currentRules $currentCatchAll "pre_restore_safety"
  Write-Host "Pre-restore safety backup: $SafetyBackupPath"

  try {
    if ($isFullBackup) {
      Apply-DomainSnapshot $desiredRules $desiredCatchAll $headers
    } else {
      Restore-LegacyManagedAddresses $backup $headers
    }
  } catch {
    $restoreError = $_
    Write-Warning "Email Routing restore failed. Attempting to return to the pre-restore safety snapshot..."
    try {
      Apply-DomainSnapshot $currentRules $currentCatchAll $headers
      Write-Warning "Pre-restore state was recovered."
    } catch {
      Write-Warning "Automatic recovery of the pre-restore state failed. Preserve and use: $SafetyBackupPath"
    }
    throw $restoreError
  }

  Write-Host "Email Routing restore completed and verified from $BackupFile"
  if ($isFullBackup) {
    Write-Host "All literal @$domainNormalized rules and catch-all match the complete backup semantically."
  } else {
    Write-Host "Legacy support/contact/privacy rules were restored; unrelated rules were not modified."
  }
} finally {
  $tokenPlaintext = $null
}
