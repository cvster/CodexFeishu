$workspace = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime-paths.ps1')
$asciiAlias = Resolve-MobileCodexAsciiAliasPath

if (-not (Test-Path $asciiAlias)) {
  New-Item -ItemType Junction -Path $asciiAlias -Target $workspace | Out-Null
}

$nginxCmd = Resolve-MobileCodexNginxPath
$env:MOBILE_CODEX_NGINX = $nginxCmd

$nginxRoot = Join-Path $asciiAlias '.runtime\nginx'
$confRoot = Join-Path $nginxRoot 'conf'
$logsRoot = Join-Path $nginxRoot 'logs'
$tempRoot = Join-Path $nginxRoot 'temp'
New-Item -ItemType Directory -Force -Path $confRoot | Out-Null
New-Item -ItemType Directory -Force -Path $logsRoot | Out-Null
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

Copy-Item -Force (Join-Path $workspace 'deploy\nginx-mobile-codex.conf') (Join-Path $confRoot 'mobile-codex-nginx.conf')
Copy-Item -Force (Join-Path $workspace 'deploy\nginx-mime.types') (Join-Path $confRoot 'mime.types')

Start-Process -FilePath $nginxCmd -ArgumentList @('-p', $nginxRoot, '-c', 'conf/mobile-codex-nginx.conf') -WindowStyle Hidden | Out-Null
