$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
    $exists = $key.GetValueNames() -contains 'Path'
    $old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = if ($exists) { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) { throw 'Unsupported user PATH registry type' }
    $parts = @($old.Split(';'))
    $present = @($parts | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $env:HEXBOT_CLI_BIN.TrimEnd('\') }).Count -gt 0
    $operation = $env:HEXBOT_CLI_PATH_ACTION
    if ($operation -eq 'inspect') {
        @{exists=$exists; value=$old; kind=[int]$kind; present=$present} | ConvertTo-Json -Compress
        return
    }
    $before = if ($env:HEXBOT_CLI_PATH_INTENT) { $env:HEXBOT_CLI_PATH_INTENT | ConvertFrom-Json } else { $null }
    $matchesBefore = $false
    $matchesAfter = $false
    if ($before) {
        $after = if ($before.value.Length -eq 0) { $env:HEXBOT_CLI_BIN } else { $before.value + ';' + $env:HEXBOT_CLI_BIN }
        $matchesBefore = $exists -eq $before.exists -and $old -ceq $before.value -and [int]$kind -eq $before.kind
        $matchesAfter = $exists -and $old -ceq $after -and [int]$kind -eq $before.kind
    }
    switch ($operation) {
        'apply' {
            if (!$before) { throw 'PATH registration requires a recorded absent-entry intent' }
            if ($matchesAfter) { @{added=$true} | ConvertTo-Json -Compress; return }
            if (!$matchesBefore -or $present) { throw 'User PATH changed during registration; pending ownership was retained without changing PATH' }
            $key.SetValue('Path', $after, $kind)
        }
        'undo' {
            # A pending registration owns only its exact expected write. A
            # concurrent user edit is ambiguous and must retain the journal.
            if ($matchesBefore) { @{added=$false} | ConvertTo-Json -Compress; return }
            if (!$matchesAfter) { throw 'User PATH changed during pending registration; left PATH and ownership intent alone' }
            if ($before.exists) { $key.SetValue('Path', [string]$before.value, $kind) }
            else { $key.DeleteValue('Path', $false) }
        }
        'remove' {
            if ($matchesAfter) {
                if ($before.exists) { $key.SetValue('Path', [string]$before.value, $kind) }
                else { $key.DeleteValue('Path', $false) }
            } else {
                $updated = (@($parts | Where-Object { $_.TrimEnd('\') -ine $env:HEXBOT_CLI_BIN.TrimEnd('\') }) -join ';')
                if ($updated -ceq $old) { @{added=$false} | ConvertTo-Json -Compress; return }
                $key.SetValue('Path', $updated, $kind)
            }
        }
        default { throw 'Unknown PATH operation' }
    }
} finally { $key.Dispose() }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HexbotEnvironmentChange {
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message,
        IntPtr parameter, string value, uint flags, uint timeout, out IntPtr result);
}
'@
$result = [IntPtr]::Zero
[void][HexbotEnvironmentChange]::SendMessageTimeoutW([IntPtr]0xffff, 0x1a, [IntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
@{added=($operation -eq 'apply')} | ConvertTo-Json -Compress
