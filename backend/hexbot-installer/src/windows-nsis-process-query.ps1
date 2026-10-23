$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false,$true)
$decoded=ConvertFrom-Json -InputObject $env:HEXBOT_NSIS_DESTINATIONS
$destinations=@($decoded)
$image=$env:HEXBOT_NSIS_IMAGE
if($image -cnotin @('Hexbot.exe','HexbotClient.exe') -or $destinations.Count -lt 1 -or $destinations.Count -gt 3){throw 'Invalid NSIS process context'}
foreach($destination in $destinations){if($destination -isnot [string] -or $destination.Length -gt 4096 -or $destination -match "['\x00-\x1f]"){throw 'Invalid NSIS destination'}}
$available=$env:HEXBOT_NSIS_AVAILABLE -eq '1'
$affected=[Collections.Generic.List[object]]::new()
$count=0
if($available) {
    # Use the CIM schema field explicitly, independent of the host Path alias.
    # Keep FIND_PROCESS's raw prefix predicate and no name filtering.
    $processes=@(Get-CimInstance -ClassName Win32_Process -OperationTimeoutSec 10 -ErrorAction Stop)
    foreach($process in $processes) {
        $count++
        if(Test-HexbotNsisPrefix $process.ExecutablePath $destinations) {
            $affected.Add(@{pid=$process.ProcessId;path=$process.ExecutablePath;created=$process.CreationDate.ToUniversalTime().ToString('o')})
        }
    }
} else {
    # NSIS tasklist uses USERNAME without a domain. Resolve both the caller and
    # each potentially affected owner; uncertainty refuses instead of guessing.
    $current=[Security.Principal.WindowsIdentity]::GetCurrent()
    $username=$env:USERNAME
    if(!$username -or $username -ne $current.Name.Split('\')[-1]){throw 'USERNAME does not match the current Windows identity'}
    $processes=@(Get-WmiObject -Class Win32_Process -Filter "Name='$image'" -ErrorAction Stop)
    foreach($process in $processes) {
        $count++
        $owner=$process.GetOwner();$sid=$process.GetOwnerSid()
        if($owner.ReturnValue -ne 0 -or $sid.ReturnValue -ne 0){throw 'Could not read a potentially affected process owner'}
        $resolved=[Security.Principal.NTAccount]::new($owner.Domain,$owner.User).Translate([Security.Principal.SecurityIdentifier]).Value
        if(Test-HexbotNsisImage $process.Name $image $owner.User $username $sid.Sid $resolved $current.User.Value) {
            $affected.Add(@{pid=$process.ProcessId;path=$process.ExecutablePath;created=$process.CreationDate;sid=$sid.Sid})
        }
    }
}
# Enumeration is complete before deciding. Only diagnostic display is bounded;
# an overflow can never become a no-match success.
$shown=@($affected | Select-Object -First 8 | ForEach-Object {
    if($_.path -and $_.path.Length -gt 1024){$_.path=$_.path.Substring(0,1024)};$_
})
$hostInfo=@{is64=[Environment]::Is64BitProcess;image=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName;psHome=$PSHOME}
ConvertTo-Json -InputObject @{host=$hostInfo;complete=$true;branch=$(if($available){'prefix'}else{'image'});enumerated=$count;matchCount=$affected.Count;shown=$shown} -Depth 4 -Compress
