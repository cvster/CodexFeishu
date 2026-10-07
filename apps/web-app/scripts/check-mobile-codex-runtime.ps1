$workspace = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime-paths.ps1')
$upstream = if ($env:MOBILE_CODEX_UPSTREAM_DIR) {
  $env:MOBILE_CODEX_UPSTREAM_DIR
} else {
  Join-Path $workspace 'vendor\claudecodeui-1.25.2'
}

$nodePath = Resolve-MobileCodexNodePath
$nginxPath = Resolve-MobileCodexNginxPath
$tailscalePath = Resolve-MobileCodexTailscalePath

[PSCustomObject]@{
  Workspace = $workspace
  UpstreamExists = (Test-Path $upstream)
  UpstreamPath = $upstream
  Node = $nodePath
  Nginx = $nginxPath
  Tailscale = $tailscalePath
  Python = (Get-Command python -ErrorAction SilentlyContinue).Path
} | Format-List
