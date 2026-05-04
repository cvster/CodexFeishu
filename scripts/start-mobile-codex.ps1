$workspace = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime-paths.ps1')
$repo = if ($env:MOBILE_CODEX_UPSTREAM_DIR) {
  $env:MOBILE_CODEX_UPSTREAM_DIR
} else {
  Join-Path $workspace 'vendor\claudecodeui-1.25.2'
}

if (-not (Test-Path $repo)) {
  throw "Upstream checkout not found: $repo"
}

$node = Resolve-MobileCodexNodePath

$logDir = Join-Path $workspace 'tmp\logs'
$stdoutLog = Join-Path $logDir 'mobile-codex-app.stdout.log'
$stderrLog = Join-Path $logDir 'mobile-codex-app.stderr.log'

function Wait-MobileCodexLogReady {
  param(
    [string]$Path,
    [int]$RetryCount = 40,
    [int]$DelayMilliseconds = 250
  )

  for ($attempt = 0; $attempt -lt $RetryCount; $attempt++) {
    try {
      $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::ReadWrite
      )
      $stream.Dispose()
      return
    } catch {
      Start-Sleep -Milliseconds $DelayMilliseconds
    }
  }

  throw "Log file is still locked: $Path"
}

function Append-MobileCodexLogMarker {
  param(
    [string]$Path,
    [string]$Value
  )

  $stream = [System.IO.File]::Open(
    $Path,
    [System.IO.FileMode]::Append,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::ReadWrite
  )

  try {
    $writer = New-Object System.IO.StreamWriter($stream)
    $writer.Write($Value)
    $writer.Flush()
  } finally {
    if ($writer) {
      $writer.Dispose()
    } else {
      $stream.Dispose()
    }
  }
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Wait-MobileCodexLogReady -Path $stdoutLog
Wait-MobileCodexLogReady -Path $stderrLog
Append-MobileCodexLogMarker -Path $stdoutLog -Value ("`n==== START {0} ====`n" -f (Get-Date -Format s))
Append-MobileCodexLogMarker -Path $stderrLog -Value ("`n==== START {0} ====`n" -f (Get-Date -Format s))

$applyOverridesScript = Join-Path $PSScriptRoot 'apply-upstream-overrides.ps1'
if (Test-Path $applyOverridesScript) {
  powershell -NoProfile -ExecutionPolicy Bypass -File $applyOverridesScript | Write-Output
}

$overrideRoot = Join-Path $workspace 'upstream-overrides\claudecodeui-1.25.2'
$distIndex = Join-Path $repo 'dist\index.html'
if ((Test-Path $overrideRoot) -and (Test-Path $distIndex) -and -not $env:MOBILE_CODEX_ALLOW_STALE_DIST) {
  $frontendOverride = Get-ChildItem -Path $overrideRoot -Recurse -File | Where-Object {
    $relative = $_.FullName.Substring($overrideRoot.Length + 1)
    $relative -eq 'index.html' -or
      $relative -like 'src\*' -or
      $relative -like 'public\*' -or
      $relative -like 'shared\*'
  } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1

  if ($frontendOverride) {
    $distWriteTime = (Get-Item $distIndex).LastWriteTimeUtc
    if ($frontendOverride.LastWriteTimeUtc -gt $distWriteTime.AddSeconds(2)) {
      $relativeOverride = $frontendOverride.FullName.Substring($overrideRoot.Length + 1)
      throw "Frontend dist is older than override '$relativeOverride'. Rebuild vendor\claudecodeui-1.25.2 before starting, or set MOBILE_CODEX_ALLOW_STALE_DIST=1 to bypass deliberately."
    }
  }
}

$env:MOBILE_CODEX_NODE = $node
$env:NODE_ENV = 'production'
$env:HOST = '127.0.0.1'
$env:PORT = '3001'
$env:CODEX_ONLY_HARDENED_MODE = 'true'
$env:VITE_CODEX_ONLY_HARDENED_MODE = 'true'
if (-not $env:NODE_OPTIONS -or $env:NODE_OPTIONS -notmatch '--max-old-space-size=') {
  $env:NODE_OPTIONS = (($env:NODE_OPTIONS, '--max-old-space-size=8192') -join ' ').Trim()
}

Set-Location $repo
& $node 'server/index.js' 1>> $stdoutLog 2>> $stderrLog
