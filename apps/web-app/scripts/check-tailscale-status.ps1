. (Join-Path $PSScriptRoot 'runtime-paths.ps1')
$tailscale = Resolve-MobileCodexTailscalePath

if (-not (Test-Path $tailscale)) {
  throw "Tailscale CLI not found: $tailscale"
}

$status = & $tailscale status --json | ConvertFrom-Json

[PSCustomObject]@{
  BackendState = $status.BackendState
  LoggedIn = ($status.BackendState -eq 'Running')
  AuthURL = $status.AuthURL
  HostName = $status.Self.HostName
  DNSName = $status.Self.DNSName
  Health = ($status.Health -join '; ')
} | Format-List
