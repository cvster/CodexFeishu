param(
  [string]$ExpectedProject
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$runner = Join-Path $PSScriptRoot 'run-codex-desktop-automation.ps1'
$stateJson = & $runner dump-state --json
if ($LASTEXITCODE -ne 0) {
  throw 'Codex desktop automation smoke test failed while collecting state.'
}

$state = $stateJson | ConvertFrom-Json
if (-not $state.projects -or $state.projects.Count -eq 0) {
  throw 'Codex desktop automation smoke test found no visible projects.'
}

if ($ExpectedProject) {
  $match = $state.projects | Where-Object { $_.title -eq $ExpectedProject }
  if (-not $match) {
    throw "Expected project '$ExpectedProject' was not visible in the Codex sidebar."
  }
}

[pscustomobject]@{
  windowHandle     = $state.window_handle
  projectCount     = $state.projects.Count
  visibleProjects  = @($state.projects | ForEach-Object { $_.title })
  mainTextPreview  = @($state.main_text_preview | Select-Object -First 5)
} | ConvertTo-Json -Depth 4
