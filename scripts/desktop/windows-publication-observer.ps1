# Test-only prewarmed, read-only observer. No handle is acquired in a staged
# tree, or to its process, until a failed Node rename has already been reported.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class HexbotPublicationObserver {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFileAttributesW(string path);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr handle,StringBuilder name,uint size,uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetShortPathNameW(string path,StringBuilder name,uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr handle,uint flags,StringBuilder image,ref uint size);
    public static object Directory(string path) {
        // DELETE, share READ|WRITE|DELETE, OPEN_EXISTING, BACKUP_SEMANTICS.
        IntPtr handle=CreateFileW(path,0x10000,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
        int deleteError=handle==new IntPtr(-1)?Marshal.GetLastWin32Error():0;
        string canonical=null; int canonicalError=0;
        try {
            if(handle!=new IntPtr(-1)) {
                var name=new StringBuilder(32768);
                uint size=GetFinalPathNameByHandleW(handle,name,(uint)name.Capacity,0);
                if(size==0) canonicalError=Marshal.GetLastWin32Error();
                else if(size<name.Capacity) canonical=name.ToString();
            }
        } finally { if(handle!=new IntPtr(-1)) CloseHandle(handle); }
        uint attributes=GetFileAttributesW(path);
        int attributesError=attributes==0xffffffff?Marshal.GetLastWin32Error():0;
        var shortName=new StringBuilder(32768);
        uint length=GetShortPathNameW(path,shortName,(uint)shortName.Capacity);
        int shortError=length==0?Marshal.GetLastWin32Error():0;
        return new {path,deleteError,share=7,creation=3,flags=0x02000000,canonical,canonicalError,attributes,attributesError,
            shortPath=length>0 && length<shortName.Capacity?shortName.ToString():null,shortError};
    }
    public static object Process(uint pid) {
        IntPtr handle=OpenProcess(0x100000|0x1000,false,pid); // SYNCHRONIZE|QUERY_LIMITED_INFORMATION
        int openError=handle==IntPtr.Zero?Marshal.GetLastWin32Error():0;
        if(handle==IntPtr.Zero) return new {pid,openError};
        try {
            uint wait=WaitForSingleObject(handle,0); int waitError=wait==0xffffffff?Marshal.GetLastWin32Error():0;
            uint code; bool exitOk=GetExitCodeProcess(handle,out code); int exitError=exitOk?0:Marshal.GetLastWin32Error();
            long created,exited,kernel,user; bool timesOk=GetProcessTimes(handle,out created,out exited,out kernel,out user);
            int timesError=timesOk?0:Marshal.GetLastWin32Error();
            var image=new StringBuilder(32768); uint size=(uint)image.Capacity;
            bool imageOk=QueryFullProcessImageNameW(handle,0,image,ref size); int imageError=imageOk?0:Marshal.GetLastWin32Error();
            return new {pid,openError,wait,waitError,exitCode=code,exitError,created=timesOk?created.ToString():null,timesError,
                image=imageOk?image.ToString():null,imageError};
        } finally { CloseHandle(handle); }
    }
}
'@
@{ready=$true;pid=$PID;cwd=[Environment]::CurrentDirectory;utc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
while($null -ne ($line=[Console]::ReadLine())) {
    if($line.Length -gt 8192) { throw 'Observer request too large' }
    $request=$line | ConvertFrom-Json
    $start=[DateTime]::UtcNow.ToString('o'); $ticks=[Diagnostics.Stopwatch]::GetTimestamp()
    try {
        if(@($request.paths).Count -ne 2) { throw 'Expected source and destination' }
        $directories=@($request.paths | ForEach-Object { [HexbotPublicationObserver]::Directory([string]$_) })
        $process=[HexbotPublicationObserver]::Process([uint32]$request.pid)
        @{id=$request.id;startedUtc=$start;finishedUtc=[DateTime]::UtcNow.ToString('o');workerTicks=$ticks;workerEndTicks=[Diagnostics.Stopwatch]::GetTimestamp();tickFrequency=[Diagnostics.Stopwatch]::Frequency;directories=$directories;process=$process} | ConvertTo-Json -Compress -Depth 5
    } catch { @{id=$request.id;startedUtc=$start;error=$_.Exception.GetType().Name} | ConvertTo-Json -Compress }
}
