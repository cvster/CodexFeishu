. (Join-Path $PSScriptRoot 'runtime-paths.ps1')
$asciiAlias = Resolve-MobileCodexAsciiAliasPath
$nginxRoot = Join-Path $asciiAlias '.runtime\nginx'
$nginxRootPattern = [regex]::Escape($nginxRoot)
$configPattern = 'conf[/\\]mobile-codex-nginx\.conf'

$pidFile = Join-Path $asciiAlias '.runtime\nginx\logs\mobile-codex.pid'
if (Test-Path $pidFile) {
  $pidValue = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pidValue -match '^\d+$') {
    Stop-Process -Id ([int]$pidValue) -Force -ErrorAction SilentlyContinue
  }
}

# The Windows nginx master can leave inherited worker processes listening after
# the PID-file process exits. Reap every process that belongs to this exact
# prefix/config pair, including workers orphaned by an earlier hard stop.
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  $relatedProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq 'nginx.exe' -and
    $_.CommandLine -match $nginxRootPattern -and
    $_.CommandLine -match $configPattern
  })

  if ($relatedProcesses.Count -eq 0) {
    break
  }

  $relatedProcesses | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 250
}
