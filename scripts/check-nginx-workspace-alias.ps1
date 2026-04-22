$workspace = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime-paths.ps1')
$asciiAlias = Resolve-MobileCodexAsciiAliasPath

if (-not (Test-Path $asciiAlias)) {
  New-Item -ItemType Junction -Path $asciiAlias -Target $workspace | Out-Null
}

$nginxRoot = Join-Path $asciiAlias '.runtime\nginx'
New-Item -ItemType Directory -Force -Path (Join-Path $nginxRoot 'logs') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $nginxRoot 'temp') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $nginxRoot 'conf') | Out-Null

[PSCustomObject]@{
  Workspace = $workspace
  AsciiAlias = $asciiAlias
  NginxRoot = $nginxRoot
} | Format-List
