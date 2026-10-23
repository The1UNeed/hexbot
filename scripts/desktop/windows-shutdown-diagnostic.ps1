# Test-only, read-only snapshot AFTER the strict native shutdown deadline.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false,$true)
$idText=$env:HEXBOT_TEST_SHUTDOWN_PID
if($idText -notmatch '^[1-9][0-9]{0,9}$'){throw 'Invalid owned test process ID'}
$owned=$null
$threads=@()
try {
    $owned=[Diagnostics.Process]::GetProcessById([int]$idText)
    $threads=@($owned.Threads)
    $threadRecords=@(foreach($thread in $threads | Select-Object -First 64) {
        try {
            $state=$thread.ThreadState.ToString()
            @{id=$thread.Id;state=$state;wait=$(if($state -eq 'Wait'){$thread.WaitReason.ToString()}else{$null})}
        } catch {@{error=$_.Exception.Message.Substring(0,[Math]::Min(512,$_.Exception.Message.Length))}}
    })
    # The PID is diagnostic only. Creation time/image identify the process seen
    # now; this snapshot cannot prove which native thread held exit earlier.
    $record=@{pid=$owned.Id;created=$owned.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();image=$owned.MainModule.FileName;responding=$owned.Responding;handleCount=$owned.HandleCount;threads=$threadRecords;threadCount=$threads.Count;threadsComplete=($threads.Count -le 64)}
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
