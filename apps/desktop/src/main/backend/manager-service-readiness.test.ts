import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DaemonManager } from './manager'

const controls = vi.hoisted(() => ({
  watches: [] as { notify: () => void; watcher: import('node:fs').FSWatcher }[],
  watchFailure: false,
  readFile: vi.fn(),
  spawn: vi.fn()
}))
vi.mock('node:fs', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  const { EventEmitter } = await vi.importActual<typeof import('node:events')>('node:events')
  return { ...fs, existsSync: () => true, watch: (_path: string, notify: () => void) => {
    if (controls.watchFailure && controls.watches.length) throw new Error('Cannot watch runtime')
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as import('node:fs').FSWatcher
    controls.watches.push({ notify, watcher })
    return watcher
  } }
})
vi.mock('node:fs/promises', async () => ({
  ...await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'),
  readFile: controls.readFile
}))
vi.mock('node:child_process', () => ({ spawn: controls.spawn }))
vi.mock('electron', () => ({ app: { on: () => undefined, isPackaged: true } }))

const fetchIdentity = vi.fn<typeof fetch>()
const ready = (): Response => new Response(JSON.stringify({ install_id: 'service-home', pid: process.pid }))
const previousHome = process.env.HEXBOT_HOME
beforeEach(() => {
  vi.useFakeTimers()
  controls.watches.length = 0
  controls.watchFailure = false
  controls.spawn.mockReset()
  controls.readFile.mockImplementation(async (path: string) => {
    if (path.endsWith('native-daemon.lock')) return String(process.pid)
    if (path.endsWith('serve-state.json')) return JSON.stringify({ port: 9237 })
    if (path.endsWith('install_id')) return 'service-home'
    throw new Error(`Unexpected read: ${path}`)
  })
  fetchIdentity.mockReset()
  vi.stubGlobal('fetch', fetchIdentity)
  process.env.HEXBOT_HOME = '/unused-service-readiness-home'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (previousHome === undefined) delete process.env.HEXBOT_HOME
  else process.env.HEXBOT_HOME = previousHome
})
const cleaned = (manager: DaemonManager): void => {
  expect(vi.getTimerCount()).toBe(0)
  expect(manager.listenerCount('transition-cancelled')).toBe(0)
  for (const { watcher } of controls.watches) {
    expect(watcher.close).toHaveBeenCalledOnce()
    expect(watcher.listenerCount('error')).toBe(0)
  }
  expect(controls.spawn).not.toHaveBeenCalled()
}

it('retries failed HTTP readiness after one publication and no later filesystem events', async () => {
  let fail!: (error: Error) => void
  fetchIdentity.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  fetchIdentity.mockRejectedValueOnce(new Error('Still initializing'))
  fetchIdentity.mockResolvedValue(ready())
  const manager = new DaemonManager()
  const completed = vi.fn()
  const installing = manager.installService(async () => undefined).then(completed)
  await vi.advanceTimersByTimeAsync(0)
  expect(fetchIdentity).toHaveBeenCalledOnce()
  // The final publication occurs during initialization; HTTP is still unavailable.
  controls.watches[0]!.notify()
  fail(new Error('Identity probe timed out'))
  await vi.advanceTimersByTimeAsync(0)
  expect(completed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(250)
  expect(completed).toHaveBeenCalledOnce()
  await installing
  expect(completed).toHaveBeenCalledOnce()
  cleaned(manager)
})

it('probes again when HTTP becomes ready with no filesystem event after the failed probe', async () => {
  fetchIdentity.mockRejectedValueOnce(new Error('HTTP not serving yet'))
  fetchIdentity.mockResolvedValue(ready())
  const manager = new DaemonManager()
  const completed = vi.fn()
  const installing = manager.installService(async () => undefined).then(completed)
  await vi.advanceTimersByTimeAsync(0)
  expect(completed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(250)
  expect(completed).toHaveBeenCalledOnce()
  await installing
  expect(manager.status()).toEqual({ state: 'external', port: 9237 })
  cleaned(manager)
})

it('keeps probes serial, enforces the original deadline, and leaves an external daemon owned externally', async () => {
  fetchIdentity.mockResolvedValueOnce(ready())
  const manager = new DaemonManager()
  expect(await manager.start()).toEqual({ state: 'external', port: 9237 })
  let finishProbe!: (response: Response) => void
  fetchIdentity.mockImplementationOnce(() => new Promise(resolve => { finishProbe = resolve }))
  fetchIdentity.mockRejectedValue(new Error('Not ready'))
  const installing = manager.installService(async () => undefined)
  const failed = expect(installing).rejects.toThrow('did not become ready')
  await vi.advanceTimersByTimeAsync(0)
  for (let event = 0; event < 5; event++) controls.watches[0]!.notify()
  await vi.advanceTimersByTimeAsync(29_999)
  expect(fetchIdentity).toHaveBeenCalledTimes(2)
  expect(controls.watches[0]!.watcher.close).not.toHaveBeenCalled()
  const signal = fetchIdentity.mock.calls[1]![1]!.signal!
  await vi.advanceTimersByTimeAsync(1)
  await failed
  expect(signal.aborted).toBe(true)
  finishProbe(ready())
  await vi.advanceTimersByTimeAsync(0)
  expect(await manager.stop()).toEqual({ state: 'external', port: 9237 })
  cleaned(manager)
})

it('bounds repeated failed probes to thirty seconds without extending the deadline', async () => {
  fetchIdentity.mockRejectedValue(new Error('Not ready'))
  const manager = new DaemonManager()
  const installing = manager.installService(async () => undefined)
  const failed = expect(installing).rejects.toThrow('did not become ready')
  await vi.advanceTimersByTimeAsync(29_999)
  expect(fetchIdentity.mock.calls.length).toBeGreaterThan(1)
  expect(fetchIdentity.mock.calls.length).toBeLessThanOrEqual(120)
  await vi.advanceTimersByTimeAsync(1)
  await failed
  cleaned(manager)
})

it('cancels an in-flight service probe and cleans its deadline and watchers', async () => {
  let finishProbe!: (response: Response) => void
  fetchIdentity.mockImplementation(() => new Promise(resolve => { finishProbe = resolve }))
  const manager = new DaemonManager()
  const installing = manager.installService(async () => undefined)
  const failed = expect(installing).rejects.toThrow('superseded')
  await vi.advanceTimersByTimeAsync(0)
  const signal = fetchIdentity.mock.calls[0]![1]!.signal!
  const stopping = manager.stop()
  await vi.advanceTimersByTimeAsync(0)
  await failed
  await stopping
  expect(signal.aborted).toBe(true)
  finishProbe(ready())
  await vi.advanceTimersByTimeAsync(0)
  expect(manager.status().state).toBe('stopped')
  cleaned(manager)
})

it.each(['event', 'creation'])('cleans watchers and timers after a watch %s error', async kind => {
  fetchIdentity.mockRejectedValue(new Error('Not ready'))
  controls.watchFailure = kind === 'creation'
  const manager = new DaemonManager()
  const installing = manager.installService(async () => undefined)
  const failed = expect(installing).rejects.toThrow(kind === 'creation' ? 'Cannot watch' : 'Watch failed')
  await vi.advanceTimersByTimeAsync(0)
  if (kind === 'event') controls.watches[0]!.watcher.emit('error', new Error('Watch failed'))
  await failed
  cleaned(manager)
})
