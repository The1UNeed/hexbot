# Fixture-only observer. The production controller has already authenticated
# the exact principal, action and home. No file PID grants process control.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public sealed class HexbotReadinessEvents : IDisposable {
    readonly FileSystemWatcher watcher;
    readonly AutoResetEvent changed = new AutoResetEvent(false);
    readonly object gate = new object();
    bool disposed;
    public HexbotReadinessEvents(string home) {
        watcher = new FileSystemWatcher(home);
        watcher.IncludeSubdirectories = true;
        watcher.Changed += Signal; watcher.Created += Signal;
        watcher.Deleted += Signal; watcher.Renamed += Signal;
        watcher.Error += delegate { lock(gate) { if(!disposed) changed.Set(); } };
        watcher.EnableRaisingEvents = true;
    }
    void Signal(object sender, FileSystemEventArgs e) { lock(gate) { if(!disposed) changed.Set(); } }
    public bool Wait(int milliseconds) { return changed.WaitOne(milliseconds); }
    public void Dispose() { lock(gate) { disposed=true; watcher.Dispose(); changed.Dispose(); } }
}
'@
function Read-HexbotFixtureMetadata($path) {
    $stream=[IO.File]::Open($path,'Open','Read','ReadWrite,Delete')
    $reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$true)
    try {
        $buffer=[char[]]::new(4097); $count=$reader.ReadBlock($buffer,0,$buffer.Length)
        if($count -gt 4096) { throw 'Oversized fixture readiness metadata' }
        return [string]::new($buffer,0,$count)
    } finally { $reader.Dispose() }
}
function Read-HexbotTaskWitness {
    $process=$null; $parentProcess=$null
    try {
        $text=Read-HexbotFixtureMetadata $recordPath
        if($text.Length -gt 4096) { return }
        $record=$text|ConvertFrom-Json
        $number=[uint32]0
        if(-not [uint32]::TryParse([string]$record.pid,[ref]$number) -or $number -eq 0 -or $excluded -contains $number) { return }
        # Retain a kernel handle before inspecting any process/record identity.
        $process=[Diagnostics.Process]::GetProcessById($number)
        $null=$process.Handle
        if($process.HasExited) { return }
        $created=$process.StartTime.ToFileTimeUtc().ToString()
        $image=[HexbotFinalPath]::Resolve($process.MainModule.FileName)
        $selected=Select-HexbotRuntime
        if($image -ine $selected -or [HexbotFinalPath]::Resolve($record.executable) -ine $selected) { return }
        $task=$folder.GetTask($taskName)
        if([int]$task.State -ne 4) { return }
        $item=Get-CimInstance Win32_Process -Filter "ProcessId=$number" -OperationTimeoutSec 2
        if($null -eq $item) { return }
        $sid=(Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid -OperationTimeoutSec 2).Sid
        if($sid -cne $expectedSid) { return }
        $instances=$task.GetInstances(0)
        $instance=$null
        for($i=1;$i -le $instances.Count;$i++) {
            $candidate=$instances.Item($i)
            if($candidate.EnginePID -eq $item.ParentProcessId -and $candidate.Path -ceq $task.Path -and [int]$candidate.State -eq 4) { $instance=$candidate; break }
        }
        if($null -eq $instance) { return }
        $parentProcess=[Diagnostics.Process]::GetProcessById($item.ParentProcessId)
        $null=$parentProcess.Handle
        if($parentProcess.HasExited -or [HexbotFinalPath]::Resolve($parentProcess.MainModule.FileName) -ine [HexbotFinalPath]::Resolve($expectedPowerShell) -or $parentProcess.StartTime -gt $process.StartTime) { return }
        $parent=Get-CimInstance Win32_Process -Filter "ProcessId=$($item.ParentProcessId)" -OperationTimeoutSec 2
        if((Invoke-CimMethod -InputObject $parent -MethodName GetOwnerSid -OperationTimeoutSec 2).Sid -cne $expectedSid) { return }
        $port=[int](((Read-HexbotFixtureMetadata (Join-Path $env:HEXBOT_HOME 'serve-state.json'))|ConvertFrom-Json).port)
        if($port -lt 1 -or $port -gt 65535) { return }
        $identity=Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/daemon/identity" -TimeoutSec 2 -MaximumRedirection 0 -UseBasicParsing
        $install=(Read-HexbotFixtureMetadata (Join-Path $env:HEXBOT_HOME 'install_id')).Trim()
        if($identity.pid -ne $number -or !$install -or $identity.install_id -cne $install) { return }
        # Windows byte-range locks deny reading their bytes. Probe ownership of
        # the range, not its unreadable PID, and authenticate the live HTTP home.
        $locked=$false
        $stream=[IO.File]::Open((Join-Path $env:HEXBOT_HOME 'native-daemon.lock'),'Open','ReadWrite','ReadWrite,Delete')
        try {
            try { $stream.Lock(0,1); $stream.Unlock(0,1) } catch [IO.IOException] {
                $lockException=$_.Exception; while($lockException.InnerException) { $lockException=$lockException.InnerException }
                if($lockException.HResult -ne -2147024863) { throw }
                $locked=$true
            }
        } finally { $stream.Dispose() }
        if(!$locked -or $process.HasExited -or $parentProcess.HasExited -or (Read-HexbotFixtureMetadata $recordPath) -cne $text) { return }
        $hash=[Security.Cryptography.SHA256]::Create()
        try { $digest=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
        return @{pid=$number;created=$created;executable=$image;selected=$selected;owner=$sid;expectedOwner=$expectedSid;parent=[uint32]$item.ParentProcessId;enginePid=[uint32]$instance.EnginePID;instance=[string]$instance.InstanceGuid;taskPath=[string]$instance.Path;expectedTaskPath=[string]$task.Path;recordHash=$digest;recordEpoch=([IO.File]::GetLastWriteTimeUtc($recordPath).ToFileTimeUtc().ToString());identityPid=$identity.pid;install=$identity.install_id;expectedInstall=$install;live=$true;lockHeld=$locked}
    } catch {
        # Candidate startup/exit races are observed again only on filesystem
        # events, with one overall deadline. Preserve the last bounded reason.
        $script:lastCandidateError=$_.Exception.Message
    } finally {
        if($null -ne $process) { $process.Dispose() }
        if($null -ne $parentProcess) { $parentProcess.Dispose() }
    }
}
$recordPath=Join-Path $env:HEXBOT_HOME 'runtime/native-running.json'
$events=[HexbotReadinessEvents]::new($env:HEXBOT_HOME)
$clock=[Diagnostics.Stopwatch]::StartNew()
try {
    while($true) {
        $witness=Read-HexbotTaskWitness
        if($null -ne $witness) { $witness|ConvertTo-Json -Compress; break }
        if($once) { 'null'; break }
        $remaining=$budget-[int]$clock.ElapsedMilliseconds
        if($remaining -le 0 -or !$events.Wait($remaining)) { throw "Task readiness deadline: $script:lastCandidateError" }
    }
} finally { $events.Dispose() }
