# GetFinalPathNameByHandle follows reparse points, unlike GetFullPath/Resolve-Path.
# Resolve BOTH operands so a home reached through a junction remains valid.
if (-not ('HexbotFinalPath' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class HexbotFinalPath {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle file,
        StringBuilder path, uint length, uint flags);
    public static string Resolve(string path) {
        // FILE_READ_ATTRIBUTES, share read/write/delete, OPEN_EXISTING,
        // FILE_FLAG_BACKUP_SEMANTICS. Do not use OPEN_REPARSE_POINT.
        using (var file = CreateFileW(path, 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
            if (file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            var result = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(file, result, (uint)result.Capacity, 0);
            if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (length >= result.Capacity) throw new InvalidOperationException("Runtime path is too long");
            string value = result.ToString();
            if (value.StartsWith(@"\\?\UNC\")) return @"\\" + value.Substring(8);
            if (value.StartsWith(@"\\?\")) return value.Substring(4);
            return value;
        }
    }
}
'@
}
function Select-HexbotRuntime {
    $root = [HexbotFinalPath]::Resolve((Join-Path $env:HEXBOT_HOME 'runtime/native')) + [IO.Path]::DirectorySeparatorChar
    $current = Get-Content -LiteralPath (Join-Path $env:HEXBOT_HOME 'runtime/native-current.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    if (!$current.executable -or ![IO.Path]::IsPathRooted($current.executable)) { throw 'Missing native runtime selection' }
    $exe = [HexbotFinalPath]::Resolve($current.executable)
    if (!$exe.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($exe) -cne 'hexbot.exe' -or ![IO.File]::Exists($exe)) {
        throw 'Invalid native runtime selection'
    }
    return $exe
}
