import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { resolve } from 'node:path'

export const READY_PATTERN = /(?:^|\s)HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)(?:\s|$)/

export function parseReadyPort(line: string): number | undefined {
  const value = Number(READY_PATTERN.exec(line)?.[1])
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : undefined
}

export async function pickFreePort(
  createServer: typeof net.createServer = net.createServer
): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not determine the free port'))
        return
      }
      server.close(error => (error ? reject(error) : resolvePort(address.port)))
    })
  })
}

function waitForExit(child: ChildProcess, label: string): Promise<void> {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', code =>
      code === 0 ? resolveExit() : reject(new Error(`${label} exited with code ${String(code)}`))
    )
  })
}

export async function seedCodexTokens(repoRoot: string, home: string): Promise<void> {
  const python = resolve(repoRoot, 'venv/bin/python')
  const child = spawn(
    python,
    ['-c', 'from hermes_cli import auth; auth._save_codex_tokens(auth._import_codex_cli_tokens())'],
    {
      cwd: repoRoot,
      env: { ...process.env, HERMES_HOME: home },
      stdio: 'inherit'
    }
  )
  await waitForExit(child, 'Codex token seeding')
}

export interface RunningDaemon {
  child: ChildProcess
  port: number
  stop(): Promise<void>
}

export async function startDaemon(
  repoRoot: string,
  home: string,
  requestedPort?: number
): Promise<RunningDaemon> {
  const port = requestedPort ?? (await pickFreePort())
  const child = spawn(resolve(repoRoot, 'venv/bin/hexbot'), ['serve', '--port', String(port)], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: { ...process.env, HEXBOT_HOME: home, HERMES_HOME: undefined },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  let pending = ''

  const ready = new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Daemon readiness timed out. Output:\n${output}`)),
      60_000
    )
    const consume = (chunk: Buffer) => {
      const text = chunk.toString()
      output += text
      const lines = `${pending}${text}`.split(/\r?\n/)
      pending = lines.pop() ?? ''
      if (lines.some(line => parseReadyPort(line) === port) || parseReadyPort(pending) === port) {
        clearTimeout(timeout)
        resolveReady()
      }
    }
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)
    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timeout)
      reject(
        new Error(`Daemon exited before readiness with code ${String(code)}. Output:\n${output}`)
      )
    })
  })

  await ready

  return {
    child,
    port,
    stop: () =>
      new Promise(resolveStop => {
        if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
          resolveStop()
          return
        }
        const timeout = setTimeout(() => {
          if (child.pid) {
            if (process.platform === 'win32') child.kill('SIGKILL')
            else process.kill(-child.pid, 'SIGKILL')
          }
          resolveStop()
        }, 5_000)
        child.once('exit', () => {
          clearTimeout(timeout)
          resolveStop()
        })
        if (process.platform === 'win32') child.kill('SIGTERM')
        else process.kill(-child.pid, 'SIGTERM')
      })
  }
}
