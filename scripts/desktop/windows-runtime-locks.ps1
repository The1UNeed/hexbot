# Read-only failure diagnostics. Never invoke Restart Manager shutdown/restart.
# RmGetList cannot inspect directory resources, so register the staged binaries.
# https://learn.microsoft.com/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class HexbotRuntimeLocks {
    [StructLayout(LayoutKind.Sequential)] public struct Process {
        public uint pid; public System.Runtime.InteropServices.ComTypes.FILETIME created;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Info {
        public Process process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string app;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string service;
        public uint type, status, session;
        [MarshalAs(UnmanagedType.Bool)] public bool restartable;
    }
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmStartSession(out uint session, int flags, StringBuilder key);
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmRegisterResources(uint session, uint count, string[] files, uint apps, IntPtr processes, uint services, IntPtr names);
    [DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] Info[] info, ref uint reasons);
    [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint session);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    public static int DeleteAccess(string directory) {
        IntPtr handle=CreateFile(directory, 0x10000, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if(handle==new IntPtr(-1)) return Marshal.GetLastWin32Error();
        CloseHandle(handle); return 0;
    }
}
'@
$root=$env:HEXBOT_STAGING_DIAGNOSTIC
$deleteAccess=[HexbotRuntimeLocks]::DeleteAccess($root)
$files=@('node.exe','hexbot.exe','hexbot-cli.exe') | ForEach-Object { Join-Path $root $_ } | Where-Object { [IO.File]::Exists($_) }
$session=[uint32]0; $needed=[uint32]0; $count=[uint32]0; $reasons=[uint32]0
$started=[HexbotRuntimeLocks]::RmStartSession([ref]$session,0,[Text.StringBuilder]::new(33))
$owners=@(); $registered=$null; $listed=$null
try {
    if($started -eq 0 -and $files.Count -gt 0) {
        $registered=[HexbotRuntimeLocks]::RmRegisterResources($session,$files.Count,[string[]]$files,0,[IntPtr]::Zero,0,[IntPtr]::Zero)
        if($registered -eq 0) {
            $listed=[HexbotRuntimeLocks]::RmGetList($session,[ref]$needed,[ref]$count,$null,[ref]$reasons)
            if($listed -eq 234 -and $needed -le 64) {
                $info=New-Object 'HexbotRuntimeLocks+Info[]' $needed; $count=$needed
                $listed=[HexbotRuntimeLocks]::RmGetList($session,[ref]$needed,[ref]$count,$info,[ref]$reasons)
                if($listed -eq 0) { $owners=@($info | Select-Object -First $count | ForEach-Object { @{pid=$_.process.pid;createdLow=$_.process.created.dwLowDateTime;createdHigh=$_.process.created.dwHighDateTime;app=$_.app;service=$_.service;type=$_.type} }) }
            }
        }
    }
} finally { if($started -eq 0) { $null=[HexbotRuntimeLocks]::RmEndSession($session) } }
$related=@(Get-CimInstance Win32_Process -OperationTimeoutSec 2 | Where-Object {
    $_.ProcessId -eq [uint32]$env:HEXBOT_STAGING_PROBER -or $_.ProcessId -eq [uint32]$env:HEXBOT_STAGING_OWNER -or
    $_.ParentProcessId -eq [uint32]$env:HEXBOT_STAGING_OWNER -or
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) -or
    ($_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0)
} | Select-Object -First 24 | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;name=$_.Name;created=$_.CreationDate;image=$_.ExecutablePath} })
@{directoryDeleteAccess=$deleteAccess;attributes=[IO.File]::GetAttributes($root).ToString();restartManager=@{start=$started;register=$registered;list=$listed;needed=$needed;owners=$owners};related=$related} | ConvertTo-Json -Compress -Depth 5
