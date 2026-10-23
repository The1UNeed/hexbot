# electron-builder 26.16.1's x64 NSIS sets RegView 64 and consults both scopes
# during init, even though the caller explicitly forces /currentuser. Read only.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false,$true)
$guid=$env:HEXBOT_NSIS_GUID
if($guid -notin @('5c6fd00f-bd80-53ff-aeef-f9c3358a4c57','6626f9dd-933a-5e44-9657-6fa079966fb4','05b10340-fa13-50a8-9202-f1b511554ce2','5625bc89-25d6-5b85-9fd5-b4d4fd6cf320')) { throw 'Unknown NSIS identity' }
function Read-String($key,$name) {
    if($null -eq $key -or $key.GetValueNames() -notcontains $name) {return $null}
    if($key.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::String) {throw 'Invalid NSIS registration value type'}
    $value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if($value.Length -gt 32768) {throw 'Oversized NSIS registration value'}
    return $value
}
$entries=@(foreach($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
    $root=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,[Microsoft.Win32.RegistryView]::Registry64)
    $install=$null; $uninstall=$null
    try {
        $install=$root.OpenSubKey("Software\$guid",$false)
        $uninstall=$root.OpenSubKey("Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid",$false)
        @{install=($null -ne $install);uninstall=($null -ne $uninstall);location=(Read-String $install 'InstallLocation');command=(Read-String $uninstall 'UninstallString')}
    } finally {
        if($null -ne $install){$install.Dispose()};if($null -ne $uninstall){$uninstall.Dispose()};$root.Dispose()
    }
})
ConvertTo-Json -InputObject $entries -Compress
