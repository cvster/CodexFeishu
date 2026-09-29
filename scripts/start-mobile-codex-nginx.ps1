param(
  [switch]$Foreground
)

$workspace = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime-paths.ps1')
$asciiAlias = Resolve-MobileCodexAsciiAliasPath

if (-not $env:MOBILE_CODEX_PRIVATE_IP) {
  $envFile = Join-Path $workspace '.env'
  if (Test-Path $envFile) {
    $configuredLine = Get-Content -LiteralPath $envFile | Where-Object {
      $_ -match '^\s*MOBILE_CODEX_PRIVATE_IP\s*='
    } | Select-Object -Last 1
    if ($configuredLine) {
      $env:MOBILE_CODEX_PRIVATE_IP = (($configuredLine -split '=', 2)[1]).Trim().Trim('"').Trim("'")
    }
  }
}

if (-not (Test-Path $asciiAlias)) {
  New-Item -ItemType Junction -Path $asciiAlias -Target $workspace | Out-Null
}

$nginxCmd = Resolve-MobileCodexNginxPath
$env:MOBILE_CODEX_NGINX = $nginxCmd

# Starting the stack repeatedly must not accumulate Windows nginx masters and
# orphaned workers that keep serving an older configuration.
$stopScript = Join-Path $PSScriptRoot 'stop-mobile-codex-nginx.ps1'
if (Test-Path $stopScript) {
  powershell -NoProfile -ExecutionPolicy Bypass -File $stopScript | Out-Null
}

$nginxRoot = Join-Path $asciiAlias '.runtime\nginx'
$confRoot = Join-Path $nginxRoot 'conf'
$logsRoot = Join-Path $nginxRoot 'logs'
$tempRoot = Join-Path $nginxRoot 'temp'
New-Item -ItemType Directory -Force -Path $confRoot | Out-Null
New-Item -ItemType Directory -Force -Path $logsRoot | Out-Null
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

$generatedConfig = Join-Path $confRoot 'mobile-codex-nginx.conf'
Copy-Item -Force (Join-Path $workspace 'deploy\nginx-mobile-codex.conf') $generatedConfig
Copy-Item -Force (Join-Path $workspace 'deploy\nginx-mime.types') (Join-Path $confRoot 'mime.types')

$privateListen = ''
if ($env:MOBILE_CODEX_PRIVATE_IP) {
  $parsedAddress = $null
  if (-not [System.Net.IPAddress]::TryParse($env:MOBILE_CODEX_PRIVATE_IP, [ref]$parsedAddress) -or
      $parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    throw "MOBILE_CODEX_PRIVATE_IP must be a valid IPv4 address: $($env:MOBILE_CODEX_PRIVATE_IP)"
  }
  $privateListen = "listen       $($env:MOBILE_CODEX_PRIVATE_IP):8080;"
}

$configText = Get-Content -Raw -LiteralPath $generatedConfig
$configText = $configText.Replace('# MOBILE_CODEX_PRIVATE_LISTEN', $privateListen)
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($generatedConfig, $configText, $utf8WithoutBom)

if ($Foreground) {
  # Keep the scheduled task alive with nginx as its foreground child. Processes
  # launched by an interactive Codex turn can be reclaimed when that turn ends.
  & $nginxCmd '-p' $nginxRoot '-c' 'conf/mobile-codex-nginx.conf' '-g' 'daemon off;'
  exit $LASTEXITCODE
}

Start-Process -FilePath $nginxCmd -ArgumentList @('-p', $nginxRoot, '-c', 'conf/mobile-codex-nginx.conf') -WindowStyle Hidden | Out-Null
