$ErrorActionPreference = 'Stop'
$root = 'C:\HexbotVm'
# Best-effort progress beacons to the host listener (slirp gateway 10.0.2.2).
# They must never break the run, and they work even while WinRM is broken.
function Beacon([string]$stage) {
    try { Invoke-WebRequest -UseBasicParsing -Uri ('http://10.0.2.2:15986/beacon/' + $stage) -TimeoutSec 5 } catch { }
}
Beacon 'bootstrap-start'
New-Item -ItemType Directory -Path $root, "$root\evidence" -Force | Out-Null
try {
    foreach ($name in @('guest.ps1', 'standard-user.ps1', 'downloads.json', 'probe.mjs', 'fixtures', 'node.exe', 'python.zip', 'wxc-exec.exe')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $root -Recurse -Force
    }
    Beacon 'bootstrap-copied'
    # The unidentified NAT network starts on the Public profile, where WinRM's
    # firewall exception is refused. This VM talks only to the host forward and
    # the slirp gateway, so mark every connection Private before remoting.
    try {
        Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private
        Beacon 'bootstrap-network-private'
    } catch { Beacon ('bootstrap-network-error-' + ($_.Exception.Message -replace '[^A-Za-z0-9]', '-')) }
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
    Beacon 'bootstrap-winrm-and-task'
    Start-ScheduledTask -TaskName HexbotVmValidation
    Beacon 'bootstrap-task-started'
} catch {
    Beacon ('bootstrap-error-' + ($_.Exception.Message -replace '[^A-Za-z0-9]', '-'))
    @{ phase = 'failed'; message = $_.Exception.Message } | ConvertTo-Json | Set-Content "$root\state.json"
    Copy-Item "$root\state.json" "$root\evidence\state.json" -Force
    try { Invoke-WebRequest -UseBasicParsing -Method Post -Uri 'http://10.0.2.2:15986/post/state.json' -Body (Get-Content "$root\state.json" -Raw) -ContentType 'application/json' -TimeoutSec 10 } catch { }
    throw
}
