import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import http from 'node:http'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DaemonManager, backoffSchedule, findFreePort, parseReadyLine, parseUpdateRequestLine, runningDaemonPort } from './manager'

const spawnDaemon = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnDaemon }))
vi.mock('electron', () => ({ app: { on: () => undefined, isPackaged: true } }))

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
      const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
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

it('attaches to a service that takes the home lock before a restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexbot-manager-restart-'))
  const oldHome = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), pid: process.pid,
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
    const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
    await writeFile(join(home, 'install_id'), 'service-home')
    await writeFile(join(home, 'native-daemon.lock'), String(process.pid))
    await writeFile(join(home, 'serve-state.json'), JSON.stringify({ port }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const running = new Promise<void>(resolve => manager.on('status', status => {
      if (status.state === 'external') resolve()
    }))
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
