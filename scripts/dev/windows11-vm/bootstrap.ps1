$ErrorActionPreference = 'Stop'
$root = 'C:\HexbotVm'
New-Item -ItemType Directory -Path $root, "$root\evidence" -Force | Out-Null
try {
    foreach ($name in @('guest.ps1', 'standard-user.ps1', 'downloads.json', 'probe.mjs', 'fixtures', 'node.exe', 'python.zip', 'wxc-exec.exe')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $root -Recurse -Force
    }
    # Only this disposable VM receives remote administration. The host forwards
    # its WinRM port on 127.0.0.1, and NTLM message encryption stays required.
    Enable-PSRemoting -SkipNetworkProfileCheck -Force | Out-Null
    Set-Item WSMan:\localhost\Service\AllowUnencrypted -Value $false
    Set-Item WSMan:\localhost\Service\Auth\Basic -Value $false
    Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name LocalAccountTokenFilterPolicy -Type DWord -Value 1
    Get-NetFirewallRule -Name 'WINRM-HTTP-In-TCP*' | Set-NetFirewallRule -RemoteAddress 10.0.2.2
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\HexbotVm\guest.ps1'
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User 'HexbotVmAdmin'
    $principal = New-ScheduledTaskPrincipal -UserId 'HexbotVmAdmin' -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 90) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName HexbotVmValidation -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName HexbotVmValidation
} catch {
    @{ phase = 'failed'; message = $_.Exception.Message } | ConvertTo-Json | Set-Content "$root\state.json"
    Copy-Item "$root\state.json" "$root\evidence\state.json" -Force
    throw
}
