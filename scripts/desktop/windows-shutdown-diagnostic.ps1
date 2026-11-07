# Test-only, read-only snapshot AFTER the strict native shutdown deadline.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false,$true)
$idText=$env:HEXBOT_TEST_SHUTDOWN_PID
if($idText -notmatch '^[1-9][0-9]{0,9}$'){throw 'Invalid owned test process ID'}
$owned=$null
$threads=@()
try {
    $owned=[Diagnostics.Process]::GetProcessById([int]$idText)
    $created=$owned.StartTime.ToUniversalTime()
    $createdMs=([DateTimeOffset]$created).ToUnixTimeMilliseconds()
    $image=$owned.MainModule.FileName
    $expected=[IO.Path]::GetFullPath($env:HEXBOT_TEST_SHUTDOWN_IMAGE).Replace('/','\')
    # No handles were captured at launch. Check the creation-time interval of
    # the actual Electron launch and its trusted image before reading threads.
    $identity=@{pid=$owned.Id;created=$created.ToFileTimeUtc().ToString();image=$image;expectedImage=$expected;createdMs=$createdMs;notBefore=$env:HEXBOT_TEST_SHUTDOWN_AFTER;notAfter=$env:HEXBOT_TEST_SHUTDOWN_BEFORE}
    $identity.matches=($image.Equals($expected,[StringComparison]::OrdinalIgnoreCase) -and $createdMs -ge [long]$env:HEXBOT_TEST_SHUTDOWN_AFTER -and $createdMs -le [long]$env:HEXBOT_TEST_SHUTDOWN_BEFORE)
    if(-not $identity.matches){ConvertTo-Json -InputObject @{identity=$identity;note='Owned launch identity could not be corroborated; no thread/child snapshot taken'} -Compress;exit 0}
    $threads=@($owned.Threads)
    $threadRecords=@(foreach($thread in $threads | Select-Object -First 64) {
        try {
            $state=$thread.ThreadState.ToString()
            @{id=$thread.Id;state=$state;wait=$(if($state -eq 'Wait'){$thread.WaitReason.ToString()}else{$null})}
        } catch {@{error=$_.Exception.Message.Substring(0,[Math]::Min(512,$_.Exception.Message.Length))}}
    })
    # The PID is diagnostic only. Creation time/image identify the process seen
    # now; this snapshot cannot prove which native thread held exit earlier.
    $record=@{identity=$identity;responding=$owned.Responding;handleCount=$owned.HandleCount;threads=$threadRecords;threadCount=$threads.Count;threadsComplete=($threads.Count -le 64)}
    $children=@(Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $idText")
    $record.children=@($children | Select-Object -First 64 | ForEach-Object {@{pid=$_.ProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');image=$_.ExecutablePath}})
    $record.childCount=$children.Count
    $record.childrenComplete=($children.Count -le 64)
    $record.utc=[DateTime]::UtcNow.ToString('o')
    ConvertTo-Json -InputObject $record -Depth 5 -Compress
} finally {
    foreach($thread in $threads){$thread.Dispose()}
    if($null -ne $owned){$owned.Dispose()}
}
