import { EventEmitter } from 'node:events'
import { createWriteStream, existsSync, realpathSync, renameSync, statSync, watch } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import net from 'node:net'
import { join, delimiter } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { app } from 'electron'

import { binDir, daemonDirectory, hexbotExecutable, hexbotHome, canonicalRuntimePath } from './paths'
import { windowsDaemon } from './windows-readiness'
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
  if (process.platform === 'win32') return (await windowsDaemon(home))?.pid
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
  if (process.platform === 'win32') return (await windowsDaemon(home))?.port
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

export interface RuntimeActivation { executable: string }

// Readiness includes both the authenticated home identity and the selected
// immutable executable. A stale serve-state or old PID cannot satisfy restart.
export async function runningDaemon(home = hexbotHome()): Promise<{ pid: number; port: number; executable: string } | undefined> {
  if (process.platform === 'win32') return windowsDaemon(home)
  const port = await runningDaemonPort(home)
  if (!port) return undefined
  const record = JSON.parse(await readFile(join(home, 'runtime/native-running.json'), 'utf8')) as { pid?: number; executable?: string }
  if (!record.pid || record.pid !== await lockedDaemonPid(home) || !record.executable)
    throw new Error('Cannot verify the running service runtime')
  return { pid: record.pid, port, executable: canonicalRuntimePath(record.executable) }
}
export async function selectedDaemon(): Promise<{ pid: number; port: number } | undefined> {
  const ready = process.platform === 'win32' ? await runningDaemon() : await runningDaemon().catch(() => undefined)
  return ready && ready.executable === canonicalRuntimePath(hexbotExecutable()) ? ready : undefined
}

export class DaemonManager extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private childExecutable?: string
  private current: DaemonStatus = { state: 'stopped' }
  private intentionalStop = false
  private failures: number[] = []
  private restartTimer?: NodeJS.Timeout
  private retryEpoch = 0
  private ownedIntent = false
  private quitting = false
  private transition: Promise<unknown> = Promise.resolve()
  private pendingTransitions = 0

  constructor(
    private readonly configuredPort?: number,
    private readonly serviceInstalled: () => Promise<boolean> = async () => false,
    private readonly reconcileService: () => Promise<number | undefined> = async () => undefined,
    private readonly handoffService?: (stopOwned: () => Promise<void>) => Promise<boolean>
  ) {
    super()
    app.on('before-quit', event => {
      if (this.quitting || (!this.ownedIntent && !this.child && !this.pendingTransitions)) return
      event.preventDefault()
      this.quitting = true
      this.revokeRetry()
      void this.stopForQuit().then(() => app.exit(0), error => {
        console.error('Daemon quit handoff failed:', error)
        app.exit(1)
      })
    })
  }

  status(): DaemonStatus {
    return { ...this.current }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingTransitions++
    const result = this.transition.then(operation).finally(() => { this.pendingTransitions-- })
    this.transition = result.catch(() => undefined)
    return result
  }
  installService(install: () => Promise<void>): Promise<void> {
    return this.changeService(install, true)
  }
  uninstallService(uninstall: () => Promise<void>): Promise<void> {
    return this.changeService(uninstall, false)
  }
  private revokeRetry(): void {
    this.retryEpoch++
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
  }
  private changeService(operation: () => Promise<void>, installed: boolean): Promise<void> {
    if (this.quitting) return Promise.reject(new Error('The app is quitting'))
    // Revoke synchronously, before an already queued retry can enter the
    // transition queue. Intent survives the gap between a crash and its retry.
    const requestedOwned = this.ownedIntent || Boolean(this.child)
    this.revokeRetry()
    return this.serialize(async () => {
      this.revokeRetry()
      const owned = requestedOwned || this.ownedIntent || Boolean(this.child)
      if (owned) await this.stopOwned()
      try {
        await operation()
        if (installed) {
          const port = await this.waitForService()
          this.failures = []
          this.setStatus({ state: 'external', port })
        } else {
          // Only the verified task operation removes an external service.
          // startOwned checks for another live home owner before spawning.
          this.setStatus({ state: 'stopped' })
          await this.restoreOwned()
        }
      } catch (error) {
        // A partial install may already have started the service. startOwned
        // verifies that owner first; it never starts a second daemon over it.
        if (owned) {
          try { await this.restoreOwned() }
          catch (restore) { throw new AggregateError([error, restore], 'Service change and daemon recovery failed') }
        }
        throw error
      }
    })
  }
  private async restoreOwned(): Promise<void> {
    if (this.quitting) return
    await this.startOwned()
    if (this.current.state === 'running' || this.current.state === 'external') return
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error): void => {
        clearTimeout(timer)
        this.off('status', changed)
        if (error) reject(error)
        else resolve()
      }
      const changed = (status: DaemonStatus): void => {
        if (status.state === 'running' || status.state === 'external') done()
        else if (status.state === 'crashed' || status.state === 'stopped') done(new Error(status.lastError ?? 'Owned daemon recovery stopped'))
      }
      const timer = setTimeout(() => done(new Error('Owned daemon recovery did not become ready')), 30_000)
      this.on('status', changed)
      changed(this.current)
    })
  }
  private waitForService(previousPid?: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const directory = nodePath(realpathSync.native(hexbotHome()))
      const watchers = [watch(directory, () => { void check() })]
      if (existsSync(join(directory, 'runtime'))) watchers.push(watch(join(directory, 'runtime'), () => { void check() }))
      let lastError: unknown
      const timer = setTimeout(() => finish(new Error('Installed service did not acquire this home and become ready', { cause: lastError })), 30_000)
      let settled = false
      const finish = (error?: Error, port?: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        for (const watcher of watchers) watcher.close()
        if (error) reject(error)
        else resolve(port!)
      }
      let checking = false, changed = false
      const check = async (): Promise<void> => {
        changed = true
        if (checking || settled) return
        checking = true
        do {
          changed = false
          try {
            if (previousPid === undefined) {
              const port = await runningDaemonPort()
              if (port) finish(undefined, port)
            } else {
              const ready = await selectedDaemon()
              if (ready && ready.pid !== previousPid) finish(undefined, ready.port)
            }
          } catch (error) { lastError = error }
        } while (changed && !settled)
        checking = false
      }
      for (const watcher of watchers) watcher.once('error', finish)
      void check()
    })
  }
  private setStatus(status: DaemonStatus): void {
    this.current = status
    this.emit('status', this.status())
  }

  start(prepare?: () => Promise<RuntimeActivation | undefined>): Promise<DaemonStatus> {
    this.revokeRetry()
    return this.serialize(async () => {
      const owned = this.ownedIntent || Boolean(this.child)
      try {
        const activation = await prepare?.()
        if (activation && this.child && canonicalRuntimePath(activation.executable) !== this.childExecutable) await this.stopOwned()
        // Reconcile even after an interrupted prior activation. The callback
        // leaves missing/foreign/already-current tasks unchanged.
        if (activation && !this.child) {
          const previousPid = await this.reconcileService()
          if (previousPid !== undefined) {
            const port = await this.waitForService(previousPid ?? 0)
            this.setStatus({ state: 'external', port })
          }
        }
        return await this.startOwned()
      } catch (error) {
        if (owned && !this.child) {
          try { await this.restoreOwned() }
          catch (restore) { throw new AggregateError([error, restore], 'Runtime activation and daemon recovery failed') }
        }
        throw error
      }
    })
  }
  private async startOwned(): Promise<DaemonStatus> {
    if (this.quitting || (this.child && (this.current.state === 'starting' || this.current.state === 'running'))) return this.status()
    this.revokeRetry()
    this.ownedIntent = true
    this.intentionalStop = false
    const running = await runningDaemonPort()
    if (running) {
      this.ownedIntent = false
      this.setStatus({ state: 'external', port: running })
      return this.status()
    }
    await this.spawnDaemon(this.configuredPort ?? (await findFreePort()))
    return this.status()
  }

  private async spawnDaemon(port: number, epoch = this.retryEpoch): Promise<void> {
    const authorized = (): boolean => epoch === this.retryEpoch && this.ownedIntent && !this.quitting && !this.intentionalStop && !this.child
    if (!authorized()) return
    const running = await runningDaemonPort()
    if (!authorized()) return
    if (running) {
      this.ownedIntent = false
      this.failures = []
      this.setStatus({ state: 'external', port: running })
      return
    }
    await mkdir(join(hexbotHome(), 'logs'), { recursive: true })
    if (!authorized()) return
    const logPath = join(hexbotHome(), 'logs', 'daemon.log')
    rotateLog(logPath)
    const log = createWriteStream(logPath, { flags: 'a' })
    this.setStatus({ state: 'starting', port })
    const executable = hexbotExecutable()
    const child = spawn(executable, ['serve', '--port', String(port)], {
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
    this.childExecutable = existsSync(executable) ? canonicalRuntimePath(executable) : executable
    const pending = new Map<NodeJS.ReadableStream, string>()
    const consume = (stream: NodeJS.ReadableStream, chunk: Buffer): void => {
      if (this.child !== child) return
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
    child.once('error', error => {
      if (this.child === child) this.setStatus({ state: 'crashed', port, lastError: error.message })
    })
    child.once('exit', (code, signal) => {
      log.end()
      if (this.child !== child) return
      this.child = undefined
      this.childExecutable = undefined
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
      const epoch = this.retryEpoch
      this.restartTimer = setTimeout(() => {
        // The callback may already be queued when a service transition cancels
        // the timer. Both the queue and the async spawn retain this authority.
        void this.serialize(async () => {
          if (epoch === this.retryEpoch) await this.spawnDaemon(port, epoch)
        }).catch(error => {
          if (epoch === this.retryEpoch) this.setStatus({ state: 'crashed', port, lastError: String(error) })
        })
      }, backoffSchedule[retry])
    })
  }

  stop(): Promise<DaemonStatus> {
    this.revokeRetry()
    return this.serialize(() => this.stopOwned())
  }
  private async stopOwned(): Promise<DaemonStatus> {
    this.revokeRetry()
    this.ownedIntent = false
    if (this.current.state === 'external') {
      const running = await runningDaemonPort()
      if (running) {
        this.setStatus({ state: 'external', port: running })
        return this.status()
      }
    }
    this.intentionalStop = true
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

  private stopForQuit(platform = process.platform): Promise<void> {
    this.quitting = true
    this.revokeRetry()
    return this.serialize(async () => {
      if (platform !== 'win32') {
        if (!(await this.serviceInstalled())) await this.stopOwned()
        return
      }
      const owned = this.ownedIntent || Boolean(this.child)
      const previousPid = this.child?.pid
      try {
        if (owned && this.handoffService) {
          if (await this.handoffService(async () => { await this.stopOwned() })) {
            const port = await this.waitForService(previousPid ?? 0)
            this.setStatus({ state: 'external', port })
          }
        } else await this.stopOwned()
      } catch (error) {
        // A failed ownership query must not leave our child running on Quit.
        // Only the retained child is stopped; no external task is controlled.
        if (this.child) {
          try { await this.stopOwned() }
          catch (cleanup) { throw new AggregateError([error, cleanup], 'Quit handoff and owned daemon cleanup failed') }
        }
        throw error
      }
    })
  }
}
