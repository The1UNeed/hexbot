import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, toNamespacedPath } from 'node:path'
import { promisify } from 'node:util'

export interface WindowsDaemon { pid: number; port: number; executable: string }
// The daemon's Windows byte-range lock denies reads even to its owner. Keep a
// process handle across authenticated HTTP and snapshot rechecks instead of
// interpreting a read failure as an absent daemon. An uncertain held home is an error.
export const windowsReadinessScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Home-Locked {
    $stream=[IO.File]::Open((Join-Path $env:HEXBOT_READINESS_HOME 'native-daemon.lock'),'Open','ReadWrite','ReadWrite,Delete')
    try {
        try { $stream.Lock(0,1); $stream.Unlock(0,1); return $false } catch [IO.IOException] {
            $e=$_.Exception; while($e.InnerException) { $e=$e.InnerException }
            if($e.HResult -ne -2147024863) { throw }
            return $true
        }
    } finally { $stream.Dispose() }
}
function Metadata($name) {
    $stream=[IO.File]::Open((Join-Path $env:HEXBOT_READINESS_HOME $name),'Open','Read','ReadWrite,Delete')
    $reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$true)
    try {
        $buffer=[char[]]::new(4097); $count=$reader.ReadBlock($buffer,0,$buffer.Length)
        if($count -gt 4096) { throw 'Oversized daemon readiness metadata' }
        return [string]::new($buffer,0,$count)
    } finally { $reader.Dispose() }
}

if(!(Home-Locked)) { 'null'; exit 0 }
$process=$null
try {
    $recordText=Metadata 'runtime/native-running.json'; $record=$recordText|ConvertFrom-Json
    $stateText=Metadata 'serve-state.json'; $state=$stateText|ConvertFrom-Json
    $number=[uint32]0; $port=[int]0
    if(![uint32]::TryParse([string]$record.pid,[ref]$number) -or $number -eq 0 -or
       ![int]::TryParse([string]$state.port,[ref]$port) -or $port -lt 1 -or $port -gt 65535 -or
       $record.executable -isnot [string]) { throw 'Invalid daemon readiness metadata' }
    $process=[Diagnostics.Process]::GetProcessById($number)
    $null=$process.Handle
    if($process.HasExited) { throw 'Recorded daemon exited' }
    $created=$process.StartTime.ToFileTimeUtc().ToString()
    $image=$process.MainModule.FileName
    $item=Get-CimInstance Win32_Process -Filter "ProcessId=$number" -OperationTimeoutSec 2
    $owner=(Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid -OperationTimeoutSec 2).Sid
    if($owner -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Daemon has another owner' }
    $identity=Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/daemon/identity" -TimeoutSec 2 -MaximumRedirection 0 -UseBasicParsing
    $install=Metadata 'install_id'
    if(!$install.Trim() -or $identity.install_id -cne $install.Trim() -or $identity.pid -ne $number) { throw 'Daemon belongs to another home or process' }
    if($process.HasExited -or $process.StartTime.ToFileTimeUtc().ToString() -cne $created -or
       (Metadata 'runtime/native-running.json') -cne $recordText -or
       (Metadata 'serve-state.json') -cne $stateText -or (Metadata 'install_id') -cne $install -or !(Home-Locked)) { throw 'Daemon identity changed during readiness' }
    @{pid=$number;port=$port;executable=$record.executable;image=$image;created=$created}|ConvertTo-Json -Compress
} finally { if($null -ne $process) { $process.Dispose() } }
`

export async function windowsDaemon(home: string): Promise<WindowsDaemon | undefined> {
  let lock
  try { lock = await lstat(join(home, 'native-daemon.lock')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  if (!lock.isFile()) throw new Error('Invalid daemon home lock')
  const canonicalHome = await realpath(home)
  const system = process.env.SystemRoot
  if (!system || !isAbsolute(system)) throw new Error('Windows system directory is unavailable')
  const { stdout } = await promisify(execFile)(join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsReadinessScript, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 10_000, maxBuffer: 16_384, env: { ...process.env, HEXBOT_READINESS_HOME: canonicalHome } })
    .catch(() => { throw new Error('Cannot verify the daemon holding this home') })
  const value = JSON.parse(stdout) as (WindowsDaemon & { image: string; created: string }) | null
  if (!value) return undefined
  if (!Number.isInteger(value.pid) || value.pid <= 0 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !value.created)
    throw new Error('Invalid daemon readiness result')
  const canonical = async (path: string): Promise<string> => toNamespacedPath(await realpath(path))
  const executable = await canonical(value.executable)
  const root = await canonical(join(canonicalHome, 'runtime/native'))
  const rel = relative(root, executable)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || basename(executable) !== 'hexbot.exe' || executable !== await canonical(value.image))
    throw new Error('Running daemon is outside this managed runtime')
  return { pid: value.pid, port: value.port, executable }
}
