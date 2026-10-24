# Called only after the normal task ownership gate. Opt-in CI diagnostics,
# never process control: a lock-file PID is not authority to stop a process.
function Get-HexbotTaskDiagnostic {
    if ($env:HEXBOT_WINDOWS_SERVICE_PROBE -cne '1') { throw 'Task diagnostics require the isolated CI probe' }
    $instances = @(); $instanceCount = $null; $allInstances = @()
    try {
        $registered = $task.GetInstances(0)
        $instanceCount = $registered.Count
        $instances = @(for ($index=1; $index -le [Math]::Min(16, $instanceCount); $index++) {
            $item = $registered.Item($index)
            @{ instance = $item.InstanceGuid; enginePid = $item.EnginePID; state = [int]$item.State; action = $item.CurrentAction; path = $item.Path }
        })
    } catch { $instancesError=$_.Exception.Message }
    # Compare the current registration's instances with the scheduler's live
    # instances at this exact path after a definition replacement. Observation
    # only: an old instance is not independently authenticated for termination.
    try {
        $allInstances = @($service.GetRunningTasks(0) | Where-Object { $_.Path -ieq $task.Path } | Select-Object -First 16 | ForEach-Object {
            @{ instance=$_.InstanceGuid; enginePid=$_.EnginePID; state=[int]$_.State; path=$_.Path }
        })
    } catch { $allInstancesError=$_.Exception.Message }
    $lock = Join-Path $diagnosticHome 'native-daemon.lock'
    $lockPid = $null; $running = $null; $lockState = 'unknown'
    try { $text = [IO.File]::ReadAllText($lock); if ($text.Length -le 32) { $lockPid = [uint32]$text.Trim() } } catch { $lockReadError = $_.Exception.Message }
    try {
        $stream = [IO.File]::Open($lock, 'Open', 'ReadWrite', 'ReadWrite,Delete')
        try { $stream.Lock(0,1); $stream.Unlock(0,1); $lockState='free' } catch [IO.IOException] { $lockException=$_.Exception; while ($lockException.InnerException) { $lockException=$lockException.InnerException }; $lockError=$lockException.HResult; $lockState=$(if ($lockError -in @(-2147024863,-2147024864)) {'blocked'} else {'lock-error'}) }
        finally { $stream.Dispose() }
    } catch { $lockState='open-error'; $lockException=$_.Exception; while ($lockException.InnerException) { $lockException=$lockException.InnerException }; $lockError=$lockException.HResult }
    try {
        $text = [IO.File]::ReadAllText((Join-Path $diagnosticHome 'runtime/native-running.json'))
        if ($text.Length -le 4096) { $record = $text | ConvertFrom-Json; $running = @{ pid=$record.pid; executable=$record.executable } }
    } catch { $runningReadError=$_.Exception.Message }
    $processes = @(); $seen = @{}
    $ids = @($lockPid, $running.pid, $env:HEXBOT_WINDOWS_EXPECTED_TASK_PID) + @($instances | ForEach-Object { $_.enginePid }) + @($allInstances | ForEach-Object { $_.enginePid })
    foreach ($idValue in $ids) {
        $number = [uint32]0
        if (-not [uint32]::TryParse([string]$idValue, [ref]$number) -or $number -eq 0) { continue }
        if ($seen.ContainsKey([string]$number) -or $seen.Count -ge 32) { continue }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$number" -OperationTimeoutSec 2
        if ($null -eq $process) { $seen[[string]$number]=$true; $processes += @{ pid=$number; present=$false }; continue }
        $related = @($process) + @(Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ParentProcessId) OR ParentProcessId=$number" -OperationTimeoutSec 2 | Select-Object -First 16)
        foreach ($item in $related) {
            if ($seen.ContainsKey([string]$item.ProcessId) -or $seen.Count -ge 32) { continue }
            $seen[[string]$item.ProcessId]=$true
            try { $sid=(Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid -OperationTimeoutSec 2).Sid } catch { $sid=$null }
            $processes += @{ pid=$item.ProcessId; parent=$item.ParentProcessId; name=$item.Name; executable=$item.ExecutablePath; created=$item.CreationDate; sid=$sid; present=$true }
        }
    }
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    @{ task=$taskName; state=[int]$task.State; lastResult=$task.LastTaskResult; instanceCount=$instanceCount; instances=$instances; instancesError=$instancesError; allInstances=$allInstances; allInstancesError=$allInstancesError;
       definitionXml=([string]$task.Xml).Substring(0, [Math]::Min(16384, ([string]$task.Xml).Length));
       lock=@{ pid=$lockPid; state=$lockState; error=$lockError; readError=$lockReadError };
       running=$running; runningReadError=$runningReadError; processes=$processes } | ConvertTo-Json -Depth 7 -Compress
}
