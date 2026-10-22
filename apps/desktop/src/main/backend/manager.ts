import { EventEmitter } from 'node:events'
import { createWriteStream, existsSync, realpathSync, renameSync, statSync, watch } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import net from 'node:net'
import { join, delimiter } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { app } from 'electron'

import { binDir, daemonDirectory, hexbotExecutable, hexbotHome } from './paths'
import { nodePath } from './node-path'

// 'external': a service or another copy of the app runs the daemon for this
// home. The app uses it and cannot stop it.
export type DaemonState = 'stopped' | 'starting' | 'running' | 'external' | 'crashed'
export interface DaemonStatus {
  state: DaemonState
  port?: number
  pid?: number
  lastError?: string
}
export const backoffSchedule = [1_000, 2_000, 4_000, 8_000, 16_000] as const
export function parseReadyLine(line: string): number | undefined {
  const match = /(?:^|\s)HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)(?:\s|$)/.exec(line)
  if (!match) return undefined
  const port = Number(match[1])
  return port > 0 && port <= 65_535 ? port : undefined
}
// A newer client asked the daemon to update, and the daemon (services.rs)
// hands that to the app that runs it by printing this line.
export function parseUpdateRequestLine(line: string): string | undefined {
  const match = /(?:^|\s)HEXBOT_UPDATE_REQUESTED version=([0-9A-Za-z.-]{1,64})(?:\s|$)/.exec(line)
  return match?.[1]
}

export async function findFreePort(
  start = 9119,
  createServer: typeof net.createServer = net.createServer
): Promise<number> {
  for (let port = start; port <= 65_535; port += 1) {
    const free = await new Promise<boolean>(resolve => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error(`No free port at or above ${start}`)
}

// The PID in native-daemon.lock while that process is alive. A permission
// error counts as alive: uncertain ownership must never look like a stopped daemon.
export async function lockedDaemonPid(home = hexbotHome()): Promise<number | undefined> {
  const pid = Number(await readFile(join(home, 'native-daemon.lock'), 'utf8').catch(() => ''))
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined
  }
  return pid
}

// A service, or another copy of the app, may already run the daemon for this
// home; a second one would exit on the home lock. The running daemon holds that
// lock and records its port in serve-state.json.
export async function runningDaemonPort(home = hexbotHome()): Promise<number | undefined> {
  const pid = await lockedDaemonPid(home)
  if (!pid) return undefined
  try {
    const state = JSON.parse(await readFile(join(home, 'serve-state.json'), 'utf8')) as { port: number }
    const port = Number(state.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
    const response = await fetch(`http://127.0.0.1:${port}/api/daemon/identity`, {
      signal: AbortSignal.timeout(1_000), redirect: 'error'
    })
    if (!response.ok) return undefined
    const identity = await response.json() as { install_id?: string; pid?: number }
    // The daemon creates this ID on its first identity request.
    const installId = (await readFile(join(home, 'install_id'), 'utf8')).trim()
    if (!installId) return undefined
    return identity.install_id === installId && identity.pid === pid ? port : undefined
  } catch {
    return undefined
  }
}

function rotateLog(path: string): void {
  try {
    if (existsSync(path) && statSync(path).size >= 5 * 1024 * 1024) renameSync(path, `${path}.1`)
  } catch {
    /* logging must not stop the daemon */
  }
}

export function requestOwnedShutdown(child: Pick<ChildProcessWithoutNullStreams, 'stdin' | 'kill'>, platform = process.platform): void {
  if (platform === 'win32') {
    // EPIPE means the child is already exiting. The caller still waits for exit.
    child.stdin.once('error', () => undefined)
    child.stdin.end('HEXBOT_SHUTDOWN_V1\n')
  } else child.kill('SIGTERM')
}

export class DaemonManager extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private current: DaemonStatus = { state: 'stopped' }
  private intentionalStop = false
  private failures: number[] = []
  private restartTimer?: NodeJS.Timeout
  private quitting = false
  private transition: Promise<unknown> = Promise.resolve()
  private serviceInstalls = 0

  constructor(
    private readonly configuredPort?: number,
    private readonly serviceInstalled: () => Promise<boolean> = async () => false
  ) {
    super()
    app.on('before-quit', event => {
      if (this.quitting || (!this.child && !this.serviceInstalls)) return
      event.preventDefault()
      this.quitting = true
      void this.stopForQuit().finally(() => app.exit(0))
    })
  }

  status(): DaemonStatus {
    return { ...this.current }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation)
    this.transition = result.catch(() => undefined)
    return result
  }
  installService(install: () => Promise<void>): Promise<void> {
    this.serviceInstalls++
    return this.serialize(async () => {
      const owned = Boolean(this.child)
      if (owned) await this.stopOwned()
      try {
        await install()
        const port = await this.waitForService()
        this.failures = []
        this.setStatus({ state: 'external', port })
      } catch (error) {
        // A partial install may already have started the service. startOwned
        // verifies that owner first; it never starts a second daemon over it.
        if (owned) {
          try { await this.startOwned() }
          catch (restore) { throw new AggregateError([error, restore], 'Service install and daemon recovery failed') }
        }
        throw error
      }
    }).finally(() => { this.serviceInstalls-- })
  }
  private waitForService(): Promise<number> {
    return new Promise((resolve, reject) => {
      const directory = nodePath(realpathSync.native(hexbotHome()))
      const watcher = watch(directory, () => { void check() })
      const timer = setTimeout(() => finish(new Error('Installed service did not acquire this home and become ready')), 30_000)
      let settled = false
      const finish = (error?: Error, port?: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        watcher.close()
        if (error) reject(error)
        else resolve(port!)
      }
      const check = async (): Promise<void> => {
        const port = await runningDaemonPort()
        if (port) finish(undefined, port)
      }
      watcher.once('error', finish)
      void check()
    })
  }
  private setStatus(status: DaemonStatus): void {
    this.current = status
    this.emit('status', this.status())
  }

  start(): Promise<DaemonStatus> {
    return this.serialize(() => this.startOwned())
  }
  private async startOwned(): Promise<DaemonStatus> {
    if (this.current.state === 'starting' || this.current.state === 'running') return this.status()
    this.intentionalStop = false
    const running = await runningDaemonPort()
    if (running) {
      this.setStatus({ state: 'external', port: running })
      return this.status()
    }
    await this.spawnDaemon(this.configuredPort ?? (await findFreePort()))
    return this.status()
  }

  private async spawnDaemon(port: number): Promise<void> {
    const running = await runningDaemonPort()
    if (this.intentionalStop) return
    if (running) {
      this.failures = []
      this.setStatus({ state: 'external', port: running })
      return
    }
    await mkdir(join(hexbotHome(), 'logs'), { recursive: true })
    const logPath = join(hexbotHome(), 'logs', 'daemon.log')
    rotateLog(logPath)
    const log = createWriteStream(logPath, { flags: 'a' })
    this.setStatus({ state: 'starting', port })
    const child = spawn(hexbotExecutable(), ['serve', '--port', String(port)], {
      cwd: daemonDirectory(),
      windowsHide: process.platform === 'win32',
      env: {
        ...process.env,
        HEXBOT_HOME: hexbotHome(),
        // Tells the daemon it may ask this app to update it (services.rs).
        HEXBOT_SUPERVISOR: 'desktop',
        ...(process.platform === 'win32' ? { HEXBOT_DESKTOP_CONTROL: 'stdin-v1' } : {}),
        PATH: [binDir(), process.env.PATH ?? ''].join(delimiter)
      }
    })
    this.child = child
    const pending = new Map<NodeJS.ReadableStream, string>()
    const consume = (stream: NodeJS.ReadableStream, chunk: Buffer): void => {
      log.write(chunk)
      const lines = `${pending.get(stream) ?? ''}${chunk.toString()}`.split(/\r?\n/)
      pending.set(stream, lines.pop() ?? '')
      for (const line of lines) {
        const readyPort = parseReadyLine(line)
        if (readyPort) this.setStatus({ state: 'running', port: readyPort, pid: child.pid })
        const requested = parseUpdateRequestLine(line)
        if (requested) this.emit('update-requested', requested)
      }
    }
    child.stdout.on('data', chunk => consume(child.stdout, chunk))
    child.stderr.on('data', chunk => consume(child.stderr, chunk))
    child.once('error', error =>
      this.setStatus({ state: 'crashed', port, lastError: error.message })
    )
    child.once('exit', (code, signal) => {
      log.end()
      if (this.child === child) this.child = undefined
      if (this.intentionalStop) {
        this.setStatus({ state: 'stopped' })
        return
      }
      const now = Date.now()
      this.failures = this.failures.filter(time => now - time < 120_000)
      this.failures.push(now)
      const retry = this.failures.length - 1
      if (retry >= backoffSchedule.length) {
        this.setStatus({
          state: 'crashed',
          port,
          lastError: `Daemon exited (${code ?? signal ?? 'unknown'})`
        })
        return
      }
      this.setStatus({
        state: 'starting',
        port,
        lastError: `Daemon exited (${code ?? signal ?? 'unknown'}); restarting`
      })
      this.restartTimer = setTimeout(() => {
        void this.spawnDaemon(port)
      }, backoffSchedule[retry])
    })
  }

  stop(): Promise<DaemonStatus> {
    return this.serialize(() => this.stopOwned())
  }
  private async stopOwned(): Promise<DaemonStatus> {
    if (this.current.state === 'external') {
      const running = await runningDaemonPort()
      if (running) {
        this.setStatus({ state: 'external', port: running })
        return this.status()
      }
    }
    this.intentionalStop = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const child = this.child
    if (!child) {
      this.setStatus({ state: 'stopped' })
      return this.status()
    }
    await new Promise<void>((resolve, reject) => {
      // On Windows SIGTERM force-terminates a process. The inherited stdin
      // pipe belongs only to this child and is never a network stop endpoint.
      const deadline = setTimeout(() => reject(new Error('Owned daemon did not exit after shutdown')), 10_000)
      const force = setTimeout(() => { child.kill('SIGKILL') }, 5_000)
      child.once('exit', () => {
        clearTimeout(force)
        clearTimeout(deadline)
        resolve()
      })
      requestOwnedShutdown(child)
    })
    this.setStatus({ state: 'stopped' })
    return this.status()
  }

  private async stopForQuit(): Promise<void> {
    await this.transition
    if (process.platform === 'win32' || !(await this.serviceInstalled())) await this.stop()
  }
}
