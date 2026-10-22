$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
    $old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $parts = @($old.Split(';'))
    $matches = @($parts | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $env:HEXBOT_CLI_BIN.TrimEnd('\') })
    if ($env:HEXBOT_CLI_PATH_ACTION -eq 'add') {
        if ($matches.Count -gt 0) { Write-Output 'existing'; exit 0 }
        $updated = if ($old.Length -eq 0) { $env:HEXBOT_CLI_BIN } else { $old + ';' + $env:HEXBOT_CLI_BIN }
    } else {
        $updated = (@($parts | Where-Object { $_.TrimEnd('\') -ine $env:HEXBOT_CLI_BIN.TrimEnd('\') }) -join ';')
    }
    $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) { throw 'Unsupported user PATH registry type' }
    $key.SetValue('Path', $updated, $kind)
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
Write-Output 'changed'
