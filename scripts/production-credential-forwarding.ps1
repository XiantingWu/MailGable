function New-ProductionSecureString([string]$Value, [string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "Required credential '$Name' is missing or empty."
  }
  return ConvertTo-SecureString $Value -AsPlainText -Force
}

function Clear-ProductionSecureString([Security.SecureString]$Value) {
  if ($null -ne $Value) {
    $Value.Dispose()
  }
}

function Assert-ProductionDevVarsLocalOnly([string]$RepositoryRoot, [string]$DevVarsPath) {
  if (-not (Test-Path -LiteralPath $DevVarsPath -PathType Leaf)) {
    throw "Repository-root .dev.vars is missing."
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is required to verify that .dev.vars is local-only."
  }

  & git -C $RepositoryRoot check-ignore --quiet --no-index -- ".dev.vars" 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw ".dev.vars is not ignored by Git. Refusing to read privileged production credentials."
  }

  & git -C $RepositoryRoot ls-files --error-unmatch -- ".dev.vars" 2>$null
  if ($LASTEXITCODE -eq 0) {
    throw ".dev.vars is tracked by Git. Remove it from the index before continuing."
  }
}

function Invoke-WithProductionCredentials {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Preflight", "Deploy", "Reconcile")]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [hashtable]$Values,

    [Parameter(Mandatory = $true)]
    [scriptblock]$Invocation,

    [switch]$RequireResendSetupKey,

    [switch]$IncludeResendSetupKeyIfPresent,

    [switch]$RequireAdminPassword
  )

  $secureValues = @{}
  $cloudflareApiToken = $null
  $previousCloudflareApiToken = $env:CLOUDFLARE_API_TOKEN
  $cloudflareVariableName = if ($Action -eq "Preflight") {
    "CLOUDFLARE_READ_TOKEN"
  } else {
    "CLOUDFLARE_DEPLOY_TOKEN"
  }

  try {
    if (-not $Values.ContainsKey($cloudflareVariableName)) {
      throw "Required credential '$cloudflareVariableName' is missing."
    }

    $cloudflareApiToken = [string]$Values[$cloudflareVariableName]
    if ([string]::IsNullOrWhiteSpace($cloudflareApiToken)) {
      throw "Required credential '$cloudflareVariableName' is missing or empty."
    }

    # Wrangler reads this environment variable in its child process. It is
    # restored before this function returns, including when the child fails.
    $env:CLOUDFLARE_API_TOKEN = $cloudflareApiToken

    if ($Action -eq "Preflight") {
      $secureValues.CloudflareReadToken = New-ProductionSecureString $cloudflareApiToken $cloudflareVariableName
    } else {
      $secureValues.CloudflareDeployToken = New-ProductionSecureString $cloudflareApiToken $cloudflareVariableName
    }

    $hasResendSetupKey = $Values.ContainsKey("RESEND_SETUP_FULL_ACCESS_KEY") -and
      -not [string]::IsNullOrWhiteSpace([string]$Values["RESEND_SETUP_FULL_ACCESS_KEY"])
    if ($RequireResendSetupKey -and -not $hasResendSetupKey) {
      throw "Required credential 'RESEND_SETUP_FULL_ACCESS_KEY' is missing or empty."
    }
    if ($RequireResendSetupKey -or ($IncludeResendSetupKeyIfPresent -and $hasResendSetupKey)) {
      $secureValues.ResendSetupKey = New-ProductionSecureString ([string]$Values["RESEND_SETUP_FULL_ACCESS_KEY"]) "RESEND_SETUP_FULL_ACCESS_KEY"
    }

    if ($Action -eq "Deploy") {
      if (-not $Values.ContainsKey("RESEND_PRODUCTION_SENDING_ACCESS_KEY")) {
        throw "Required credential 'RESEND_PRODUCTION_SENDING_ACCESS_KEY' is missing."
      }
      $secureValues.ResendSendingKey = New-ProductionSecureString ([string]$Values["RESEND_PRODUCTION_SENDING_ACCESS_KEY"]) "RESEND_PRODUCTION_SENDING_ACCESS_KEY"

      if ($RequireAdminPassword) {
        if (-not $Values.ContainsKey("MAILBOX_ADMIN_PASSWORD")) {
          throw "Required credential 'MAILBOX_ADMIN_PASSWORD' is missing."
        }
        $secureValues.AdminPasswordSecure = New-ProductionSecureString ([string]$Values["MAILBOX_ADMIN_PASSWORD"]) "MAILBOX_ADMIN_PASSWORD"
      }
    }

    & $Invocation $secureValues
  } finally {
    if ($null -eq $previousCloudflareApiToken) {
      Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
    } else {
      $env:CLOUDFLARE_API_TOKEN = $previousCloudflareApiToken
    }

    foreach ($name in @($secureValues.Keys)) {
      Clear-ProductionSecureString $secureValues[$name]
      $secureValues[$name] = $null
    }
    $secureValues.Clear()

    $cloudflareApiToken = $null
    foreach ($name in @($Values.Keys)) {
      $Values[$name] = $null
    }
    $Values.Clear()
  }
}
