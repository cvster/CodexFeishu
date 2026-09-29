$workspace = Split-Path -Parent $PSScriptRoot
$backendTaskName = 'MobileCodexHelper-Backend'
$nginxTaskName = 'MobileCodexHelper-Nginx'
$backendLauncher = Join-Path $workspace 'scripts\start-mobile-codex-hidden.vbs'
$nginxLauncher = Join-Path $workspace 'scripts\start-mobile-codex-nginx.ps1'

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

$nginxAction = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument ("-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"{0}`" -Foreground" -f $nginxLauncher)
$nginxTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At ((Get-Date).AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$nginxSettings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask `
  -TaskName $nginxTaskName `
  -Action $nginxAction `
  -Trigger $nginxTrigger `
  -Settings $nginxSettings `
  -Description 'Keeps the mobileCodexHelper nginx reverse proxy running.' `
  -Force | Out-Null
Start-ScheduledTask -TaskName $nginxTaskName
