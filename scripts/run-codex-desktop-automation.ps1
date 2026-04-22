param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'runtime-paths.ps1')

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = Resolve-MobileCodexPythonPath
$venvDir = Join-Path $workspaceRoot 'tmp\desktop-automation-venv'
$venvPython = Join-Path $venvDir 'Scripts\python.exe'
$entryScript = Join-Path $PSScriptRoot 'codex_desktop_automation.py'

if (-not (Test-Path $venvPython)) {
  & $pythonPath -m venv $venvDir
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create desktop automation venv at $venvDir"
  }
}

& $venvPython -c "import pywinauto" 2>$null
if ($LASTEXITCODE -ne 0) {
  & $venvPython -m pip install --disable-pip-version-check pywinauto==0.6.9
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to install pywinauto into the desktop automation venv.'
  }
}

& $venvPython $entryScript @Arguments
exit $LASTEXITCODE
