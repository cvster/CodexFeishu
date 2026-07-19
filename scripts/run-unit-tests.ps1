param(
  [string]$ProjectPath = 'D:\dorit\mytest',
  [string]$Model = 'gpt-5.6-sol',
  [int]$CommandTimeoutSeconds = 240,
  [int]$ResponseTimeoutSeconds = 240
)

$ErrorActionPreference = 'Stop'

$workspace = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime-paths.ps1')

$node = Resolve-MobileCodexNodePath
$stdoutLog = Join-Path $workspace 'tmp\logs\mobile-codex-app.stdout.log'
if (-not (Test-Path $stdoutLog)) {
  throw "App stdout log not found: $stdoutLog"
}

$logStream = [System.IO.File]::Open(
  $stdoutLog,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::Read,
  [System.IO.FileShare]::ReadWrite
)
try {
  $buffer = New-Object byte[] $logStream.Length
  [void]$logStream.Read($buffer, 0, $buffer.Length)
} finally {
  $logStream.Dispose()
}

$logText = [System.Text.Encoding]::UTF8.GetString($buffer) -replace "`0", ''
$tokenMatches = [regex]::Matches($logText, 'token=([A-Za-z0-9\-_\.]+)')
if ($tokenMatches.Count -eq 0) {
  throw 'No WebSocket token found in the app log. Open the web app and log in once before running live tests.'
}

$env:TEST_WS_TOKEN = $tokenMatches[$tokenMatches.Count - 1].Groups[1].Value
$env:TEST_PROJECT_PATH = $ProjectPath
$env:TEST_MODEL = $Model
$env:TEST_COMMAND_TIMEOUT_MS = ($CommandTimeoutSeconds * 1000).ToString()
$env:TEST_RESPONSE_TIMEOUT_MS = ($ResponseTimeoutSeconds * 1000).ToString()

$testFiles = @(
  Get-ChildItem -Path (Join-Path $workspace 'tests') -Recurse -File -Filter '*.test.mjs' |
    Sort-Object FullName |
    ForEach-Object { $_.FullName }
)

if ($testFiles.Count -eq 0) {
  throw 'No unit test files were found.'
}

& $node --test @testFiles
if ($LASTEXITCODE -ne 0) {
  throw "Unit tests failed with exit code $LASTEXITCODE."
}
