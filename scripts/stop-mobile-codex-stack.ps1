$workspace = Split-Path -Parent $PSScriptRoot
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $workspace 'scripts\stop-mobile-codex-nginx.ps1') | Out-Null

$workspacePattern = [regex]::Escape($workspace)
$relatedProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  ($_.Name -eq 'node.exe' -and $_.CommandLine -match "$workspacePattern.*server[\\/]index\.js") -or
  ($_.Name -eq 'powershell.exe' -and $_.CommandLine -match "$workspacePattern.*scripts[\\/]start-mobile-codex\.ps1")
}

foreach ($process in $relatedProcesses) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

$ports = @(3001, 8080)
foreach ($port in $ports) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  if ($listener) {
    $listener | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
      Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
    }
  }
}

for ($attempt = 0; $attempt -lt 20; $attempt++) {
  $remaining = Get-NetTCPConnection -State Listen -LocalPort $ports -ErrorAction SilentlyContinue
  if (-not $remaining) {
    break
  }

  Start-Sleep -Milliseconds 250
}
