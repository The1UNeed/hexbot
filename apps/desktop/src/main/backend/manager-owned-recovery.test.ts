import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DaemonManager, backoffSchedule } from './manager'

const controls = vi.hoisted(() => ({
  spawn: vi.fn(), freeFrom: 9120, attempts: [] as number[],
  quit: undefined as undefined | ((event: { preventDefault(): void }) => void), exit: vi.fn()
}))
vi.mock('electron', () => ({ app: {
  isPackaged: true,
  on: (_event: string, listener: typeof controls.quit) => { controls.quit = listener },
  exit: controls.exit
} }))
vi.mock('node:child_process', () => ({ spawn: controls.spawn }))
vi.mock('node:net', async () => {
  const actual = await vi.importActual<typeof import('node:net')>('node:net')
  const { EventEmitter } = await import('node:events')
  const createServer = () => {
    const server = Object.assign(new EventEmitter(), {
      listen(port: number, _host: string, callback: () => void) {
        controls.attempts.push(port)
        queueMicrotask(() => port < controls.freeFrom ? server.emit('error', new Error('busy')) : callback())
      },
      close(callback: () => void) { callback() }
    })
    return server
  }
  return { ...actual, default: { ...actual, createServer } }
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function child() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: process.pid,
    kill: vi.fn(() => { listening = false; queueMicrotask(() => child.emit('exit', 0, null)); return true })
  })
  return child
}
type Launch = { executable: string; port: number; child: ReturnType<typeof child> }
let home: string, previousHome: string | undefined, manager: DaemonManager, oldExecutable: string, replacement: string
let listening: boolean, identity: string
let spawned: Launch[], waiting: ReturnType<typeof deferred<Launch>> | undefined
const nextSpawn = () => { waiting = deferred<Launch>(); return waiting.promise }

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'hexbot-owned-recovery-')))
  previousHome = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  await mkdir(join(home, 'runtime'))
  oldExecutable = join(home, 'old-immutable-runtime')
  replacement = join(home, 'new-immutable-runtime')
  await writeFile(oldExecutable, 'previously owned bytes')
  await writeFile(replacement, 'prepared replacement bytes')
  await symlink(oldExecutable, join(home, 'runtime/native-executable'))
  await writeFile(join(home, 'install_id'), 'owned-home')
  spawned = []; waiting = undefined; listening = false; identity = 'owned-home'
  controls.freeFrom = 9120; controls.attempts.length = 0; controls.exit.mockReset()
  controls.spawn.mockReset().mockImplementation((executable: string, args: string[]) => {
    const launch = { executable, port: Number(args[2]), child: child() }
    spawned.push(launch)
    const notify = waiting; waiting = undefined
    queueMicrotask(() => notify?.resolve(launch))
    return launch.child
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ install_id: identity, pid: process.pid }), { status: listening ? 200 : 503 }
  )))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  manager = new DaemonManager()
})
afterEach(async () => {
  await manager.stop()
  vi.useRealTimers(); vi.unstubAllGlobals()
  if (previousHome === undefined) delete process.env.HEXBOT_HOME
  else process.env.HEXBOT_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})
async function ready(launch: Launch) {
  listening = true
  await writeFile(join(home, 'native-daemon.lock'), String(process.pid))
  await writeFile(join(home, 'serve-state.json'), JSON.stringify({ port: launch.port }))
  await writeFile(join(home, 'runtime/native-running.json'), JSON.stringify({ pid: process.pid, executable: launch.executable }))
  launch.child.stdout.write(`HERMES_BACKEND_READY port=${launch.port}\n`)
}
async function startOld(prepared = true) {
  const spawned = nextSpawn()
  const starting = manager.start(prepared ? async () => ({ executable: oldExecutable, version: '1.0.0' }) : undefined)
  const first = await spawned
  await ready(first); await starting
  expect(first.port).toBe(9120)
  return first
}
function crash(launch: Launch) {
  listening = false
  launch.child.emit('exit', 1, null)
  expect(manager.status().state).toBe('starting')
  expect(vi.getTimerCount()).toBe(1)
}

it.each([true, false])('restores the previous owned runtime after preparation rejects during backoff (prepared=%s)', async prepared => {
  const first = await startOld(prepared)
  crash(first)
  // A separately selected path must not replace the runtime being recovered.
  await rm(join(home, 'runtime/native-executable'))
  await symlink(replacement, join(home, 'runtime/native-executable'))
  const recovered = nextSpawn()
  const failure = new Error('Preparation refused damaged selection')
  const outcome = manager.start(async () => { throw failure }).then(() => undefined, error => error)
  const result = await Promise.race([recovered, outcome])
  expect(result).not.toBe(failure)
  const launch = result as Launch
  expect(launch.executable).toBe(oldExecutable)
  expect(launch.port).toBe(9120)
  await ready(launch)
  expect(await outcome).toBe(failure)
  expect(manager.status()).toMatchObject({ state: 'running', port: 9120 })
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(backoffSchedule[0])
  expect(spawned).toHaveLength(2)
})

it.each(['stop', 'quit', 'supersede'])('does not restore a cancelled backoff transition after %s', async action => {
  const first = await startOld(); crash(first)
  const entered = deferred(), release = deferred()
  const failed = manager.start(async () => { entered.resolve(); await release.promise; throw new Error('Old preparation failed') })
    .then(() => undefined, error => error)
  await entered.promise
  let completed: Promise<unknown>
  let newer: Promise<Launch> | undefined
  if (action === 'stop') completed = manager.stop()
  else if (action === 'quit') {
    const exited = deferred()
    controls.exit.mockImplementation(() => exited.resolve())
    controls.quit!({ preventDefault: vi.fn() })
    completed = exited.promise
  } else {
    newer = nextSpawn()
    completed = manager.start(async () => ({ executable: replacement, version: '2.0.0' }))
  }
  release.resolve()
  expect(await failed).toBeInstanceOf(Error)
  if (newer) { const launch = await newer; expect(launch.executable).toBe(replacement); await ready(launch) }
  await completed
  await vi.advanceTimersByTimeAsync(60_000)
  expect(spawned).toHaveLength(action === 'supersede' ? 2 : 1)
  expect(manager.status().state).toBe(action === 'supersede' ? 'running' : 'stopped')
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the owned listening port for replacement when the default port becomes free', async () => {
  const first = await startOld()
  controls.freeFrom = 9119
  const replacing = nextSpawn()
  const starting = manager.start(async () => ({ executable: replacement, version: '2.0.0' }))
  const launch = await replacing
  await ready(launch); await starting
  expect(launch.port).toBe(first.port)
  expect(controls.attempts).toEqual([9119, 9120])
  expect(first.child.kill).toHaveBeenCalledOnce()
  expect(manager.status()).toMatchObject({ state: 'running', port: 9120 })
})

it.each(['stop', 'quit'])('cancels recovery blocked in an identity probe on %s', async action => {
  const first = await startOld(); crash(first)
  const entered = deferred(), release = deferred<Response>()
  vi.mocked(fetch).mockImplementationOnce(() => { entered.resolve(); return release.promise })
  const failure = new Error('Preparation failed')
  const outcome = manager.start(async () => { throw failure }).then(() => undefined, error => error)
  await entered.promise
  let completed: Promise<unknown>
  if (action === 'stop') completed = manager.stop()
  else {
    const exited = deferred()
    controls.exit.mockImplementation(() => exited.resolve())
    controls.quit!({ preventDefault: vi.fn() })
    completed = exited.promise
  }
  release.resolve(new Response('', { status: 503 }))
  const error = await outcome
  expect(error).toBeInstanceOf(AggregateError)
  expect(error.errors[0]).toBe(failure)
  expect(error.errors[1].message).toContain('superseded')
  await completed
  await vi.advanceTimersByTimeAsync(60_000)
  expect(spawned).toHaveLength(1)
  expect(manager.status().state).toBe('stopped')
  expect(vi.getTimerCount()).toBe(0)
})

it('does not stop or report an owned recovery when an external daemon takes the old port', async () => {
  const first = await startOld(); crash(first)
  listening = true
  const failure = new Error('Preparation failed')
  const error = await manager.start(async () => { throw failure }).then(() => undefined, error => error)
  expect(error).toBeInstanceOf(AggregateError)
  expect(error.errors[0]).toBe(failure)
  expect(error.errors[1].message).toContain('does not own')
  expect(spawned).toHaveLength(1)
  expect(first.child.kill).not.toHaveBeenCalled()
  expect(manager.status()).toEqual({ state: 'external', port: first.port })
  expect(await manager.stop()).toEqual({ state: 'external', port: first.port })
})

it('refuses an occupied previous port instead of switching origin or adopting the wrong daemon', async () => {
  const first = await startOld()
  controls.freeFrom = 9119
  const replacing = nextSpawn()
  const outcome = manager.start(async () => ({ executable: replacement, version: '2.0.0' }))
    .then(() => undefined, error => error)
  const launch = await replacing
  // A different home's listener cannot authenticate this replacement.
  identity = 'another-home'; listening = true
  launch.child.emit('exit', 1, null)
  const restoring = nextSpawn()
  const result = await Promise.race([restoring, outcome])
  expect(result).toHaveProperty('port')
  const retry = result as Launch
  retry.child.emit('exit', 1, null)
  const error = await outcome
  expect(error).toBeInstanceOf(AggregateError)
  expect(manager.status().state).not.toBe('running')
  expect(manager.status().state).not.toBe('external')
  expect(spawned.every(item => item.port === first.port)).toBe(true)
  expect(controls.attempts).toEqual([9119, 9120])
})
