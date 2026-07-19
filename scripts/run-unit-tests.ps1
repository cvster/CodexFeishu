$ErrorActionPreference = 'Stop'

$workspace = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime-paths.ps1')

$node = Resolve-MobileCodexNodePath
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
