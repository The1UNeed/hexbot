/**
 * This computer, lent to the daemon's bots. The user turns it on in
 * Settings, Computers, on this computer; the page then offers it over its
 * own connection, and the daemon sends requests for it there
 * (`hexbot.computer.request`). The daemon decides who, what and how gated.
 * This side only runs two kinds of request:
 *
 * - `shell`: a command in the extension's own OS sandbox (`hexbot-isolation`,
 *   which is `backend/pi-runtime/isolation.ts`), in `~/Hexbot`, at the level
 *   the daemon's gate settled: `confined` (no network, writes only in the
 *   workspace and temp folders, or none when `read_only`), `base` (full
 *   access, credentials still unreadable) or `none` (Bypass).
 * - `mcp`: one of Cua's screen tools, through this computer's own `cua mcp
 *   --sandbox host`, only when the user also lent the screen.
 * - `http`: one request to a page a bot serves on this computer's loopback,
 *   for Preview beside the chat.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname, platform, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import {
  credentialPolicy,
  isolatedCommand,
  isolationAvailable,
  probeIsolation
} from 'hexbot-isolation'

/** What the user chose here: lend this computer, and its screen too. */
export interface LendChoice {
  on: boolean
  screen: boolean
}

export interface LendState extends LendChoice {
  name: string
  os: string
  /** This computer has an OS sandbox for the commands bots run. */
  sandbox: boolean
  /** This computer has Cua, which the screen needs. */
  cua: boolean
}

/** Where commands run and what they may write. */
export const WORKSPACE = join(homedir(), 'Hexbot')
/** Output is cut here; a bot reads what it needs with a narrower command. */
const OUTPUT_LIMIT = 100_000
const DEFAULT_TIMEOUT_S = 120
const MAX_TIMEOUT_S = 600

function osName(): string {
  return { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[platform() as string] ?? platform()
}

function choicePath(dataDir: string): string {
  return join(dataDir, 'lend-computer.json')
}

export function readChoice(dataDir: string): LendChoice {
  try {
    const saved = JSON.parse(readFileSync(choicePath(dataDir), 'utf8')) as Partial<LendChoice>
    return { on: saved.on === true, screen: saved.on === true && saved.screen === true }
  } catch {
    return { on: false, screen: false }
  }
}

export function writeChoice(dataDir: string, choice: LendChoice): LendChoice {
  const saved = { on: choice.on, screen: choice.on && choice.screen }
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(choicePath(dataDir), JSON.stringify(saved), { mode: 0o600 })
  return saved
}

/** `cua` on this computer: the usual install places, then the PATH. */
export function cuaCommand(env: NodeJS.ProcessEnv = process.env): null | string {
  const places = [
    join(homedir(), '.local/bin/cua'),
    '/opt/homebrew/bin/cua',
    '/usr/local/bin/cua',
    ...(env.PATH ?? '').split(delimiter).map(dir => join(dir, 'cua'))
  ]

  return places.find(place => place && existsSync(place)) ?? null
}

export function lendState(dataDir: string): LendState {
  probeIsolation()

  return {
    ...readChoice(dataDir),
    cua: cuaCommand() !== null,
    name: hostname().replace(/\.local$/, ''),
    os: osName(),
    sandbox: platform() !== 'win32' && isolationAvailable()
  }
}

/** Only the variables the extension lets a command inherit. */
function environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = new Set(credentialPolicy.environment.map(name => name.toUpperCase()))

  return Object.fromEntries(
    Object.entries(env).filter(([name]) => inherited.has(name.toUpperCase()) || /^LC_/i.test(name))
  )
}

export interface ShellRequest {
  command: string
  level: 'base' | 'confined' | 'none'
  read_only?: boolean
  timeout?: number
}

/**
 * Run one command the daemon sent. `home` is this computer's Hexbot home,
 * whose secrets the sandbox keeps unreadable like every other credential.
 */
export function runShell(
  request: ShellRequest,
  home: string,
  spawnShell: typeof spawn = spawn
): Promise<{ exit_code: number; output: string }> {
  if (typeof request.command !== 'string' || !request.command.trim()) {
    return Promise.reject(new Error('No command to run.'))
  }

  if (!['base', 'confined', 'none'].includes(request.level)) {
    return Promise.reject(new Error('Unknown sandbox level.'))
  }

  mkdirSync(WORKSPACE, { recursive: true })
  let command = request.command

  if (request.level !== 'none') {
    probeIsolation()

    if (platform() === 'win32' || !isolationAvailable()) {
      return Promise.reject(
        new Error(
          'This computer has no OS sandbox for commands. The user can use Bypass, or run it on another computer.'
        )
      )
    }

    const writable = request.read_only ? [] : [WORKSPACE, tmpdir(), '/tmp']
    command = isolatedCommand(
      request.command,
      home,
      [],
      request.level === 'confined' ? writable : undefined,
      [WORKSPACE]
    )
  }

  const seconds = Math.min(
    Math.max(Number(request.timeout) || DEFAULT_TIMEOUT_S, 1),
    MAX_TIMEOUT_S
  )

  return new Promise((resolve, reject) => {
    const child = spawnShell('/bin/bash', ['-c', command], {
      cwd: WORKSPACE,
      env: request.level === 'none' ? process.env : environment(process.env)
    })
    let output = ''
    const take = (chunk: Buffer) => {
      if (output.length < OUTPUT_LIMIT) {
        output += chunk.toString('utf8')
      }
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), seconds * 1000)
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const cut = output.length >= OUTPUT_LIMIT ? '\n[Output cut short.]' : ''
      const stopped = signal ? `\n[Stopped after ${seconds} s.]` : ''
      resolve({ exit_code: code ?? 124, output: output.slice(0, OUTPUT_LIMIT) + cut + stopped })
    })
  })
}

/**
 * This computer's screen through its own `cua mcp --sandbox host`, started
 * on first use and kept for the next action.
 */
export class Screen {
  private child: ChildProcessWithoutNullStreams | null = null
  private ready: null | Promise<void> = null
  private next = 1
  private buffer = ''
  private readonly waiting = new Map<
    number,
    { reject: (error: Error) => void; resolve: (value: unknown) => void }
  >()

  constructor(private readonly spawnCua: typeof spawn = spawn) {}

  /** Let `cua` act on this desktop; the user chose it on this computer. */
  async consent(): Promise<void> {
    const cua = cuaCommand()

    if (!cua) {
      throw new Error('Install Cua on this computer first: uv tool install cua')
    }

    // Consent also points the user's own `cua do` at this desktop; Hexbot
    // names its target on every call, so the user's choice is put back.
    const target = join(process.env.CUA_HOME || join(homedir(), '.cua'), 'do_target.json')
    const before = existsSync(target) ? readFileSync(target) : null
    const restore = () => {
      try {
        if (before) writeFileSync(target, before)
        else if (existsSync(target)) rmSync(target)
      } catch {
        // Leaving Cua's target is better than failing the consent.
      }
    }

    await new Promise<void>((resolve, reject) => {
      const child = this.spawnCua(cua, ['do-host-consent', '--json'], {
        env: { ...process.env, CUA_TELEMETRY: '0', DO_NOT_TRACK: '1' }
      })
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      child.on('error', reject)
      child.on('close', code => {
        restore()
        if (code === 0) resolve()
        else reject(new Error(stderr.trim().split('\n').at(-1) || 'Cua could not use this screen.'))
      })
    })
  }

  private start(): Promise<void> {
    if (this.ready) {
      return this.ready
    }

    const cua = cuaCommand()

    if (!cua) {
      return Promise.reject(new Error('This computer has no Cua for its screen.'))
    }

    const child = this.spawnCua(cua, ['mcp', '--sandbox', 'host', '--permissions', 'computer:all'], {
      env: { ...process.env, CUA_TELEMETRY: '0', DO_NOT_TRACK: '1' }
    })
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => this.heard(chunk.toString('utf8')))
    child.on('close', () => this.stopped(new Error('The screen connection closed. Try again.')))
    child.on('error', error => this.stopped(error))
    this.ready = this.send('initialize', {
      capabilities: {},
      clientInfo: { name: 'Hexbot', version: '1' },
      protocolVersion: '2024-11-05'
    }).then(() => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    })
    this.ready.catch(() => this.stop())

    return this.ready
  }

  private send(method: string, params: unknown): Promise<unknown> {
    const id = this.next++

    return new Promise((resolve, reject) => {
      this.waiting.set(id, { reject, resolve })
      this.child?.stdin.write(`${JSON.stringify({ id, jsonrpc: '2.0', method, params })}\n`)
    })
  }

  private heard(text: string): void {
    this.buffer += text
    let newline = this.buffer.indexOf('\n')

    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')

      if (!line) {
        continue
      }

      try {
        const message = JSON.parse(line) as {
          error?: { message?: string }
          id?: number
          result?: unknown
        }
        const waiter = message.id === undefined ? undefined : this.waiting.get(message.id)

        if (!waiter || message.id === undefined) {
          continue
        }

        this.waiting.delete(message.id)

        if (message.error) {
          waiter.reject(new Error(message.error.message ?? 'The screen refused that.'))
        } else {
          waiter.resolve(message.result)
        }
      } catch {
        // Cua's log lines are not ours to read.
      }
    }
  }

  private stopped(error: Error): void {
    for (const waiter of this.waiting.values()) waiter.reject(error)
    this.waiting.clear()
    this.child = null
    this.ready = null
  }

  /** One screen tool, such as `computer_screenshot`, with its arguments. */
  async call(tool: string, args: unknown): Promise<unknown> {
    if (!/^computer_[a-z_]+$/.test(tool) || tool === 'computer_shell') {
      throw new Error('Only screen tools run here.')
    }

    await this.start()

    return this.send('tools/call', { arguments: args ?? {}, name: tool })
  }

  stop(): void {
    this.child?.kill()
    this.stopped(new Error('The screen connection closed.'))
  }
}

export interface HttpRequest {
  body?: string
  headers?: [string, string][]
  method?: string
  path?: string
  port?: number
}

/** One request to `127.0.0.1:<port>` on this computer, for Preview. */
export async function fetchLocal(
  request: HttpRequest,
  fetcher: typeof fetch = fetch
): Promise<{ body: string; headers: [string, string][]; status: number }> {
  const port = Number(request.port)
  const path = typeof request.path === 'string' && request.path.startsWith('/') ? request.path : '/'

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Preview needs a port between 1 and 65535.')
  }

  const method = (request.method ?? 'GET').toUpperCase()
  const body =
    request.body && !['GET', 'HEAD'].includes(method) ? Buffer.from(request.body, 'base64') : undefined
  const response = await fetcher(`http://127.0.0.1:${port}${path}`, {
    body,
    headers: (request.headers ?? []).filter(pair => Array.isArray(pair) && pair.length === 2),
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(60_000)
  }).catch(() => {
    throw new Error('Nothing answers on that port on this computer. Is the server still running?')
  })
  const bytes = Buffer.from(await response.arrayBuffer())

  if (bytes.length > 16 * 1024 * 1024) {
    throw new Error('That page is too large to preview.')
  }

  return {
    body: bytes.toString('base64'),
    headers: [...response.headers.entries()],
    status: response.status
  }
}

/** Answer one `hexbot.computer.request` from the daemon. */
export async function runRequest(
  request: unknown,
  { dataDir, home, screen }: { dataDir: string; home: string; screen: Screen }
): Promise<unknown> {
  const choice = readChoice(dataDir)
  const payload = (request ?? {}) as Record<string, unknown>

  if (!choice.on) {
    throw new Error('This computer is no longer lent to your bots.')
  }

  if (payload.kind === 'shell') {
    return runShell(payload as unknown as ShellRequest, home)
  }

  if (payload.kind === 'http') {
    return fetchLocal(payload as HttpRequest)
  }

  if (payload.kind === 'mcp') {
    if (!choice.screen) {
      throw new Error('This computer lends its terminal, not its screen.')
    }

    return screen.call(String(payload.tool ?? ''), payload.arguments)
  }

  throw new Error('Unknown request.')
}
