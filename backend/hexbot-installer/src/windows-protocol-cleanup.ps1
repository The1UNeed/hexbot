# Mutation boundary separate from the read-only NSIS registry collision check.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$candidates=@($env:HEXBOT_PROTOCOL_BINDINGS | ConvertFrom-Json)
if($candidates.Count -lt 1 -or $candidates.Count -gt 2) { throw 'Invalid protocol binding count' }
foreach($candidate in $candidates) {
    if($candidate -isnot [string] -or $candidate.Length -gt 4200 -or $candidate.IndexOfAny([char[]]"`r`n`0") -ge 0 -or
       !$candidate.EndsWith('" "%1"',[StringComparison]::Ordinal) -or $candidate[0] -ne '"') { throw 'Invalid protocol binding' }
}
$root=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
$key=$null
try {
    # One key handle for read/type/compare/delete. Never enumerate/delete a tree.
    $key=$root.OpenSubKey('__COMMAND_KEY__',$true)
    $outcome='absent'
    if($key -and $key.GetValueNames() -contains '') {
        $outcome='preserved'
        $actual=$key.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if(Test-HexbotProtocolBinding $actual ($key.GetValueKind('').ToString()) $candidates) {
            $key.DeleteValue('',$false);$outcome='removed'
        }
    }
    @{outcome=$outcome} | ConvertTo-Json -Compress
} finally { if($key){$key.Dispose()};$root.Dispose() }
