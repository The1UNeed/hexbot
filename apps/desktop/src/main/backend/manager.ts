import { EventEmitter } from 'node:events'
import { createWriteStream, existsSync, renameSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import { join, delimiter } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { app } from 'electron'

import { activeSourceDir, binDir, hexbotExecutable, hexbotHome, venvDir } from './paths'

export type DaemonState = 'stopped' | 'starting' | 'running' | 'crashed'
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
// A newer client asked the daemon to update, and the daemon (hexbot/update.py)
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

function rotateLog(path: string): void {
  try {
    if (existsSync(path) && statSync(path).size >= 5 * 1024 * 1024) renameSync(path, `${path}.1`)
  } catch {
    /* logging must not stop the daemon */
  }
}

export class DaemonManager extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private current: DaemonStatus = { state: 'stopped' }
  private intentionalStop = false
  private failures: number[] = []
  private restartTimer?: NodeJS.Timeout
  private quitting = false

  constructor(
    private readonly configuredPort?: number,
    private readonly serviceInstalled: () => Promise<boolean> = async () => false
  ) {
    super()
    app.on('before-quit', event => {
      if (this.quitting || !this.child) return
      event.preventDefault()
      this.quitting = true
      void this.stopForQuit().finally(() => app.exit(0))
    })
  }

  status(): DaemonStatus {
    return { ...this.current }
  }
  private setStatus(status: DaemonStatus): void {
    this.current = status
    this.emit('status', this.status())
  }

  async start(): Promise<DaemonStatus> {
    if (this.current.state === 'starting' || this.current.state === 'running') return this.status()
    this.intentionalStop = false
    const port = this.configuredPort ?? (await findFreePort())
    await this.spawnDaemon(port)
    return this.status()
  }

  private async spawnDaemon(port: number): Promise<void> {
    await mkdir(join(hexbotHome(), 'logs'), { recursive: true })
    const logPath = join(hexbotHome(), 'logs', 'daemon.log')
    rotateLog(logPath)
    const log = createWriteStream(logPath, { flags: 'a' })
    this.setStatus({ state: 'starting', port })
    const child = spawn(hexbotExecutable(), ['serve', '--port', String(port)], {
      cwd: activeSourceDir(),
      env: {
        ...process.env,
        HEXBOT_HOME: hexbotHome(),
        // Tells the daemon it may ask this app to update it (hexbot/update.py).
        HEXBOT_SUPERVISOR: 'desktop',
        // Runs the Hex Connect sidecar with this app's Electron as Node (hexbot/connect.py).
        HEXBOT_NODE: process.env.APPIMAGE ?? process.execPath,
        PATH: [binDir(), join(venvDir(), 'bin'), process.env.PATH ?? ''].join(delimiter)
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

  async stop(): Promise<DaemonStatus> {
    this.intentionalStop = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const child = this.child
    if (!child) {
      this.setStatus({ state: 'stopped' })
      return this.status()
    }
    await new Promise<void>(resolve => {
      const force = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 5_000)
      child.once('exit', () => {
        clearTimeout(force)
        resolve()
      })
      child.kill('SIGTERM')
    })
    this.setStatus({ state: 'stopped' })
    return this.status()
  }

  private async stopForQuit(): Promise<void> {
    if (!(await this.serviceInstalled())) await this.stop()
  }
}
