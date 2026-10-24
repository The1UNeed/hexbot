// Actual manager lifecycle with injected streams/proof. No native daemon proof.
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, toNamespacedPath } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { DaemonManager, backoffSchedule } from './manager'
// @ts-expect-error The installed-app harness is untyped Node ESM.
import { startInstalledOwned } from '../../../../../scripts/desktop/installed-app-lifecycle.mjs'
// @ts-expect-error This test executes the same serialized main-process observer.
import { observeInstalledStatus, installedStatusAction } from '../../../../../scripts/desktop/installed-app-status.mjs'

const spawnDaemon = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: spawnDaemon }))
vi.mock('electron', () => ({ app: { on() {}, isPackaged: true } }))

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'hexbot observed manager '))
  const priorHome = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  await mkdir(join(home, 'runtime')); await mkdir(join(home, 'logs'))
  const selected = join(home, 'runtime/selected')
  await writeFile(selected, '')
  const executable = toNamespacedPath(await realpath(selected))
  const makeChild = (pid: number) => {
    const child = Object.assign(new EventEmitter(), { pid, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() })
    child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('exit', 0, null)); return true })
    child.stdin.on('finish', () => child.emit('exit', 0, null))
    return child
  }
  const children = [makeChild(42), makeChild(43)]
  let retrySpawned!: () => void
  const retry = new Promise<void>(resolve => { retrySpawned = resolve })
  spawnDaemon.mockReset()
  spawnDaemon.mockReturnValueOnce(children[0]).mockImplementationOnce(() => { retrySpawned(); return children[1] })
  const manager = new DaemonManager(9119), app = new EventEmitter()
  app.on('hexbot:installed-smoke:manager', (read: (manager: DaemonManager) => void) => read(manager))
  const observers: Array<EventEmitter & { notify: () => void; closed: boolean }> = []
  let active: { finish: (ready?: unknown) => Promise<string | null> } | undefined
  let checked!: () => void
  const initialCheck = new Promise<void>(resolve => { checked = resolve })
  let probes = 0, starts = 0
  const evaluate = (action: typeof installedStatusAction, value: unknown) => Promise.resolve(action({ app }, value))
  const options = {
    home, selected, previousPid: 41,
    observeStatus: async () => { active = await observeInstalledStatus(evaluate); return active },
    start: (): Promise<unknown> => { starts++; return manager.start() },
    status: async () => {
      const value = manager.status()
      if (value.state === 'starting' && !value.lastError) checked()
      return value
    },
    probe: async () => { probes++; return { pid: manager.status().pid, port: 9119, executable } },
    watchDirectory: (_directory: string, notify: () => void) => {
      const observer = Object.assign(new EventEmitter(), { notify, closed: false, close() { this.closed = true } })
      observers.push(observer)
      return observer
    }
  }
  return { home, manager, children, options, initialCheck, observers, retry,
    probes: () => probes, starts: () => starts,
    ready() { const child = children[spawnDaemon.mock.calls.length - 1]!; child.stdout.write('HERMES_BACKEND_READY port=9119\n'); for (const observer of observers) if (!observer.closed) observer.notify() },
    evaluate,
    async cleanup() {
      await active?.finish().catch(() => undefined)
      await manager.stop()
      vi.useRealTimers()
      if (priorHome === undefined) delete process.env.HEXBOT_HOME
      else process.env.HEXBOT_HOME = priorHome
      await rm(home, { recursive: true, force: true })
    }
  }
}

it('latches an actual silent manager crash without a file event before retry READY', async () => {
  const f = await fixture()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const operation = startInstalledOwned(f.options)
    const rejected = expect(operation).rejects.toThrow('Daemon exited (1); restarting')
    await f.initialCheck
    expect(f.manager.status()).toEqual({ state: 'starting', port: 9119 })
    f.children[0]!.emit('exit', 1, null) // No directory notification.
    expect(f.manager.status().lastError).toBe('Daemon exited (1); restarting')
    await vi.advanceTimersByTimeAsync(backoffSchedule[0])
    await f.retry
    expect(spawnDaemon).toHaveBeenCalledTimes(2)
    expect(f.manager.status()).toEqual({ state: 'starting', port: 9119 })
    f.ready() // The retry clears lastError, then emits READY and a later file event.
    await rejected
    expect(f.probes()).toBe(0)
    expect(f.starts()).toBe(1)
    expect(f.manager.listenerCount('status')).toBe(0)
    expect(f.observers.every(observer => observer.closed)).toBe(true)
  } finally { await f.cleanup() }
})

it('captures a crash while the one requested start IPC is still pending', async () => {
  const f = await fixture()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let release!: (value?: unknown) => void, rejectLate!: (reason: Error) => void
  const pending = new Promise((resolve, reject) => { release = resolve; rejectLate = reject })
  let entered!: () => void
  const spawned = new Promise<void>(resolve => { entered = resolve })
  f.options.start = async () => { await f.manager.start(); entered(); return pending }
  try {
    const operation = startInstalledOwned(f.options)
    const rejected = expect(operation).rejects.toThrow('Daemon exited (1); restarting')
    await spawned
    expect(f.manager.listenerCount('status')).toBe(1)
    f.children[0]!.emit('exit', 1, null)
    await rejected
    rejectLate(new Error('late start IPC failure is observed'))
    expect(f.observers).toHaveLength(0)
    expect(f.manager.listenerCount('status')).toBe(0)
  } finally { release(); await f.cleanup() }
})

it('atomically rejects a crash between strict proof and observer removal', async () => {
  const f = await fixture()
  f.options.observeStatus = async () => observeInstalledStatus((action: typeof installedStatusAction, value: { action: string; ready?: unknown }) => {
    if (value.action === 'finish' && value.ready) f.children[0]!.emit('exit', 1, null)
    return f.evaluate(action, value)
  })
  try {
    const operation = startInstalledOwned(f.options)
    const rejected = expect(operation).rejects.toThrow('Daemon exited (1); restarting')
    await f.initialCheck
    f.ready()
    await rejected
    expect(f.probes()).toBe(1)
    expect(f.manager.listenerCount('status')).toBe(0)
  } finally { await f.cleanup() }
})

it('rejects existing backoff before invoking start, while quiet legitimate startup passes', async () => {
  const f = await fixture()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await f.manager.start()
    f.children[0]!.emit('exit', 1, null)
    await expect(startInstalledOwned(f.options)).rejects.toThrow('Daemon exited (1); restarting')
    expect(f.starts()).toBe(0)
    expect(f.manager.listenerCount('status')).toBe(0)
  } finally { await f.cleanup() }
  const quiet = await fixture()
  try {
    const operation = startInstalledOwned(quiet.options)
    await quiet.initialCheck
    quiet.ready()
    expect((await operation).pid).toBe(42)
    expect(quiet.manager.listenerCount('status')).toBe(0)
  } finally { await quiet.cleanup() }
})

it('start failure always removes the main observer and preserves the actual error', async () => {
  const f = await fixture(), error = new Error('start IPC failed')
  f.options.start = () => { expect(f.manager.listenerCount('status')).toBe(1); throw error }
  try {
    await expect(startInstalledOwned(f.options)).rejects.toBe(error)
    expect(f.manager.listenerCount('status')).toBe(0)
    expect(f.observers).toHaveLength(0)
  } finally { await f.cleanup() }
})

it('deadline abort drains the active proof before disposing its main observer', async () => {
  const f = await fixture()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let close!: () => void, entered!: () => void, signal: AbortSignal | undefined
  const closed = new Promise<void>(resolve => { close = resolve })
  const proving = new Promise<void>(resolve => { entered = resolve })
  const options = { ...f.options, timeout: 1000, probe: async (_home: string, value: AbortSignal) => { signal = value; entered(); await closed; value.throwIfAborted() } }
  let settled = false
  try {
    const operation = startInstalledOwned(options)
    const rejected = expect(operation).rejects.toThrow('within 1000 ms')
    operation.then(() => { settled = true }, () => { settled = true })
    await f.initialCheck
    f.ready()
    await proving
    await vi.advanceTimersByTimeAsync(1000)
    expect(signal!.aborted).toBe(true)
    expect(settled).toBe(false)
    close()
    await rejected
    expect(f.manager.listenerCount('status')).toBe(0)
    expect(f.observers.every(observer => observer.closed)).toBe(true)
  } finally { close(); await f.cleanup() }
})

it('deadline drains a late subscription acknowledgement without starting or leaking an observer', async () => {
  const f = await fixture()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let acknowledge!: () => void, installed!: () => void
  const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve })
  const subscribed = new Promise<void>(resolve => { installed = resolve })
  let observation: { finish: () => Promise<unknown> } | undefined, settled = false
  const options = { ...f.options, timeout: 1000, observeStatus: async () => {
    observation = await observeInstalledStatus(f.evaluate)
    installed()
    await acknowledgement
    return observation
  } }
  try {
    const operation = startInstalledOwned(options)
    const rejected = expect(operation).rejects.toThrow('within 1000 ms')
    operation.then(() => { settled = true }, () => { settled = true })
    await subscribed
    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toBe(false)
    acknowledge()
    await rejected
    expect(f.starts()).toBe(0)
    expect(f.observers).toHaveLength(0)
    expect(f.manager.listenerCount('status')).toBe(0)
  } finally { acknowledge(); await observation?.finish(); await f.cleanup() }
})
