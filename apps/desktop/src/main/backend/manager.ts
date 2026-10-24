import { EventEmitter } from 'node:events'
import { createWriteStream, existsSync, renameSync, statSync, watch } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import net from 'node:net'
import { join, delimiter, dirname, basename } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { app } from 'electron'

import { binDir, canonicalRuntimePath, daemonDirectory, hexbotExecutable, hexbotHome } from './paths'

// 'external': a service or another copy of the app runs the daemon for this
// home. The app uses it and cannot stop it.
export type DaemonState = 'stopped' | 'starting' | 'running' | 'external' | 'crashed'
export interface DaemonStatus {
  state: DaemonState
  port?: number
  pid?: number
  lastError?: string
}
export interface RuntimeActivation {
  executable: string
  version: string
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
export async function runningDaemonPort(home = hexbotHome(), signal?: AbortSignal): Promise<number | undefined> {
  const pid = await lockedDaemonPid(home)
  if (!pid) return undefined
  try {
    const state = JSON.parse(await readFile(join(home, 'serve-state.json'), 'utf8')) as {
      port: number
    }
    const port = Number(state.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
    const response = await fetch(`http://127.0.0.1:${port}/api/daemon/identity`, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1_000)]) : AbortSignal.timeout(1_000),
      redirect: 'error'
    })
    if (!response.ok) return undefined
    const identity = (await response.json()) as { install_id?: string; pid?: number }
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
  private childExecutable?: string
  private current: DaemonStatus = { state: 'stopped' }
  private intentionalStop = false
  private failures: number[] = []
  private restartTimer?: NodeJS.Timeout
  private retryEpoch = 0
  private requestEpoch = 0
  private ownedIntent = false
  private quitting = false
  private transition: Promise<unknown> = Promise.resolve()
  private pendingTransitions = 0

  constructor(
    private readonly configuredPort?: number,
    private readonly serviceInstalled: () => Promise<boolean> = async () => false
  ) {
    super()
    app.on('before-quit', event => {
      if (this.quitting || (!this.ownedIntent && !this.child && !this.pendingTransitions)) return
      event.preventDefault()
      this.quitting = true
      this.cancelTransition()
      void this.transition.then(() => this.stopForQuit()).then(
        () => app.exit(0),
        error => {
          console.error('Daemon shutdown failed:', error)
          app.exit(1)
        }
      )
    })
  }

  installService(operation: () => Promise<void>): Promise<void> {
    return this.changeService(operation, true)
  }
  uninstallService(operation: () => Promise<void>): Promise<void> {
    return this.changeService(operation, false)
  }
  private changeService(operation: () => Promise<void>, installed: boolean): Promise<void> {
    this.cancelTransition()
    const epoch = this.requestEpoch
    return this.serialize(async () => {
      if (this.quitting || epoch !== this.requestEpoch)
        throw new Error('Service change was superseded')
      const owned = this.ownedIntent || Boolean(this.child)
      if (owned) await this.stopOwned()
      try {
        await operation()
        if (this.quitting || epoch !== this.requestEpoch)
          throw new Error('Service change was superseded')
        if (installed) this.setStatus({ state: 'external', port: await this.waitForService() })
        else {
          this.setStatus({ state: 'stopped' })
          await this.startOwned()
        }
      } catch (error) {
        if (owned && epoch === this.requestEpoch && !this.quitting) {
          try {
            await this.startOwned()
            await this.waitForOwned()
          } catch (restore) {
            throw new AggregateError([error, restore], 'Service change and daemon recovery failed')
          }
        }
        throw error
      }
    })
  }
  private waitForService(): Promise<number> {
    return new Promise((resolve, reject) => {
      let settled = false, checking = false, changed = false
      let retry: NodeJS.Timeout | undefined
      const probe = new AbortController()
      const watchers: ReturnType<typeof watch>[] = []
      const cancelled = (): void => finish(new Error('Service change was superseded'))
      const watchError = (error: Error): void => finish(error)
      const finish = (error?: Error, port?: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(retry)
        probe.abort()
        this.off('transition-cancelled', cancelled)
        for (const watcher of watchers) {
          watcher.off('error', watchError)
          watcher.close()
        }
        if (error) reject(error)
        else resolve(port!)
      }
      // One total deadline, including all HTTP probes and filesystem wake-ups.
      const timer = setTimeout(
        () => finish(new Error('Installed service did not become ready')),
        30_000
      )
      const check = async (): Promise<void> => {
        changed = true
        if (checking || settled) return
        clearTimeout(retry)
        retry = undefined
        checking = true
        do {
          changed = false
          try {
            const port = await runningDaemonPort(hexbotHome(), probe.signal)
            if (port && !settled) finish(undefined, port)
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          }
        } while (changed && !settled)
        checking = false
        // HTTP can begin serving after the final filesystem publication.
        if (!settled) retry = setTimeout(() => { void check() }, 250)
      }
      this.on('transition-cancelled', cancelled)
      try {
        for (const directory of [hexbotHome(), join(hexbotHome(), 'runtime')]) {
          if (!existsSync(directory)) continue
          const watcher = watch(directory, () => { void check() })
          watchers.push(watcher)
          watcher.once('error', watchError)
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
        return
      }
      void check()
    })
  }
  status(): DaemonStatus {
    return { ...this.current }
  }
  private setStatus(status: DaemonStatus): void {
    this.current = status
    this.emit('status', this.status())
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingTransitions++
    const result = this.transition.then(operation).finally(() => {
      this.pendingTransitions--
    })
    this.transition = result.catch(() => undefined)
    return result
  }
  private revokeRetry(): void {
    this.retryEpoch++
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
  }
  private cancelTransition(): void {
    this.requestEpoch++
    this.revokeRetry()
    this.emit('transition-cancelled')
  }

  start(prepare?: () => Promise<RuntimeActivation | undefined>): Promise<DaemonStatus> {
    this.cancelTransition()
    const requestedEpoch = this.requestEpoch
    return this.serialize(async () => {
      const owned = this.ownedIntent || Boolean(this.child)
      let activation: RuntimeActivation | undefined
      let epoch = requestedEpoch
      try {
        if (this.quitting || epoch !== this.requestEpoch)
          throw new Error('Daemon start was superseded')
        activation = await prepare?.()
        if (prepare && !activation)
          throw new Error('Runtime preparation returned no verified selection')
        if (this.quitting || epoch !== this.requestEpoch)
          throw new Error('Daemon start was superseded')
        if (
          activation &&
          this.child &&
          canonicalRuntimePath(activation.executable) !== this.childExecutable
        ) {
          const stopping = this.stopOwned()
          await stopping
          if (epoch !== this.requestEpoch) throw new Error('Daemon start was superseded')
        }
        await this.startOwned(activation)
        if (activation) await this.waitForOwned(activation)
        return this.status()
      } catch (error) {
        const recover = epoch === this.requestEpoch
        if (recover) this.revokeRetry()
        if (recover && owned && activation && !this.child && !this.quitting) {
          try {
            await this.startOwned(activation)
            await this.waitForOwned(activation)
          } catch (restore) {
            throw new AggregateError(
              [error, restore],
              'Runtime activation and daemon recovery failed'
            )
          }
        }
        throw error
      }
    })
  }

  private async startOwned(activation?: RuntimeActivation, epoch = this.retryEpoch): Promise<void> {
    if (this.quitting) throw new Error('The app is quitting')
    if (this.child && (this.current.state === 'starting' || this.current.state === 'running'))
      return
    this.ownedIntent = true
    this.intentionalStop = false
    const running = await runningDaemonPort()
    if (running) {
      this.ownedIntent = false
      this.setStatus({ state: 'external', port: running })
      return
    }
    await this.spawnDaemon(this.configuredPort ?? (await findFreePort()), epoch, activation)
  }

  private waitForOwned(activation?: RuntimeActivation): Promise<void> {
    const child = this.child
    if (!child) return Promise.reject(new Error('The app does not own the replacement daemon'))
    const executable = activation?.executable ?? this.childExecutable
    return new Promise((resolve, reject) => {
      let checking = false,
        settled = false
      const done = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.off('status', changed)
        this.off('transition-cancelled', cancelled)
        if (error) reject(error)
        else resolve()
      }
      const changed = (): void => {
        if (
          this.child !== child ||
          this.current.state === 'crashed' ||
          this.current.state === 'stopped'
        ) {
          done(new Error(this.current.lastError ?? 'Replacement daemon exited before readiness'))
          return
        }
        if (this.current.state !== 'running' || checking) return
        checking = true
        void (async () => {
          const port = await runningDaemonPort()
          const record = JSON.parse(
            await readFile(join(hexbotHome(), 'runtime/native-running.json'), 'utf8')
          ) as { pid?: number; executable?: string }
          const actual = record.executable && canonicalRuntimePath(record.executable)
          const core =
            executable &&
            basename(executable) === 'hexbot' &&
            join(dirname(executable), 'hexbot-core')
          const matchesExecutable =
            actual === executable || (core && existsSync(core) && actual === canonicalRuntimePath(core))
          if (
            this.child !== child ||
            this.current.state !== 'running' ||
            !port ||
            port !== this.current.port ||
            record.pid !== child.pid ||
            !matchesExecutable ||
            this.childExecutable !== executable
          )
            throw new Error('Replacement daemon identity does not match the prepared runtime')
          done()
        })().catch(error => done(error instanceof Error ? error : new Error(String(error))))
      }
      const timer = setTimeout(
        () => done(new Error('Replacement daemon did not become ready')),
        30_000
      )
      const cancelled = (): void => done(new Error('Daemon start was superseded'))
      this.on('transition-cancelled', cancelled)
      this.on('status', changed)
      changed()
    })
  }

  private async spawnDaemon(
    port: number,
    epoch = this.retryEpoch,
    activation?: RuntimeActivation
  ): Promise<void> {
    const authorized = (): boolean =>
      epoch === this.retryEpoch &&
      this.ownedIntent &&
      !this.quitting &&
      !this.intentionalStop &&
      !this.child
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
    const executable = activation?.executable ?? hexbotExecutable()
    const canonical = existsSync(executable) ? canonicalRuntimePath(executable) : executable
    const child = spawn(executable, ['serve', '--port', String(port)], {
      cwd: daemonDirectory(),
      windowsHide: process.platform === 'win32',
      env: {
        ...process.env,
        HEXBOT_HOME: hexbotHome(),
        HEXBOT_SUPERVISOR: 'desktop',
        ...(process.platform === 'win32' ? { HEXBOT_DESKTOP_CONTROL: 'stdin-v1' } : {}),
        PATH: [binDir(), process.env.PATH ?? ''].join(delimiter)
      }
    })
    this.child = child
    this.childExecutable = canonical
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
      if (this.child === child) {
        if (!child.pid) {
          this.child = undefined
          this.childExecutable = undefined
          log.end()
        }
        this.setStatus({ state: 'crashed', port, lastError: error.message })
      }
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
      const retryEpoch = this.retryEpoch
      this.restartTimer = setTimeout(() => {
        void this.serialize(async () => {
          if (retryEpoch === this.retryEpoch) await this.spawnDaemon(port, retryEpoch, activation)
        }).catch(error => {
          if (retryEpoch === this.retryEpoch)
            this.setStatus({ state: 'crashed', port, lastError: String(error) })
        })
      }, backoffSchedule[retry])
    })
  }

  stop(): Promise<DaemonStatus> {
    this.cancelTransition()
    return this.serialize(() => this.stopOwned())
  }
  private async stopOwned(): Promise<DaemonStatus> {
    this.revokeRetry()
    this.ownedIntent = false
    if (this.current.state === 'external') return this.status()
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

  private async stopForQuit(): Promise<void> {
    if (process.platform === 'win32' || !(await this.serviceInstalled())) await this.stop()
  }

}
