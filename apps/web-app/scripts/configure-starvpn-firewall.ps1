$workspace = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime-paths.ps1')

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Administrator privileges are required. Open PowerShell as Administrator and run this script again.'
}

$privateIp = $env:MOBILE_CODEX_PRIVATE_IP
if (-not $privateIp) {
  $envFile = Join-Path $workspace '.env'
  if (Test-Path $envFile) {
    $configuredLine = Get-Content -LiteralPath $envFile | Where-Object {
      $_ -match '^\s*MOBILE_CODEX_PRIVATE_IP\s*='
    } | Select-Object -Last 1
    if ($configuredLine) {
      $privateIp = (($configuredLine -split '=', 2)[1]).Trim().Trim('"').Trim("'")
    }
  }
}

$parsedAddress = $null
if (-not $privateIp -or
    -not [System.Net.IPAddress]::TryParse($privateIp, [ref]$parsedAddress) -or
    $parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
  throw "MOBILE_CODEX_PRIVATE_IP must be a valid IPv4 address: $privateIp"
}

$nginxPath = Resolve-MobileCodexNginxPath
$blockingRules = Get-NetFirewallApplicationFilter -Program $nginxPath -ErrorAction SilentlyContinue |
  Get-NetFirewallRule |
  Where-Object {
    $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.Enabled -eq 'True'
  }

if ($blockingRules) {
  $blockingRules | Disable-NetFirewallRule | Out-Null
}

$ruleName = 'MobileCodexHelper-StarVPN-8080'
Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule `
  -Name $ruleName `
  -DisplayName "Mobile Codex - StarVPN ${privateIp}:8080" `
  -Direction Inbound `
  -Action Allow `
  -Enabled True `
  -Profile Any `
  -InterfaceAlias 'StarVPN' `
  -LocalAddress $privateIp `
  -Protocol TCP `
  -LocalPort 8080 `
  -Program $nginxPath | Out-Null

Write-Output "Allowed Mobile Codex on StarVPN only: http://${privateIp}:8080"
