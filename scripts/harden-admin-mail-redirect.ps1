[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [string]$ZoneId = "",
  [string]$Domain = "example.com",
  [string]$RuleRef = "mailbox_admin_mail_to_dev"
)
$ErrorActionPreference = "Stop"
function ConvertFrom-Secure([Security.SecureString]$Value) { $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value); try {[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)} }
$token = ConvertFrom-Secure (Read-Host "Cloudflare token with Dynamic URL Redirects Write" -AsSecureString)
if ([string]::IsNullOrWhiteSpace($token)) { throw "Token is required." }
$headers=@{Authorization="Bearer $token";"Content-Type"="application/json"}
$phase="http_request_dynamic_redirect"
$entry=Invoke-RestMethod -Method Get -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/rulesets/phases/$phase/entrypoint" -Headers $headers
$matches=@($entry.result.rules | Where-Object {[string]$_.ref -eq $RuleRef})
if ($matches.Count -ne 1) { throw "Exactly one managed redirect rule is required; found $($matches.Count)." }
$rule=$matches[0]
$expression="((http.request.method eq `"GET`" or http.request.method eq `"HEAD`") and http.host eq `"$Domain`" and (http.request.uri.path eq `"/admin/mail`" or starts_with(http.request.uri.path, `"/admin/mail/`")))"
$payload=[ordered]@{ref=$RuleRef;description=$rule.description;expression=$expression;action="redirect";action_parameters=$rule.action_parameters;enabled=$true}
if ($PSCmdlet.ShouldProcess($RuleRef,"Restrict Single Redirect to GET and HEAD")) {
  $result=Invoke-RestMethod -Method Patch -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/rulesets/$($entry.result.id)/rules/$($rule.id)" -Headers $headers -Body ($payload|ConvertTo-Json -Depth 30)
  if (-not $result.success) { throw "Cloudflare rejected the redirect hardening update." }
}
$verify=Invoke-RestMethod -Method Get -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/rulesets/phases/$phase/entrypoint" -Headers $headers
$current=@($verify.result.rules|Where-Object {[string]$_.ref -eq $RuleRef})
if ($current.Count -ne 1 -or [string]$current[0].expression -ne $expression) { throw "Redirect hardening verification failed." }
$token=$null
Write-Host "Admin mail Single Redirect now matches only GET/HEAD and the exact path boundary."
