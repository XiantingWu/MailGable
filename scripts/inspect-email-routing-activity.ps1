[CmdletBinding()]
param(
  [string]$ZoneId = "",
  [Security.SecureString]$CloudflareToken,
  [datetime]$StartUtc = [DateTime]::UtcNow.AddHours(-6),
  [datetime]$EndUtc = [DateTime]::UtcNow.AddMinutes(5),
  [ValidateRange(1, 1000)]
  [int]$Limit = 500,
  [string]$InternetMessageId = "",
  [string]$SubjectContains = "",
  [string]$RecipientContains = "",
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$graphqlEndpoint = "https://api.cloudflare.com/client/v4/graphql"
$tokenPlaintext = $null

function ConvertFrom-Secure([Security.SecureString]$Value) {
  if ($null -eq $Value) { throw "Cloudflare token is required." }
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Normalize-MessageId([object]$Value) {
  return ([string]$Value).Trim()
}

function Contains-IgnoreCase([object]$Value, [string]$Needle) {
  if ([string]::IsNullOrWhiteSpace($Needle)) { return $true }
  return ([string]$Value).IndexOf($Needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Escape-GraphQLString([string]$Value) {
  return ([string]$Value).Replace('\', '\\').Replace('"', '\"').Replace("`r", '\\r').Replace("`n", '\\n')
}

if ($EndUtc -le $StartUtc) { throw "EndUtc must be later than StartUtc." }
if (($EndUtc.ToUniversalTime() - $StartUtc.ToUniversalTime()).TotalDays -gt 31) {
  throw "Email Routing analytics are retained for 31 days; query a window of 31 days or less."
}
if ([string]::IsNullOrWhiteSpace($ZoneId)) { throw "ZoneId is required." }
if ($null -eq $CloudflareToken) {
  $CloudflareToken = Read-Host "Cloudflare API token with Analytics Read" -AsSecureString
}

$variables = [ordered]@{
  zoneTag = $ZoneId
  filter = [ordered]@{
    datetime_geq = $StartUtc.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    datetime_leq = $EndUtc.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  }
}
$zoneTagLiteral = Escape-GraphQLString $variables.zoneTag
$startLiteral = Escape-GraphQLString $variables.filter.datetime_geq
$endLiteral = Escape-GraphQLString $variables.filter.datetime_leq
$query = @"
query {
  viewer {
    zones(filter: { zoneTag: "$zoneTagLiteral" }) {
      emailRoutingAdaptive(
        filter: { datetime_geq: "$startLiteral", datetime_leq: "$endLiteral" }
        limit: $Limit
        orderBy: [datetime_DESC]
      ) {
        datetime
        sessionId
        messageId
        from
        to
        subject
        status
        eventType
        action
        spf
        dkim
        dmarc
        arc
        errorDetail
        isNDR
        isSpam
        isLastEvent
      }
    }
  }
}
"@
$query = ($query -replace '\s+', ' ').Trim()
$body = [ordered]@{ query = $query } | ConvertTo-Json -Depth 20

try {
  $tokenPlaintext = ConvertFrom-Secure $CloudflareToken
  $headers = @{
    Authorization = "Bearer $tokenPlaintext"
    Accept = "application/json"
    "Content-Type" = "application/json"
  }
  $response = (Invoke-WebRequest -Method Post -Uri $graphqlEndpoint -Headers $headers -Body $body).Content | ConvertFrom-Json
} finally {
  $tokenPlaintext = $null
}

$apiErrors = @($response.errors | Where-Object { $null -ne $_ })
if ($apiErrors.Count -gt 0) {
  $messages = @($apiErrors | ForEach-Object { [string]$_.message }) -join "; "
  throw "Cloudflare GraphQL returned errors: $messages"
}
$zones = @($response.data.viewer.zones)
if ($zones.Count -ne 1) {
  throw "Cloudflare GraphQL did not return exactly one zone for ZoneId '$ZoneId'."
}

$events = @($zones[0].emailRoutingAdaptive)
$messageIdFilter = Normalize-MessageId $InternetMessageId
if ($messageIdFilter) {
  $events = @($events | Where-Object { (Normalize-MessageId $_.messageId) -eq $messageIdFilter })
}
if (-not [string]::IsNullOrWhiteSpace($SubjectContains)) {
  $events = @($events | Where-Object { Contains-IgnoreCase $_.subject $SubjectContains })
}
if (-not [string]::IsNullOrWhiteSpace($RecipientContains)) {
  $events = @($events | Where-Object { Contains-IgnoreCase $_.to $RecipientContains })
}

$events = @($events | Sort-Object { [datetime]$_.datetime })
$report = @($events | ForEach-Object {
  [pscustomobject][ordered]@{
    datetime = [string]$_.datetime
    session_id = [string]$_.sessionId
    internet_message_id = [string]$_.messageId
    from = [string]$_.from
    to = [string]$_.to
    subject = [string]$_.subject
    event_type = [string]$_.eventType
    action = [string]$_.action
    status = [string]$_.status
    is_last_event = [int]$_.isLastEvent
    error_detail = [string]$_.errorDetail
    spf = [string]$_.spf
    dkim = [string]$_.dkim
    dmarc = [string]$_.dmarc
    arc = [string]$_.arc
    is_ndr = [int]$_.isNDR
    is_spam = [int]$_.isSpam
    rule_matched = [string]$_.ruleMatched
  }
})

Write-Host "Email Routing activity: $($report.Count) matching event(s) between $($variables.filter.datetime_geq) and $($variables.filter.datetime_leq)."
if ($report.Count -gt 0) {
  $report | Format-Table datetime,event_type,action,status,is_last_event,to,internet_message_id,error_detail -AutoSize
  Write-Host "Final-event status summary:"
  @($report | Where-Object { $_.is_last_event -eq 1 } | Group-Object status | Sort-Object Name) |
    ForEach-Object { Write-Host "  $($_.Name): $($_.Count)" }
} else {
  Write-Host "No matching Email Routing events were returned. Widen the time window before changing forwarding code."
}

if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
  $parent = Split-Path -Parent $OutputPath
  if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $report | ConvertTo-Json -Depth 10 | Set-Content -Path $OutputPath -Encoding utf8
  Write-Host "Wrote routing activity report to $OutputPath"
}

$report
