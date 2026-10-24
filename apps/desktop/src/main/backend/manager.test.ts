import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import net from 'node:net'
import http from 'node:http'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DaemonManager,
  backoffSchedule,
  findFreePort,
  parseReadyLine,
  parseUpdateRequestLine,
  runningDaemonPort
} from './manager'

const spawnDaemon = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnDaemon }))
vi.mock('electron', () => ({ app: { on: () => undefined, isPackaged: true } }))
beforeEach(() => spawnDaemon.mockReset())

describe('a daemon that already owns the home', () => {
  it('is used instead of starting a second daemon, and only while it is running', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hexbot-manager-'))
    const oldHome = process.env.HEXBOT_HOME
    process.env.HEXBOT_HOME = home
    let identity: unknown = { install_id: 'this-home', pid: process.pid }
    const server = http.createServer(async (request, response) => {
      expect(request.url).toBe('/api/daemon/identity')
      await writeFile(join(home, 'install_id'), 'this-home')
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(identity))
    })
    try {
      const port = await new Promise<number>(resolve =>
        server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
      )
      await writeFile(join(home, 'install_id'), 'this-home')
      await writeFile(join(home, 'serve-state.json'), JSON.stringify({ host: '127.0.0.1', port }))
      expect(await runningDaemonPort(home)).toBeUndefined()
      await writeFile(join(home, 'native-daemon.lock'), String(process.pid))
      identity = { install_id: 'another-home', pid: process.pid }
      expect(await runningDaemonPort(home)).toBeUndefined()
      identity = { install_id: 'this-home', pid: process.pid + 1 }
      expect(await runningDaemonPort(home)).toBeUndefined()
      identity = { install_id: 'this-home', pid: process.pid }
      await rm(join(home, 'install_id'))
      expect(await runningDaemonPort(home)).toBe(port)
      // The packaged launcher does not exist here, so a spawn would crash.
      const manager = new DaemonManager()
      expect(await manager.start()).toEqual({ state: 'external', port })
      expect(await manager.start()).toEqual({ state: 'external', port })
      expect(await manager.stop()).toEqual({ state: 'external', port })
      const prepare = vi.fn(async () => ({ executable: join(home, 'selected'), version: '1.0.0' }))
      expect(await manager.start(prepare, 'attach-or-start')).toEqual({ state: 'external', port })
      expect(prepare).toHaveBeenCalledOnce()
      expect(port).not.toBe(9119)
      expect(spawnDaemon).not.toHaveBeenCalled()
      await expect(
        manager.start(async () => ({ executable: join(home, 'selected'), version: '1.0.0' }))
      ).rejects.toThrow('does not own')
      await expect(manager.uninstallService(async () => { throw new Error('Foreign task refused removal') })).rejects.toThrow('Foreign task refused removal')
      expect(manager.status()).toEqual({ state: 'external', port })
      await expect(manager.installService(async () => { throw new Error('Foreign task refused') })).rejects.toThrow('Foreign task refused')
      expect(manager.status()).toEqual({ state: 'external', port })
      expect(spawnDaemon).not.toHaveBeenCalled()
      await writeFile(join(home, 'native-daemon.lock'), '2147483647')
      expect(await runningDaemonPort(home)).toBeUndefined()
      await writeFile(join(home, 'native-daemon.lock'), String(process.pid))
      await new Promise<void>(resolve => server.close(() => resolve()))
      expect(await runningDaemonPort(home)).toBeUndefined()
    } finally {
      server.close()
      if (oldHome === undefined) delete process.env.HEXBOT_HOME
      else process.env.HEXBOT_HOME = oldHome
      await rm(home, { recursive: true, force: true })
    }
  })
})

it('cancels a prepared start before it can spawn when Stop is requested', async () => {
  const manager = new DaemonManager()
  let release: () => void = () => undefined
  let entered: () => void = () => undefined
  const prepared = new Promise<void>(resolve => {
    release = resolve
  })
  const preparing = new Promise<void>(resolve => {
    entered = resolve
  })
  const start = manager.start(async () => {
    entered()
    await prepared
    return { executable: '/unused', version: '1.0.0' }
  })
  const failed = expect(start).rejects.toThrow('superseded')
  await preparing
  const stopping = manager.stop()
  release()
  await failed
  expect(await stopping).toEqual({ state: 'stopped' })
})

it('does not stop a healthy owned daemon when preparation rejects', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexbot-manager-prepare-'))
  const previous = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: process.pid,
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 0, null))
      return true
    })
  })
  spawnDaemon.mockReturnValueOnce(child)
  const manager = new DaemonManager(9120)
  try {
    await manager.start()
    child.stdout.write('HERMES_BACKEND_READY port=9120\n')
    await expect(
      manager.start(async () => {
        throw new Error('Damaged runtime identity')
      })
    ).rejects.toThrow('Damaged runtime identity')
    expect(manager.status().state).toBe('running')
    expect(child.kill).not.toHaveBeenCalled()
  } finally {
    await manager.stop()
    if (previous === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

it('runs the newer preparation after it supersedes an older pending start', async () => {
  const manager = new DaemonManager()
  let release: () => void = () => undefined
  let entered: () => void = () => undefined
  const pending = new Promise<void>(resolve => {
    release = resolve
  })
  const preparing = new Promise<void>(resolve => {
    entered = resolve
  })
  const first = manager.start(async () => {
    entered()
    await pending
    return { executable: '/unused', version: '1.0.0' }
  })
  const firstFailed = expect(first).rejects.toThrow('superseded')
  await preparing
  const prepare = vi.fn(async () => {
    throw new Error('Second validation failed')
  })
  const second = manager.start(prepare)
  const secondFailed = expect(second).rejects.toThrow('Second validation failed')
  release()
  await firstFailed
  await secondFailed
  expect(prepare).toHaveBeenCalledTimes(1)
})

it('waits for a prepared daemon from stopped state and bounds missing readiness', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexbot-manager-ready-'))
  const previous = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  const executable = join(home, 'selected')
  await writeFile(executable, 'runtime')
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: process.pid,
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 0, null))
      return true
    })
  })
  spawnDaemon.mockReturnValueOnce(child)
  const manager = new DaemonManager(9120)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const waiting = new Promise<void>(resolve =>
      manager.on('newListener', name => {
        if (name === 'status') resolve()
      })
    )
    const start = manager.start(async () => ({
      executable: await realpath(executable),
      version: '1.0.0'
    }))
    const failed = expect(start).rejects.toThrow('did not become ready')
    await waiting
    expect(manager.status().state).toBe('starting')
    await vi.advanceTimersByTimeAsync(30_000)
    await failed
  } finally {
    await manager.stop()
    vi.useRealTimers()
    if (previous === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

it('attaches to a service that takes the home lock before a restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexbot-manager-restart-'))
  const oldHome = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: process.pid,
    kill: vi.fn()
  })
  spawnDaemon.mockReturnValueOnce(child)
  const server = http.createServer((_request, response) => {
    response.end(JSON.stringify({ install_id: 'service-home', pid: process.pid }))
  })
  const manager = new DaemonManager(9120)
  try {
    await manager.start()
    expect(spawnDaemon).toHaveBeenCalledTimes(1)
    expect(spawnDaemon.mock.calls[0]![2].windowsHide).toBe(process.platform === 'win32')
    expect(spawnDaemon.mock.calls[0]![2].env.HEXBOT_HOME).toBe(home)
    const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
    await writeFile(join(home, 'install_id'), 'service-home')
    await writeFile(join(home, 'native-daemon.lock'), String(process.pid))
    await writeFile(join(home, 'serve-state.json'), JSON.stringify({ port }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const running = new Promise<void>(resolve =>
      manager.on('status', status => {
        if (status.state === 'external') resolve()
      })
    )
    child.emit('exit', 4208, null)
    await vi.advanceTimersByTimeAsync(backoffSchedule[0])
    await running
    vi.useRealTimers()
    expect(manager.status()).toEqual({ state: 'external', port })
    expect(spawnDaemon).toHaveBeenCalledTimes(1)
    expect(await manager.stop()).toEqual({ state: 'external', port })
  } finally {
    vi.useRealTimers()
    spawnDaemon.mockClear()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (oldHome === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

it('rejects a stale PID and an unrelated TCP listener', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexbot-manager-stale-'))
  const server = net.createServer(socket => socket.destroy())
  try {
    const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
    await writeFile(join(home, 'native-daemon.lock'), String(process.pid))
    await writeFile(join(home, 'install_id'), 'this-home')
    await writeFile(join(home, 'serve-state.json'), JSON.stringify({ port }))
    expect(await runningDaemonPort(home)).toBeUndefined()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  }
})

describe('daemon helpers', () => {
  it('parses only valid ready lines', () => {
    expect(parseReadyLine('HERMES_BACKEND_READY port=9120')).toBe(9120)
    expect(parseReadyLine('noise HERMES_BACKEND_READY port=70000')).toBeUndefined()
    expect(parseReadyLine('ready port=9120')).toBeUndefined()
  })
  it('parses the daemon update request line', () => {
    expect(parseUpdateRequestLine('HEXBOT_UPDATE_REQUESTED version=0.1.5-nightly.20260916.9')).toBe(
      '0.1.5-nightly.20260916.9'
    )
    expect(parseUpdateRequestLine('HEXBOT_UPDATE_REQUESTED version=../x')).toBeUndefined()
    expect(parseUpdateRequestLine('HERMES_BACKEND_READY port=9120')).toBeUndefined()
  })
  it('uses the specified restart backoff', () => {
    expect(backoffSchedule).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
  })
  it('walks ports until the mocked net server can listen', async () => {
    let attempts = 0
    const createServer = (() => {
      const server = new EventEmitter() as EventEmitter & {
        listen: (port: number, host: string, callback: () => void) => void
        close: (callback: () => void) => void
      }
      server.listen = (_port, _host, callback) => {
        attempts += 1
        if (attempts < 3) queueMicrotask(() => server.emit('error', new Error('busy')))
        else queueMicrotask(callback)
      }
      server.close = callback => callback()
      return server
    }) as never
    expect(await findFreePort(9119, createServer)).toBe(9121)
  })
})

import { describe as d2, expect as e2, it as i2 } from 'vitest'
import { parseReadyLine as p2 } from './manager'

d2('parseReadyLine dashboard mode', () => {
  i2('accepts HERMES_DASHBOARD_READY', () => {
    e2(p2('HERMES_DASHBOARD_READY port=9134')).toBe(9134)
  })
})

it('requests Windows cleanup through the owned pipe, without force termination', async () => {
  const { requestOwnedShutdown } = await import('./manager')
  const input = new PassThrough()
  let received = ''
  input.on('data', data => { received += data })
  const kill = vi.fn()
  requestOwnedShutdown({ stdin: input, kill }, 'win32')
  expect(received).toBe('HEXBOT_SHUTDOWN_V1\n')
  expect(input.writableEnded).toBe(true)
  expect(kill).not.toHaveBeenCalled()
  requestOwnedShutdown({ stdin: new PassThrough(), kill }, 'linux')
  expect(kill).toHaveBeenCalledWith('SIGTERM')
})

for (const newer of ['none', 'start', 'stop'] as const) for (const fails of [false, true])
it(`hands off the owned daemon before service install and retains the external owner, newer=${newer}, failure=${fails}`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexbot-manager-handoff-'))
  const previous = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: process.pid,
    kill: vi.fn(() => { child.emit('exit', 0, null); return true })
  })
  child.stdin.on('finish', () => child.emit('exit', 0, null))
  spawnDaemon.mockClear()
  spawnDaemon.mockReturnValueOnce(child)
  const server = http.createServer((_request, response) => response.end(JSON.stringify({ install_id: 'handoff', pid: process.pid })))
  const manager = new DaemonManager(9120)
  let newerIntent: Promise<unknown> | undefined
  const failure = new Error('Verified task reported failure after startup')
  try {
    await manager.start()
    child.stdout.emit('data', Buffer.from('HERMES_BACKEND_READY port=9120\n'))
    expect(manager.status().state).toBe('running')
    const installing = manager.installService(async () => {
      expect(manager.status().state, 'Task must not start against the app-owned lock').toBe('stopped')
      if (newer === 'start') newerIntent = manager.start()
      if (newer === 'stop') newerIntent = manager.stop()
      const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
      await writeFile(join(home, 'install_id'), 'handoff')
      await writeFile(join(home, 'native-daemon.lock'), String(process.pid))
      await writeFile(join(home, 'serve-state.json'), JSON.stringify({ port }))
      if (fails) throw failure
    })
    if (fails) await expect(installing).rejects.toBe(failure)
    else if (newer !== 'none') await expect(installing).rejects.toThrow('superseded')
    else await installing
    expect(manager.status().state).toBe('external')
    if (newerIntent) expect(await newerIntent).toMatchObject({ state: 'external' })
    expect(await runningDaemonPort(home)).toBe(manager.status().port)
    expect(child.kill.mock.calls.length + Number(child.stdin.writableEnded)).toBe(1)
    expect((await manager.stop()).state).toBe('external')
    expect(spawnDaemon).toHaveBeenCalledTimes(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (previous === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

// Service recovery must satisfy the same authenticated readiness as replacement.
// These are real POSIX HTTP/home records, not a mocked Windows observer.
async function ownedReadiness(home: string) {
  let active = false
  const server = http.createServer((_request, response) => {
    response.statusCode = active ? 200 : 503
    response.end(JSON.stringify({ install_id: 'owned-service-test', pid: process.pid }))
  })
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
  const executable = join(home, 'runtime/native-executable')
  await mkdir(join(home, 'runtime'), { recursive: true })
  await writeFile(executable, 'owned test executable')
  let ready = Promise.resolve()
  return {
    port,
    get ready() { return ready },
    publish(child: EventEmitter & { stdout: PassThrough }) {
      ready = (async () => {
        child.once('exit', () => { active = false })
        await writeFile(join(home, 'install_id'), 'owned-service-test')
        await writeFile(join(home, 'native-daemon.lock'), String(process.pid))
        await writeFile(join(home, 'serve-state.json'), JSON.stringify({ port }))
        await writeFile(join(home, 'runtime/native-running.json'), JSON.stringify({ pid: process.pid, executable: await realpath(executable) }))
        active = true
        child.stdout.emit('data', Buffer.from(`HERMES_BACKEND_READY port=${port}\n`))
      })()
    },
    async close() {
      await ready
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}

it('restores an owned daemon when service installation fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexbot-service-rollback-'))
  const previous = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  const children = [0, 1].map(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: process.pid,
      kill: vi.fn(() => { child.emit('exit', 0, null); return true })
    })
    child.stdin.on('finish', () => child.emit('exit', 0, null))
    return child
  })
  const owned = await ownedReadiness(home)
  spawnDaemon.mockClear()
  spawnDaemon.mockReturnValueOnce(children[0])
  spawnDaemon.mockImplementationOnce(() => {
    owned.publish(children[1]!)
    return children[1]
  })
  const manager = new DaemonManager(9120)
  try {
    await manager.start()
    await expect(manager.installService(async () => {
      expect(manager.status().state).toBe('stopped')
      throw new Error('Task registration refused')
    })).rejects.toThrow('Task registration refused')
    expect(spawnDaemon).toHaveBeenCalledTimes(2)
    expect(manager.status().state).toBe('running')
  } finally {
    await manager.stop()
    await owned.close()
    if (previous === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

for (const superseded of [false, true]) for (const fails of [false, true])
it(`service removal stops and restores only the app-owned child, failure=${fails}, superseded=${superseded}`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexbot-service-remove-'))
  const previous = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  const children = [0, 1].map(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: process.pid,
      kill: vi.fn(() => { child.emit('exit', 0, null); return true })
    })
    child.stdin.on('finish', () => child.emit('exit', 0, null))
    return child
  })
  const owned = await ownedReadiness(home)
  spawnDaemon.mockClear()
  spawnDaemon.mockReturnValueOnce(children[0])
  spawnDaemon.mockImplementationOnce(() => {
    owned.publish(children[1]!)
    return children[1]
  })
  const manager = new DaemonManager(9120)
  const failure = new Error('Foreign task refused removal')
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  let entered!: () => void
  const removing = new Promise<void>(resolve => { entered = resolve })
  try {
    await manager.start()
    children[0]!.stdout.emit('data', Buffer.from('HERMES_BACKEND_READY port=9120\n'))
    const result = manager.uninstallService(async () => {
      expect(manager.status().state).toBe('stopped')
      entered()
      await gate
      if (fails) throw failure
    })
    const checked = fails || superseded ? expect(result).rejects.toThrow(fails ? 'Foreign task refused removal' : 'superseded') : result
    await removing
    const nextStart = superseded ? manager.start() : undefined
    expect(spawnDaemon).toHaveBeenCalledTimes(1)
    finish()
    await checked
    if (fails) await expect(result).rejects.toBe(failure)
    await nextStart
    await owned.ready
    expect(children[0]!.kill.mock.calls.length + Number(children[0]!.stdin.writableEnded)).toBe(1)
    expect(spawnDaemon).toHaveBeenCalledTimes(2)
    expect(manager.status().state).toBe('running')
  } finally {
    finish()
    await manager.stop()
    await owned.close()
    if (previous === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

it('serializes runtime preparation and owned-task reconciliation before attaching to the new service', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexbot-reconcile-'))
  const previous = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  const runtime = join(home, 'runtime')
  const selected = join(runtime, 'native-executable')
  let pid = process.ppid
  const server = http.createServer((_request, response) => response.end(JSON.stringify({ install_id: 'reconcile', pid })))
  const calls: string[] = []
  let prepared!: () => void
  const entered = new Promise<void>(resolve => { prepared = resolve })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const manager = new DaemonManager(9120, undefined, async () => {
    calls.push('restart-verified-task')
    pid = process.pid
    await writeFile(join(home, 'native-daemon.lock'), String(pid))
    await writeFile(join(runtime, 'native-running.json'), JSON.stringify({ pid, executable: selected }))
    return process.ppid
  })
  spawnDaemon.mockClear()
  try {
    await mkdir(runtime)
    await writeFile(selected, 'selected runtime')
    const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
    await writeFile(join(home, 'install_id'), 'reconcile')
    await writeFile(join(home, 'native-daemon.lock'), String(pid))
    await writeFile(join(home, 'serve-state.json'), JSON.stringify({ port }))
    const start = manager.start(async () => {
      calls.push('prepare'); prepared(); await gate
      calls.push('prepared'); return { executable: selected, version: '1.0.0' }
    }, 'attach-or-start')
    await entered
    expect(calls).toEqual(['prepare'])
    release()
    expect((await start).state).toBe('external')
    expect(calls).toEqual(['prepare', 'prepared', 'restart-verified-task'])
    const { runningDaemon } = await import('./manager')
    expect(await runningDaemon()).toEqual({ pid: process.pid, port, executable: await realpath(selected) })
    expect((await manager.stop()).state).toBe('external')
    expect(spawnDaemon).not.toHaveBeenCalled()
  } finally {
    release()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (previous === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

for (const duringOperation of [false, true])
it(`cancels a prepared external start without controlling its daemon, task already entered=${duringOperation}`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexbot-external-cancel-'))
  const previous = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  const runtime = join(home, 'runtime')
  const selected = join(runtime, 'native-executable')
  let pid = process.ppid
  const server = http.createServer((_request, response) => response.end(JSON.stringify({ install_id: 'cancel-external', pid })))
  let prepared!: () => void, taskEntered!: () => void, releasePrepare!: () => void, releaseTask!: () => void
  const preparing = new Promise<void>(resolve => { prepared = resolve })
  const taskStarted = new Promise<void>(resolve => { taskEntered = resolve })
  const prepareGate = new Promise<void>(resolve => { releasePrepare = resolve })
  const taskGate = new Promise<void>(resolve => { releaseTask = resolve })
  const reconcile = vi.fn(async () => {
    taskEntered()
    await taskGate
    pid = process.pid
    await writeFile(join(home, 'native-daemon.lock'), String(pid))
    await writeFile(join(runtime, 'native-running.json'), JSON.stringify({ pid, executable: selected }))
    return process.ppid
  })
  const manager = new DaemonManager(9120, undefined, reconcile)
  const killOwned = vi.spyOn(manager as unknown as { stopOwned(): Promise<unknown> }, 'stopOwned')
  spawnDaemon.mockClear()
  try {
    await mkdir(runtime)
    await writeFile(selected, 'selected runtime')
    const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
    await writeFile(join(home, 'install_id'), 'cancel-external')
    await writeFile(join(home, 'native-daemon.lock'), String(pid))
    await writeFile(join(home, 'serve-state.json'), JSON.stringify({ port }))
    await writeFile(join(runtime, 'native-running.json'), JSON.stringify({ pid, executable: selected }))
    expect(await manager.start()).toEqual({ state: 'external', port })
    const start = manager.start(async () => {
      prepared(); await prepareGate
      return { executable: selected, version: '1.0.0' }
    }, 'attach-or-start')
    const failed = expect(start).rejects.toThrow('superseded')
    await preparing
    if (duringOperation) { releasePrepare(); await taskStarted }
    const stop = manager.stop()
    releasePrepare()
    releaseTask()
    await failed
    expect(await stop).toEqual({ state: 'external', port })
    expect(reconcile).toHaveBeenCalledTimes(duringOperation ? 1 : 0)
    const { runningDaemon } = await import('./manager')
    expect(await runningDaemon()).toEqual({ pid: duringOperation ? process.pid : process.ppid, port, executable: await realpath(selected) })
    expect(spawnDaemon).not.toHaveBeenCalled()
    // Stop may enter the owned-stop routine, but there is no owned child to kill.
    expect(killOwned).toHaveBeenCalledOnce()
  } finally {
    releasePrepare(); releaseTask(); killOwned.mockRestore()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (previous === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

for (const installed of [false, true]) for (const fails of [false, true])
it(`revokes a backoff retry before service ${installed ? 'install' : 'remove'}, failure=${fails}`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexbot-backoff-service-'))
  const previous = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  const children = [0, 1, 2].map(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: process.pid,
      kill: vi.fn(() => { child.emit('exit', 0, null); return true }) })
    child.stdin.on('finish', () => child.emit('exit', 0, null))
    return child
  })
  const owned = await ownedReadiness(home)
  spawnDaemon.mockReset()
  for (const child of children) spawnDaemon.mockImplementationOnce(() => {
    owned.publish(child)
    return child
  })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const operationEntered = new Promise<void>(resolve => { entered = resolve })
  const server = http.createServer((_request, response) => response.end(JSON.stringify({ install_id: 'retry-home', pid: process.pid })))
  const manager = new DaemonManager(9120)
  try {
    await manager.start()
    await owned.ready
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const timers = vi.spyOn(globalThis, 'setTimeout')
    children[0]!.emit('exit', 1, null)
    const queuedRetry = timers.mock.calls.find(call => call[1] === backoffSchedule[0])![0] as () => void
    timers.mockRestore()
    expect(manager.status().state).toBe('starting')
    const operation = async () => {
      entered()
      await gate
      if (fails) throw new Error('Verified task operation refused')
      if (installed) {
        const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
        await writeFile(join(home, 'native-daemon.lock'), String(process.pid))
        await writeFile(join(home, 'install_id'), 'retry-home')
        await writeFile(join(home, 'serve-state.json'), JSON.stringify({ port }))
      }
    }
    const result = installed ? manager.installService(operation) : manager.uninstallService(operation)
    const checked = fails ? expect(result).rejects.toThrow('Verified task operation refused') : result
    await operationEntered
    // A timer callback can already be dequeued when clearTimeout runs.
    queuedRetry()
    await vi.advanceTimersByTimeAsync(backoffSchedule[0])
    expect(spawnDaemon, 'The old retry must not spawn during service ownership changes').toHaveBeenCalledTimes(1)
    release()
    await checked
    expect(spawnDaemon).toHaveBeenCalledTimes(installed && !fails ? 1 : 2)
    expect(manager.status().state).toBe(installed && !fails ? 'external' : 'running')
    const current = manager.status()
    children[0]!.stdout.emit('data', Buffer.from('HERMES_BACKEND_READY port=65530\n'))
    children[0]!.emit('error', new Error('Late replaced-child error'))
    expect(manager.status()).toEqual(current)
    await vi.advanceTimersByTimeAsync(backoffSchedule.at(-1)!)
    expect(spawnDaemon).toHaveBeenCalledTimes(installed && !fails ? 1 : 2)
  } finally {
    release()
    vi.useRealTimers()
    await manager.stop()
    await owned.close()
    spawnDaemon.mockReset()
    server.closeAllConnections()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    if (previous === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

it('Windows quit hands owned intent to a verified installed service after child completion', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexbot-quit-handoff-'))
  const previous = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: process.pid,
    kill: vi.fn()
  })
  let requested!: () => void
  const shutdown = new Promise<void>(resolve => { requested = resolve })
  child.stdin.on('finish', requested)
  child.kill.mockImplementation(() => { requested(); return true })
  spawnDaemon.mockClear()
  spawnDaemon.mockReturnValueOnce(child)
  const calls: string[] = []
  const manager = new DaemonManager(9120, undefined, undefined, async stop => {
    calls.push('verified-task')
    await stop()
    calls.push('child-exited')
    // A concurrently disabled task must remain disabled after the recheck.
    return false
  })
  try {
    await manager.start()
    child.stdout.emit('data', Buffer.from('HERMES_BACKEND_READY port=9120\n'))
    const quit = (manager as unknown as { stopForQuit(platform: NodeJS.Platform): Promise<void> }).stopForQuit('win32')
    await shutdown
    expect(calls).toEqual(['verified-task'])
    child.emit('exit', 0, null)
    await quit
    expect(calls).toEqual(['verified-task', 'child-exited'])
    expect(manager.status().state).toBe('stopped')
    await expect(manager.start()).rejects.toThrow('superseded')
    expect(spawnDaemon).toHaveBeenCalledTimes(1)
  } finally {
    if (previous === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

for (const mode of ['foreign', 'failed-start', 'disable-race'] as const) it(`Windows Quit keeps serialized owned authority: ${mode}`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexbot-quit-authority-'))
  const previous = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: process.pid,
    kill: vi.fn(() => { child.emit('exit', 0, null); return true })
  })
  child.stdin.on('finish', () => child.emit('exit', 0, null))
  spawnDaemon.mockClear()
  spawnDaemon.mockReturnValueOnce(child)
  const handoff = vi.fn(async (stop: () => Promise<void>) => {
    if (mode === 'failed-start') await stop()
    throw new Error(mode === 'foreign' ? 'Foreign task refused' : 'Task start failed')
  })
  const manager = new DaemonManager(9120, undefined, undefined, handoff)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const removing = new Promise<void>(resolve => { entered = resolve })
  try {
    await manager.start()
    let disabled: Promise<void> | undefined
    if (mode === 'disable-race') {
      disabled = manager.uninstallService(async () => { entered(); await gate })
      await removing
    }
    const quit = (manager as unknown as { stopForQuit(platform: NodeJS.Platform): Promise<void> }).stopForQuit('win32')
    if (mode === 'disable-race') {
      const cancelled = expect(disabled).rejects.toThrow('superseded')
      release()
      await cancelled
      await quit
      expect(handoff).not.toHaveBeenCalled()
    } else await expect(quit).rejects.toThrow(mode === 'foreign' ? 'Foreign task refused' : 'Task start failed')
    expect(manager.status().state).toBe('stopped')
    const later = vi.fn(async () => undefined)
    await expect(manager.installService(later)).rejects.toThrow('quitting')
    expect(later).not.toHaveBeenCalled()
    expect(spawnDaemon).toHaveBeenCalledTimes(1)
    expect(child.kill.mock.calls.length + Number(child.stdin.writableEnded)).toBe(1)
  } finally {
    release()
    if (previous === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
