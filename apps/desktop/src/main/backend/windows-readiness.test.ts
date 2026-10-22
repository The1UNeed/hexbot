import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readFile, mkdir, mkdtemp, rm, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { windowsDaemon } from './windows-readiness'
import { runningDaemonPort, selectedDaemon, lockedDaemonPid, DaemonManager } from './manager'
import { reconcileWindowsService } from '../service'
vi.mock('electron', () => ({ app: { on: () => undefined, isPackaged: true } }))
const exec = promisify(execFile)

it.skipIf(process.platform !== 'win32' || !process.env.HEXBOT_NATIVE_TEST_BUNDLE)('authenticates a real locked Windows home without reading the locked PID bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot José readiness '))
  const home = join(root, 'home')
  const previous = { ...process.env }
  process.env.HEXBOT_HOME = home
  process.env.HEXBOT_CLI_NO_PATH = '1'
  let child: ChildProcess | undefined
  let exit: Promise<[number | null, NodeJS.Signals | null]> | undefined
  const stop = async (): Promise<void> => {
    if (!child) return
    child.stdin!.end('HEXBOT_SHUTDOWN_V1\n')
    const deadline = setTimeout(() => child?.kill('SIGKILL'), 10_000)
    try { expect(await exit).toEqual([0, null]) }
    finally { clearTimeout(deadline); child = undefined }
  }
  try {
    await mkdir(home)
    await exec(join(process.env.HEXBOT_NATIVE_TEST_BUNDLE!, 'hexbot.exe'), ['setup', '--activate', '--no-code-tools', '--json'],
      { env: process.env, windowsHide: true, timeout: 60_000 })
    const selected = JSON.parse(await readFile(join(home, 'runtime/native-current.json'), 'utf8')).executable as string
    const start = async (): Promise<void> => {
      child = spawn(selected, ['serve', '--host', '127.0.0.1', '--port', '0'], {
        env: { ...process.env, HEXBOT_SUPERVISOR: 'desktop', HEXBOT_DESKTOP_CONTROL: 'stdin-v1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      })
      exit = once(child, 'exit') as typeof exit
      const fixture = child
      let output = '', stderr = ''
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Readiness fixture deadline; stderr=${stderr}`)), 30_000)
        fixture.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-2048) })
        fixture.stdout!.on('data', chunk => {
          output += chunk
          if (/HERMES_BACKEND_READY port=\d+/.test(output)) { clearTimeout(timer); resolve() }
        })
        fixture.once('error', error => { clearTimeout(timer); reject(error) })
        fixture.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Readiness fixture exited ${code}/${signal}; stderr=${stderr}`)) })
      })
    }
    await start()
    const pid = child!.pid!
    await expect(readFile(join(home, 'native-daemon.lock'))).rejects.toMatchObject({ code: 'EBUSY' })
    console.info('Actual Windows Node read of native held lock refused EBUSY; desktop fixture PID', pid)
    const ready = await windowsDaemon(home)
    expect(ready?.pid).toBe(pid)
    expect(await lockedDaemonPid()).toBe(pid)
    expect(await runningDaemonPort()).toBe(ready!.port)
    expect((await selectedDaemon())?.pid).toBe(pid)
    const manager = new DaemonManager()
    expect((await manager.start()).state).toBe('external')
    expect((await manager.stop()).state).toBe('external')
    expect(child!.exitCode).toBeNull()
    const call = vi.fn(async () => ({ stdout: JSON.stringify({ installed: true, running: true }) }))
    // Same selected runtime never restarts a verified healthy task.
    expect(await reconcileWindowsService('win32', call)).toBeUndefined()
    expect(call).toHaveBeenCalledTimes(1)

    const runningPath = join(home, 'runtime/native-running.json')
    const record = await readFile(runningPath, 'utf8')
    const installPath = join(home, 'install_id')
    const install = await readFile(installPath, 'utf8')
    const expectHeldRefusal = async (): Promise<void> => {
      await expect(windowsDaemon(home)).rejects.toThrow()
      const challenger = new DaemonManager()
      try {
        await expect(challenger.start()).rejects.toThrow()
        expect(challenger.status().state).toBe('stopped')
      } finally { await challenger.stop().catch(() => undefined) }
      expect(child!.exitCode).toBeNull()
    }
    for (const value of ['{}', '{', JSON.stringify({ pid: 2147483647, executable: selected }),
      JSON.stringify({ pid: globalThis.process.pid, executable: selected }),
      JSON.stringify({ pid, executable: globalThis.process.execPath })]) {
      await writeFile(runningPath, value)
      try { await expectHeldRefusal() } finally { await writeFile(runningPath, record) }
    }
    // Wrong home identity, unreadable metadata and invalid file type must not
    // grant spawn/stop authority over the live holder, even if PID is live.
    await writeFile(installPath, 'another-home')
    try { await expectHeldRefusal() } finally { await writeFile(installPath, install) }
    const hidden = join(dirname(runningPath), 'saved-record.json')
    await rename(runningPath, hidden)
    await mkdir(runningPath)
    try { await expectHeldRefusal() } finally { await rm(runningPath, { recursive: true }); await rename(hidden, runningPath) }
    const ps = join(globalThis.process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const deny = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', "$f=[IO.File]::Open($env:HEXBOT_TEST_RECORD,'Open','ReadWrite','None');try{[Console]::WriteLine('LOCKED');[Console]::ReadLine()|Out-Null}finally{$f.Dispose()}"],
      { env: { ...globalThis.process.env, HEXBOT_TEST_RECORD: runningPath }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const denyExit = once(deny, 'exit')
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Metadata deny fixture deadline')), 10_000)
        deny.stdout.on('data', bytes => { if (bytes.toString().includes('LOCKED')) { clearTimeout(timer); resolve() } })
        deny.once('exit', code => { clearTimeout(timer); reject(new Error(`Metadata deny fixture exit ${code}`)) })
      })
      await expectHeldRefusal()
    } finally { deny.stdin.end('\n'); expect(await denyExit).toEqual([0, null]) }
    const attributes = await exec(ps, ['-NoProfile', '-NonInteractive', '-Command', "[int][IO.File]::GetAttributes($env:HEXBOT_TEST_LOCK)"], { env: { ...globalThis.process.env, HEXBOT_TEST_LOCK: join(home, 'native-daemon.lock') }, windowsHide: true })
    await exec(ps, ['-NoProfile', '-NonInteractive', '-Command', "[IO.File]::SetAttributes($env:HEXBOT_TEST_LOCK,([IO.FileAttributes]::ReadOnly -bor [int]$env:HEXBOT_TEST_ATTRIBUTES))"], { env: { ...globalThis.process.env, HEXBOT_TEST_LOCK: join(home, 'native-daemon.lock'), HEXBOT_TEST_ATTRIBUTES: attributes.stdout.trim() }, windowsHide: true })
    try { await expectHeldRefusal() } finally {
      await exec(ps, ['-NoProfile', '-NonInteractive', '-Command', "[IO.File]::SetAttributes($env:HEXBOT_TEST_LOCK,[int]$env:HEXBOT_TEST_ATTRIBUTES)"], { env: { ...globalThis.process.env, HEXBOT_TEST_LOCK: join(home, 'native-daemon.lock'), HEXBOT_TEST_ATTRIBUTES: attributes.stdout.trim() }, windowsHide: true })
    }
    await stop()
    expect((await readFile(join(home, 'native-daemon.lock'), 'utf8')).trim()).toBe(String(pid))
    expect(await windowsDaemon(home)).toBeUndefined() // Stale record, genuinely free lock.
    await start()
    expect((await windowsDaemon(home))?.pid).toBe(child!.pid)
    expect(child!.pid).not.toBe(pid)
    await stop()
  } finally {
    await stop()
    process.env = previous
    await rm(root, { recursive: true, force: true })
  }
}, 300_000)
