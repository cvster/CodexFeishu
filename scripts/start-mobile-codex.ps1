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

$env:MOBILE_CODEX_NODE = $node
$env:NODE_ENV = 'production'
$env:HOST = '127.0.0.1'
$env:PORT = '3001'
$env:CODEX_ONLY_HARDENED_MODE = 'true'
$env:VITE_CODEX_ONLY_HARDENED_MODE = 'true'

Set-Location $repo
& $node 'server/index.js' 1>> $stdoutLog 2>> $stderrLog
