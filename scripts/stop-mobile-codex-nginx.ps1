. (Join-Path $PSScriptRoot 'runtime-paths.ps1')
$asciiAlias = Resolve-MobileCodexAsciiAliasPath

$pidFile = Join-Path $asciiAlias '.runtime\nginx\logs\mobile-codex.pid'
if (Test-Path $pidFile) {
  $pidValue = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pidValue -match '^\d+$') {
    Stop-Process -Id ([int]$pidValue) -Force -ErrorAction SilentlyContinue
  }
}

$listener = Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue
if ($listener) {
  $listener | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
  }
}
