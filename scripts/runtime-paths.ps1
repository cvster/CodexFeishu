if (-not (Get-Variable MobileCodexWorkspace -Scope Script -ErrorAction SilentlyContinue) -or -not $script:MobileCodexWorkspace) {
  $script:MobileCodexWorkspace = Split-Path -Parent $PSScriptRoot
}

function Import-MobileCodexLocalEnv {
  param(
    [string]$EnvPath = $(Join-Path $script:MobileCodexWorkspace '.env')
  )

  if (-not (Test-Path $EnvPath)) {
    return
  }

  Get-Content $EnvPath -ErrorAction SilentlyContinue | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) {
      return
    }

    $match = [regex]::Match($line, '^(?<key>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)$')
    if (-not $match.Success) {
      return
    }

    $key = $match.Groups['key'].Value
    $value = $match.Groups['value'].Value.Trim()

    if (
      $value.Length -ge 2 -and
      (
        ($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))
      )
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    $existing = [Environment]::GetEnvironmentVariable($key, 'Process')
    if ([string]::IsNullOrWhiteSpace($existing)) {
      [Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
  }
}

function Test-UsableExecutablePath {
  param(
    [string]$Path
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $false
  }

  if (-not (Test-Path $Path)) {
    return $false
  }

  $normalized = $Path.ToLowerInvariant()

  # The Codex desktop app exposes a node.exe path under WindowsApps that is not
  # usable for general script execution from this workspace.
  if ($normalized -like '*\windowsapps\openai.codex_*\app\resources\node.exe') {
    return $false
  }

  return $true
}

function Get-UsableCommandPath {
  param(
    [string]$CommandName
  )

  $commands = @(Get-Command $CommandName -All -ErrorAction SilentlyContinue)
  foreach ($command in $commands) {
    if (Test-UsableExecutablePath $command.Path) {
      return $command.Path
    }
  }

  return $null
}

function Get-WingetPackageExecutable {
  param(
    [string[]]$PackageNamePatterns,
    [string]$ExecutableName
  )

  $packagesRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  if (-not (Test-Path $packagesRoot)) {
    return $null
  }

  foreach ($pattern in $PackageNamePatterns) {
    $packageDirs = @(Get-ChildItem -Path $packagesRoot -Directory -Filter $pattern -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending)

    foreach ($packageDir in $packageDirs) {
      $match = Get-ChildItem -Path $packageDir.FullName -Filter $ExecutableName -File -Recurse -ErrorAction SilentlyContinue |
        Sort-Object FullName |
        Select-Object -First 1

      if ($match -and (Test-UsableExecutablePath $match.FullName)) {
        return $match.FullName
      }
    }
  }

  return $null
}

function Resolve-MobileCodexNodePath {
  if (Test-UsableExecutablePath $env:MOBILE_CODEX_NODE) {
    return $env:MOBILE_CODEX_NODE
  }

  $pathCommand = Get-UsableCommandPath 'node'
  if ($pathCommand) {
    return $pathCommand
  }

  $wingetNode = Get-WingetPackageExecutable -PackageNamePatterns @('OpenJS.NodeJS*') -ExecutableName 'node.exe'
  if ($wingetNode) {
    return $wingetNode
  }

  throw 'Node.js 22 LTS not found. Set MOBILE_CODEX_NODE if needed.'
}

function Resolve-MobileCodexCliPath {
  if (Test-UsableExecutablePath $env:MOBILE_CODEX_CLI) {
    $configuredQueueHelp = & $env:MOBILE_CODEX_CLI queue --help 2>$null
    if ($LASTEXITCODE -eq 0 -and $configuredQueueHelp -match 'Queue a message') {
      return $env:MOBILE_CODEX_CLI
    }

    throw 'MOBILE_CODEX_CLI does not support the required codex queue command.'
  }

  $desktopBinRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  if (Test-Path $desktopBinRoot) {
    $desktopBinaries = @(Get-ChildItem -Path $desktopBinRoot -Filter 'codex.exe' -File -Recurse -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTimeUtc -Descending)

    foreach ($binary in $desktopBinaries) {
      if (-not (Test-UsableExecutablePath $binary.FullName)) {
        continue
      }

      $versionOutput = & $binary.FullName --version 2>$null
      $queueHelp = & $binary.FullName queue --help 2>$null
      if (
        $LASTEXITCODE -eq 0 -and
        $versionOutput -match '^codex-cli\s+' -and
        $queueHelp -match 'Queue a message'
      ) {
        return $binary.FullName
      }
    }
  }

  $pathCommand = Get-UsableCommandPath 'codex.exe'
  if ($pathCommand) {
    $pathQueueHelp = & $pathCommand queue --help 2>$null
    if ($LASTEXITCODE -eq 0 -and $pathQueueHelp -match 'Queue a message') {
      return $pathCommand
    }
  }

  throw 'Codex CLI with native queue support not found. Update Codex Desktop or set MOBILE_CODEX_CLI.'
}

function Test-MobileCodexPythonPath {
  param(
    [string]$Path,
    [int]$MinimumMinorVersion = 11
  )

  if (-not (Test-UsableExecutablePath $Path)) {
    return $false
  }

  $version = & $Path -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')" 2>$null
  if ($LASTEXITCODE -ne 0) {
    return $false
  }

  $parts = $version.Trim().Split('.')
  if ($parts.Count -lt 2) {
    return $false
  }

  $major = 0
  $minor = 0

  if (-not [int]::TryParse($parts[0], [ref]$major)) {
    return $false
  }

  if (-not [int]::TryParse($parts[1], [ref]$minor)) {
    return $false
  }

  if ($major -gt 3) {
    return $true
  }

  return ($major -eq 3 -and $minor -ge $MinimumMinorVersion)
}

function Resolve-MobileCodexPythonPath {
  if (Test-MobileCodexPythonPath $env:MOBILE_CODEX_PYTHON) {
    return $env:MOBILE_CODEX_PYTHON
  }

  $bundledRuntime = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
  if (Test-MobileCodexPythonPath $bundledRuntime) {
    return $bundledRuntime
  }

  foreach ($name in @('python', 'python3')) {
    $commands = @(Get-Command $name -All -ErrorAction SilentlyContinue)
    foreach ($command in $commands) {
      if (Test-MobileCodexPythonPath $command.Path) {
        return $command.Path
      }
    }
  }

  throw 'Python 3.11+ not found. Set MOBILE_CODEX_PYTHON if needed.'
}

function Resolve-MobileCodexNginxPath {
  if (Test-UsableExecutablePath $env:MOBILE_CODEX_NGINX) {
    return $env:MOBILE_CODEX_NGINX
  }

  $pathCommand = Get-UsableCommandPath 'nginx'
  if ($pathCommand) {
    return $pathCommand
  }

  $wingetNginx = Get-WingetPackageExecutable -PackageNamePatterns @('nginxinc.nginx*') -ExecutableName 'nginx.exe'
  if ($wingetNginx) {
    return $wingetNginx
  }

  throw 'nginx not found. Set MOBILE_CODEX_NGINX if needed.'
}

function Resolve-MobileCodexTailscalePath {
  if (Test-UsableExecutablePath $env:MOBILE_CODEX_TAILSCALE) {
    return $env:MOBILE_CODEX_TAILSCALE
  }

  $defaultPath = 'C:\Program Files\Tailscale\tailscale.exe'
  if (Test-UsableExecutablePath $defaultPath) {
    return $defaultPath
  }

  $pathCommand = Get-UsableCommandPath 'tailscale'
  if ($pathCommand) {
    return $pathCommand
  }

  return $null
}

function Resolve-MobileCodexAsciiAliasPath {
  if (-not [string]::IsNullOrWhiteSpace($env:MOBILE_CODEX_ASCII_ALIAS)) {
    return $env:MOBILE_CODEX_ASCII_ALIAS
  }

  return (Join-Path $env:SystemDrive 'mobileCodexHelper_ascii')
}

Import-MobileCodexLocalEnv
