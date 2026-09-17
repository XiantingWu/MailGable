[CmdletBinding()]
param(
  [string]$AdminEmail = "admin@example.com",
  [string]$DatabaseName = "mailgable-db",
  [string]$ConfigTemplate = "wrangler.jsonc"

)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

function ConvertFrom-Secure([Security.SecureString]$Value) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
  return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

function Escape-Sql([string]$Value) {
  return $Value.Replace("'", "''")
}

function Find-Count($Value) {
  if ($null -eq $Value) { return $null }
  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    foreach ($item in $Value) {
      $found = Find-Count $item
      if ($null -ne $found) { return $found }
    }
  }
  if ($Value.PSObject -and $Value.PSObject.Properties["count"]) {
    return [int]$Value.count
  }
  if ($Value.PSObject) {
    foreach ($property in $Value.PSObject.Properties) {
      $found = Find-Count $property.Value
      if ($null -ne $found) { return $found }
    }
  }
  return $null
}

if (-not (Test-Path $ConfigTemplate)) { throw "Wrangler template not found: $ConfigTemplate" }
if ($AdminEmail -notmatch '^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$') { throw "Administrator email is invalid." }

Write-Host "[1/5] Checking Cloudflare authentication and resolving the canonical dev D1..."
& npx wrangler whoami --config $ConfigTemplate
if ($LASTEXITCODE -ne 0) { throw "Wrangler authentication failed." }
$databases = (& npx wrangler d1 list --json --config $ConfigTemplate | ConvertFrom-Json)
$database = $databases | Where-Object { $_.name -eq $DatabaseName } | Select-Object -First 1
$databaseId = if ($database.uuid) { [string]$database.uuid } elseif ($database.id) { [string]$database.id } else { "" }
if (-not $databaseId) { throw "Canonical D1 database '$DatabaseName' was not found." }

$tempConfig = [IO.Path]::GetTempFileName()
$tempSql = [IO.Path]::GetTempFileName()
$passwordText = $null
try {
  $config = Get-Content -Raw $ConfigTemplate | ConvertFrom-Json
  $config.d1_databases[0].database_name = $DatabaseName
  $config.d1_databases[0].database_id = $databaseId
  $config | ConvertTo-Json -Depth 30 | Set-Content -Encoding UTF8 $tempConfig

  Write-Host "[2/5] Confirming the configured administrator exists..."
  $escapedEmail = Escape-Sql $AdminEmail.ToLowerInvariant()
  $lookup = & npx wrangler d1 execute DB --remote --command "SELECT COUNT(*) AS count FROM admins WHERE email='$escapedEmail' COLLATE NOCASE;" --json --config $tempConfig
  if ($LASTEXITCODE -ne 0) { throw "Could not query the canonical dev D1." }
  $parsedLookup = ($lookup | Out-String) | ConvertFrom-Json
  $count = Find-Count $parsedLookup
  if ($count -ne 1) { throw "Exactly one active administrator record for $AdminEmail is required; found $count." }

  Write-Host "[3/5] Reading and validating the replacement password..."
  $passwordText = ConvertFrom-Secure (Read-Host "New administrator password (15-128 characters)" -AsSecureString)
  $codePoints = $passwordText.ToCharArray().Length
  if ($codePoints -lt 15 -or $codePoints -gt 128) {
    throw "Password must be between 15 and 128 characters."
  }

  Write-Host "[4/5] Deriving PBKDF2-SHA256 with the configured iteration count..."
  $configuredIterations = [string]$config.vars.PASSWORD_ITERATIONS
  $iterations = 8000
  if ($configuredIterations -match '^\d+$') {
    $parsedIterations = [int]$configuredIterations
    if ($parsedIterations -ge 8000 -and $parsedIterations -le 100000) { $iterations = $parsedIterations }
  }
  Write-Host "  Using PASSWORD_ITERATIONS=$iterations from the deployment configuration."
  $salt = New-Object byte[] 16
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($salt) } finally { $rng.Dispose() }
  $derive = [Security.Cryptography.Rfc2898DeriveBytes]::new(
    $passwordText,
    $salt,
    $iterations,
    [Security.Cryptography.HashAlgorithmName]::SHA256
  )
  try { $hashBytes = $derive.GetBytes(32) } finally { $derive.Dispose() }
  $saltValue = ConvertTo-Base64Url $salt
  $hashValue = ConvertTo-Base64Url $hashBytes
  $timestamp = [DateTime]::UtcNow.ToString("o")
  $auditId = [guid]::NewGuid().ToString()

  $sql = @"
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
UPDATE admins
   SET password_hash='$hashValue',
       password_salt='$saltValue',
        password_iterations=$iterations,

        password_scheme='pbkdf2-sha256-legacy',
       updated_at='$timestamp'
 WHERE email='$escapedEmail' COLLATE NOCASE;
UPDATE admin_sessions
   SET revoked_at=COALESCE(revoked_at,'$timestamp')
 WHERE admin_id IN (SELECT admin_id FROM admins WHERE email='$escapedEmail' COLLATE NOCASE);
INSERT INTO admin_audit_log(audit_id,admin_id,action,target_type,target_id,details_json,created_at)
SELECT '$auditId',admin_id,'auth_password_recovered','admin',admin_id,'{"method":"local_d1_recovery","sessions_revoked":true}','$timestamp'
  FROM admins WHERE email='$escapedEmail' COLLATE NOCASE;
COMMIT;
"@
  [IO.File]::WriteAllText($tempSql, $sql)

  Write-Host "[5/5] Updating the canonical dev D1 and revoking every administrator session..."
  & npx wrangler d1 execute DB --remote --file $tempSql --config $tempConfig
  if ($LASTEXITCODE -ne 0) { throw "Administrator password recovery failed." }
  Write-Host "Administrator password reset completed. All previous sessions were revoked."
  Write-Host "Sign in only at the canonical dev mailbox or through the main-domain redirect."
} finally {
  $passwordText = $null
  Remove-Item $tempSql -Force -ErrorAction SilentlyContinue
  Remove-Item $tempConfig -Force -ErrorAction SilentlyContinue
}
