param([string]$Exe, [int]$Port, [string]$Nonce, [bool]$Forward)
$ErrorActionPreference = 'Stop'
$client = [Net.Sockets.TcpClient]::new('127.0.0.1', $Port)
$writer = [IO.StreamWriter]::new($client.GetStream(), [Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
function Record($value) {
    $value.nonce = $Nonce
    $writer.WriteLine(($value | ConvertTo-Json -Compress))
}
try {
    Record @{phase='parent';pid=$PID;created=([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc().ToString());clr=[Environment]::Version.ToString();systemDll=[Diagnostics.FileVersionInfo]::GetVersionInfo([Diagnostics.Process].Assembly.Location).FileVersion;powershell=$PSVersionTable.PSVersion.ToString()}
    # No PowerShell callbacks/runspace are needed while Console.ReadLine blocks.
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
public static class ShutdownFixture {
    static readonly object Gate = new object();
    static void Event(StreamWriter writer, string nonce, string phase, int code) {
        lock(Gate) writer.WriteLine("{\"nonce\":\""+nonce+"\",\"phase\":\""+phase+"\",\"code\":"+code+"}");
    }
    public static void Observe(Process child, StreamWriter writer, string nonce, Task[] pumps) {
        if (pumps.Length != 0) {
            Task.WhenAll(pumps).ContinueWith(t => {
                if(t.IsFaulted) Event(writer, nonce, "forward-error", t.Exception.HResult);
            });
        }
        Task.Run(() => {
            try {child.WaitForExit(); Event(writer, nonce, "child-exit", child.ExitCode);}
            catch(Exception e) {Event(writer, nonce, "observe-error", e.HResult);}
        });
    }
}
'@
    $p = [Diagnostics.ProcessStartInfo]::new()
    $p.FileName = $Exe
    $p.Arguments = 'serve --host 127.0.0.1 --port 0'
    $p.UseShellExecute = $false
    $p.CreateNoWindow = $true
    # A keeps the historical stream setup. B changes only these two redirects
    # and forwards the actual bytes concurrently. Neither forwards stdin.
    if ($Forward) {$p.RedirectStandardOutput=$true;$p.RedirectStandardError=$true}
    Record @{phase='starting'}
    $child = [Diagnostics.Process]::Start($p)
    # Drain even an immediate startup failure, before the witness handshake.
    [Threading.Tasks.Task[]]$pumps = @()
    if ($Forward) {
        $pumps = @($child.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput()), $child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError()))
    }
    Record @{phase='child';pid=$child.Id;parent=$PID;created=$child.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();handle=$child.Handle.ToInt64().ToString()}
    $reader = [IO.StreamReader]::new($client.GetStream())
    if ($reader.ReadLine() -cne $Nonce) {throw 'Fixture witness rejected'}
    [ShutdownFixture]::Observe($child, $writer, $Nonce, $pumps)
    $null = [Console]::ReadLine()
    exit 0
} catch {
    $errorCode=$_.Exception.HResult
    if ($_.Exception.InnerException -is [ComponentModel.Win32Exception]) {$errorCode=$_.Exception.InnerException.NativeErrorCode}
    Record @{phase='start-error';code=$errorCode}
    exit 1
}
