$workspace = Split-Path -Parent $PSScriptRoot
$backendTaskName = 'MobileCodexHelper-Backend'
$backendLauncher = Join-Path $workspace 'scripts\start-mobile-codex-hidden.vbs'

$action = New-ScheduledTaskAction `
  -Execute 'wscript.exe' `
  -Argument ("//B //Nologo `"{0}`"" -f $backendLauncher)
$trigger = New-ScheduledTaskTrigger `
  -Once `
  -At ((Get-Date).AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask `
  -TaskName $backendTaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Keeps the mobileCodexHelper Node backend running.' `
  -Force | Out-Null
Start-ScheduledTask -TaskName $backendTaskName
Start-Sleep -Seconds 5
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $workspace 'scripts\start-mobile-codex-nginx.ps1') | Out-Null
