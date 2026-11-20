/**
 * This computer as one of the user's computers (backend/hexbot-core/src/machines.rs).
 *
 * Only this process decides whether bots may use the computer the app runs
 * on. The switch is saved here, off by default; turning the terminal or the
 * desktop on asks with a native dialog, so neither the daemon nor the page
 * can turn it on. Every request from the daemon is checked against it again
 * before it runs: a command in the user's shell, or one Cua desktop action
 * through Cua's direct connection to this computer (`cua host setup
 * --direct`). The tray says while a bot is acting here and stops it.
 */
import {
  type ChildProcessWithoutNullStreams,
  execFile,
  execFileSync,
  spawn
} from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

export interface ComputerShare {
  desktop: boolean
  desktopReady: boolean
  desktopNote?: null | string
  name: string
  os: string
  terminal: boolean
}

export interface ComputerRequest {
  args?: Record<string, unknown>
  command?: string
  /** The action the daemon last checked: only an already running Cua may send it. */
  final?: boolean
  kind?: string
  request_id?: string
  timeout?: number
  tool?: string
}

/** The arguments each desktop tool takes from the daemon; anything else, such
 * as Cua's `sandbox` (another computer) or a launch's `args`, never reaches Cua. */
const DESKTOP_ARGS: Record<string, string[]> = {
  computer_click: ['x', 'y', 'button'],
  computer_double_click: ['x', 'y'],
  computer_drag: ['start_x', 'start_y', 'end_x', 'end_y'],
  computer_get_screen_size: [],
  computer_hotkey: ['keys'],
  computer_key: ['key'],
  computer_launch: ['app'],
  computer_move_cursor: ['x', 'y'],
  computer_screenshot: [],
  computer_scroll: ['direction', 'amount'],
  computer_type: ['text'],
  computer_window_list: []
}
/** Only the arguments `tool` takes. */
export function desktopArgs(tool: string, args: unknown): Record<string, unknown> {
  const given = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  return Object.fromEntries(
    (DESKTOP_ARGS[tool] ?? []).filter(key => key in given).map(key => [key, given[key]])
  )
}
/** The Cua tool groups `DESKTOP_TOOLS` need, and no others. */
export const DESKTOP_PERMISSIONS =
  'computer:screenshot,computer:click,computer:drag,computer:scroll,computer:type,computer:key,computer:hotkey,computer:window'
/** The Cua tools a bot's desktop actions use. Shell, files and the clipboard never run here. */
export const DESKTOP_TOOLS = new Set([
  'computer_screenshot',
  'computer_click',
  'computer_double_click',
  'computer_move_cursor',
  'computer_drag',
  'computer_scroll',
  'computer_type',
  'computer_key',
  'computer_hotkey',
  'computer_launch',
  'computer_window_list',
  'computer_get_screen_size'
])
const TERMINAL_DEFAULT = 120
const TERMINAL_MAX = 1800
export const OUTPUT_CAP = 200_000

export function osName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? 'macOS'
    : platform === 'win32'
      ? 'Windows'
      : platform === 'linux'
        ? 'Linux'
        : platform
}

/** What the user allowed, from its file; anything unreadable is off. */
export function readAllowed(path: string): { desktop: boolean; terminal: boolean } {
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    return { desktop: saved.desktop === true, terminal: saved.terminal === true }
  } catch {
    return { desktop: false, terminal: false }
  }
}

/** A request this computer refuses before it runs, or null when it may run. */
export function refusal(
  request: ComputerRequest,
  allowed: { desktop: boolean; terminal: boolean }
): null | string {
  if (request.kind === 'terminal') {
    if (!allowed.terminal) return 'This computer does not let bots work on it.'
    if (typeof request.command !== 'string' || !request.command.trim())
      return 'The command is empty.'
    return null
  }
  if (request.kind === 'desktop') {
    if (!allowed.desktop) return 'This computer does not let Computer Use reach its screen.'
    if (typeof request.tool !== 'string' || !DESKTOP_TOOLS.has(request.tool))
      return 'That action is not allowed on this computer.'
    return null
  }
  return 'Unknown request.'
}

/** The command line that runs one command in the user's own shell. */
export function shellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  shell = process.env.SHELL
): [string, string[]] {
  if (platform === 'win32')
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]]
  return [shell && existsSync(shell) ? shell : '/bin/sh', ['-lc', command]]
}

/** Keeps the end of long output, where errors usually are. */
export function capOutput(text: string, cap = OUTPUT_CAP): string {
  return text.length > cap ? `[earlier output cut]\n${text.slice(text.length - cap)}` : text
}

/** Every Cua this app started that has not exited yet. */
const liveCua = new Set<ChildProcessWithoutNullStreams>()

/**
 * Ends every Cua at once with SIGKILL. For quitting: the app may exit before
 * a gentler shutdown's 2 s escalation would fire.
 */
export function killCuaNow(): void {
  for (const child of liveCua) child.kill('SIGKILL')
}

/** Ends a command and everything it started: its process group, or its tree on Windows. */
export function killTree(
  child: { pid?: number; kill(signal?: NodeJS.Signals): boolean },
  platform: NodeJS.Platform = process.platform
): void {
  if (!child.pid) return
  try {
    if (platform === 'win32')
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/** When a process started, as `ps` reports it; empty when there is none. */
export function startedAt(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000
    }).trim()
  } catch {
    return ''
  }
}

/**
 * Process groups bots started here, kept after their shell exits: a job a
 * command left running in the background is still theirs to end. A group's
 * id can't be reused while anything is left in it; once it empties it is
 * dropped (checked every few seconds), and before a group is ended its
 * leader must be gone or still be the process that was started, so an id
 * some other program got since is never signalled. A program that leaves
 * its group on purpose (setsid, a daemon) is not followed.
 */
export class Groups {
  private readonly ids = new Map<number, string>()
  private timer: NodeJS.Timeout | null = null
  constructor(private readonly started: (pid: number) => string = startedAt) {}
  private prune(): void {
    for (const id of this.ids.keys()) {
      try {
        process.kill(-id, 0)
      } catch {
        this.ids.delete(id)
      }
    }
    if (!this.ids.size && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
  add(pid: number | undefined): void {
    if (!pid || process.platform === 'win32') return
    this.prune()
    this.ids.set(pid, this.started(pid))
    if (!this.timer) {
      this.timer = setInterval(() => this.prune(), 3000)
      this.timer.unref()
    }
  }
  /** Whether a group is still the one started: its leader gone, or the same process. */
  private ours(id: number, started: string): boolean {
    const now = this.started(id)
    return now === '' || now === started
  }
  /** Ends one group, if it is still the one started. */
  endOne(id: number | undefined): void {
    if (!id) return
    const started = this.ids.get(id)
    if (started === undefined) return
    this.ids.delete(id)
    if (!this.ours(id, started)) return
    try {
      process.kill(-id, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  /** Ends every group still alive and still the one started. */
  end(): void {
    for (const id of [...this.ids.keys()]) this.endOne(id)
  }
  get size(): number {
    return this.ids.size
  }
}

export function runCommand(
  command: string,
  timeout: number,
  running: Set<ChildProcessWithoutNullStreams>,
  groups: Groups,
  byRequest: Map<string, ChildProcessWithoutNullStreams>,
  requestId: string | undefined
): Promise<{ exit_code: number; output: string; timed_out: boolean }> {
  const [program, args] = shellCommand(command)
  return new Promise(resolve => {
    // Its own process group, so Stop ends what it started too.
    const child = spawn(program, args, {
      cwd: homedir(),
      detached: process.platform !== 'win32',
      env: process.env,
      windowsHide: true
    })
    // Nothing types into it: a command that waits for input ends at once
    // instead of at its timeout.
    child.stdin.end()
    running.add(child)
    groups.add(child.pid)
    if (requestId) byRequest.set(requestId, child)
    let output = ''
    let timedOut = false
    const take = (chunk: Buffer) => {
      output = capOutput(output + chunk.toString('utf8'), OUTPUT_CAP * 2)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeout * 1000)
    child.on('error', error => {
      clearTimeout(timer)
      running.delete(child)
      resolve({ exit_code: -1, output: error.message, timed_out: false })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (requestId) byRequest.delete(requestId)
      const stopped = !running.has(child)
      running.delete(child)
      if (stopped && !timedOut) {
        resolve({
          exit_code: code ?? 137,
          output: `${capOutput(output)}\n[Stopped: the user stopped bots on this computer.]`,
          timed_out: false
        })
        return
      }
      resolve({
        exit_code: timedOut ? 124 : (code ?? (signal ? 137 : -1)),
        output: capOutput(output),
        timed_out: timedOut
      })
    })
  })
}

/** Where `cua` is: on PATH, or where its installer puts it. */
export function findCua(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): null | string {
  const name = process.platform === 'win32' ? 'cua.exe' : 'cua'
  const dirs = [
    ...(env.PATH ?? '').split(delimiter),
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  for (const dir of dirs) {
    if (!dir) continue
    const path = join(dir, name)
    if (exists(path)) return path
  }
  return null
}

function cuaJson(
  cua: string,
  args: string[],
  timeout = 60_000
): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise(resolve => {
    execFile(
      cua,
      args,
      { timeout, env: { ...process.env, CUA_TELEMETRY: '0', DO_NOT_TRACK: '1' } },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? -1
              : 0
        resolve({ code, stderr: String(stderr), stdout: String(stdout) })
      }
    )
  })
}

/** Cua's direct connection to this computer, served on loopback, when it runs. */
export function localTarget(listing: string): null | string {
  try {
    const list = JSON.parse(listing) as { id?: string; location?: string; state?: string }[]
    const local = ['direct:127.0.0.1:', 'direct:localhost:', 'direct:[::1]:']
    return (
      list.find(
        s =>
          s.location === 'direct' &&
          s.state === 'running' &&
          local.some(prefix => s.id?.startsWith(prefix))
      )?.id ?? null
    )
  } catch {
    return null
  }
}

/** One line-delimited JSON-RPC client for `cua mcp` on this computer. */
export class DesktopClient {
  private child: ChildProcessWithoutNullStreams | null = null
  /** Cua answered its initialize: the session a final action may use. */
  private initialized = false
  private next = 1
  /** Calls waiting for a reply, each with the Cua that took it. */
  private waiting = new Map<
    number,
    {
      child: ChildProcessWithoutNullStreams
      done: (reply: { error?: { message?: string }; result?: unknown }) => void
    }
  >()
  private ready: Promise<void> | null = null
  /** Each Cua's one shutdown, shared by every path that ends it. */
  private readonly stopping = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>()
  /** The last shutdown: no Cua starts until it is over. */
  private exiting: Promise<void> = Promise.resolve()
  /** Bumped by close(), so a start that waited on `exiting` doesn't run after it. */
  private generation = 0

  constructor(
    private readonly cua: string,
    private readonly target: string
  ) {}

  private send(
    method: string,
    params: unknown,
    notify = false
  ): Promise<{ error?: { message?: string }; result?: unknown }> {
    const child = this.child
    if (!child) return Promise.reject(new Error('The desktop connection closed.'))
    if (notify) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`, error => {
        if (error) void this.shutdown(child, `The desktop connection broke: ${error.message}`)
      })
      return Promise.resolve({})
    }
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        // Ending Cua ends the action too, so it can't land later: fail once it has.
        void this.shutdown(child, 'The desktop connection closed.').then(() =>
          reject(new Error('This computer took too long to answer.'))
        )
      }, 60_000)
      this.waiting.set(id, {
        child,
        done: reply => {
          clearTimeout(timer)
          resolve(reply)
        }
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        // The pipe broke: Cua may still run what it took, so it ends first.
        if (error) void this.shutdown(child, `The desktop connection broke: ${error.message}`)
      })
    })
  }

  /**
   * Ends one Cua and resolves once it has exited (SIGKILL after 2 s). Only
   * then do its waiting calls fail, so the daemon hears of a failure only
   * once the action can no longer land. Every path that ends a Cua comes
   * here, and a second call returns the first one's promise.
   */
  private shutdown(child: ChildProcessWithoutNullStreams, message: string): Promise<void> {
    const known = this.stopping.get(child)
    if (known) return known
    if (this.child === child) {
      this.child = null
      this.ready = null
      this.initialized = false
    }
    const settle = () => {
      for (const [id, waiting] of this.waiting) {
        if (waiting.child !== child) continue
        this.waiting.delete(id)
        waiting.done({ error: { message } })
      }
    }
    const gone = child.pid === undefined || child.exitCode !== null || child.signalCode !== null
    const done = gone
      ? Promise.resolve().then(settle)
      : new Promise<void>(resolve => {
          const hard = setTimeout(() => child.kill('SIGKILL'), 2000)
          child.once('exit', () => {
            clearTimeout(hard)
            settle()
            resolve()
          })
          child.kill()
        })
    this.stopping.set(child, done)
    this.exiting = done
    return done
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready
    const generation = this.generation
    this.ready = (async () => {
      // A Cua still exiting finishes first: two never run at once.
      await this.exiting
      if (generation !== this.generation) throw new Error('The desktop connection closed.')
      await this.spawnCua()
    })()
    return this.ready
  }

  private async spawnCua(): Promise<void> {
    // Only the tool groups desktop actions use: never Cua's shell, files,
    // clipboard or accessibility actions on this computer.
    const child = spawn(
      this.cua,
      ['mcp', '--sandbox', this.target, '--permissions', DESKTOP_PERMISSIONS],
      {
        env: { ...process.env, CUA_TELEMETRY: '0', DO_NOT_TRACK: '1' },
        windowsHide: true
      }
    )
    this.child = child
    liveCua.add(child)
    child.once('exit', () => liveCua.delete(child))
    child.once('error', () => liveCua.delete(child))
    // Each Cua parses its own output: a reply cut off by a stop never runs
    // into the next one's. Its log on stderr is read and dropped, so a full
    // pipe never stalls it.
    let buffer = ''
    child.stderr.resume()
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        try {
          const message = JSON.parse(line) as {
            id?: number
            error?: { message?: string }
            result?: unknown
          }
          const waiting = typeof message.id === 'number' ? this.waiting.get(message.id) : undefined
          if (waiting?.child === child) {
            this.waiting.delete(message.id!)
            waiting.done(message)
          }
        } catch {
          // Log lines are not replies.
        }
      }
    })
    // Each ends only this Cua and only its calls; the next request starts
    // another once it has exited.
    child.on('close', () => void this.shutdown(child, 'The desktop connection closed.'))
    child.on('error', error => void this.shutdown(child, `Cua could not start: ${error.message}`))
    child.stdin.on(
      'error',
      error => void this.shutdown(child, `The desktop connection broke: ${error.message}`)
    )
    const reply = await this.send('initialize', {
      capabilities: {},
      clientInfo: { name: 'Hexbot', version: '1' },
      protocolVersion: '2024-11-05'
    })
    if (reply.error) throw new Error(reply.error.message ?? 'Cua did not start.')
    await this.send('notifications/initialized', {}, true)
    if (this.child === child) this.initialized = true
  }

  /**
   * A final action (`final`) uses only the Cua session that is already up,
   * the one the daemon's last check ran against: it never starts another.
   */
  async call(
    tool: string,
    args: Record<string, unknown>,
    still: () => void = () => {},
    final = false
  ): Promise<unknown> {
    if (final && !this.initialized) {
      throw new Error(
        'The connection to Cua changed before this ran. Take a screenshot and try again.'
      )
    }
    await this.start()
    still()
    const reply = await this.send('tools/call', { arguments: args, name: tool })
    if (reply.error) throw new Error(reply.error.message ?? 'The action failed.')
    return reply.result
  }

  /** Ends Cua; resolves once it, and any Cua still ending, has exited. */
  close(): Promise<void> {
    this.generation++
    this.ready = null
    return this.child ? this.shutdown(this.child, 'The desktop connection closed.') : this.exiting
  }
}

export interface ComputerHost {
  /** Asks the user natively; resolves true when they allow it. */
  confirm(what: 'desktop' | 'terminal'): Promise<boolean>
  /** Tells the page and the tray what changed. */
  changed(share: ComputerShare): void
  /** A bot started or finished acting here. */
  acting(active: boolean): void
}

export class ThisComputer {
  private allowed: { desktop: boolean; terminal: boolean }
  /** What was on when last saved, so a save ends only what it takes away. */
  private on: { desktop: boolean; terminal: boolean }
  private client: DesktopClient | null = null
  /** Commands running now, ended when the terminal is turned off or Stop. */
  private readonly running = new Set<ChildProcessWithoutNullStreams>()
  /** What those commands started, background jobs included. */
  private readonly groups = new Groups()
  /** Each running command by the daemon's request, so one can be stopped alone. */
  private readonly byRequest = new Map<string, ChildProcessWithoutNullStreams>()
  /** Requests the daemon stopped while they waited: refused before they reach the computer. */
  private readonly cancelled = new Set<string>()
  /** The desktop request Cua is running now, which a cancel ends by ending Cua. */
  private desktopNow: null | string = null
  /** A Cua still exiting: no new one starts until it has. */
  private closing: Promise<void> = Promise.resolve()
  private closeClient(): void {
    const client = this.client
    this.client = null
    if (client) this.closing = this.closing.then(() => client.close())
  }
  private active = 0
  /**
   * Each moves on whenever bots lose that one (its switch off, Stop, the
   * connection ending), so work already waiting for it can't run after;
   * turning the terminal off leaves desktop work be, and the reverse.
   */
  private generations = { desktop: 0, terminal: 0 }
  private readyCache: { at: number; note: null | string; target: null | string } | null = null

  /** Saves go one at a time, each writing the switch as it is then, so the last one is the newest. */
  private saving: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly host: ComputerHost,
    private readonly write: (file: string, text: string) => Promise<void> = async (path, text) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text, { mode: 0o600 })
    }
  ) {
    this.allowed = readAllowed(file)
    this.on = { ...this.allowed }
  }

  private async desktopTarget(): Promise<{ note: null | string; target: null | string }> {
    if (this.readyCache && Date.now() - this.readyCache.at < 15_000) return this.readyCache
    const cua = findCua()
    let found: { note: null | string; target: null | string }
    if (!cua)
      found = {
        note: 'Needs Cua on this computer: install it with "uv tool install cua", then choose Set up.',
        target: null
      }
    else {
      const listing = await cuaJson(cua, ['sb', 'ls', '--json'], 10_000)
      const target = localTarget(listing.stdout)
      found = target
        ? { note: null, target }
        : { note: 'Cua is installed; Set up shares this desktop with it.', target: null }
    }
    this.readyCache = { at: Date.now(), ...found }
    return found
  }

  async state(): Promise<ComputerShare> {
    const { note, target } = await this.desktopTarget()
    return {
      // The user's choice: a Cua that isn't up yet fails each request
      // clearly, and the offer needn't wait for it to start.
      desktop: this.allowed.desktop,
      desktopNote: note,
      desktopReady: Boolean(target),
      name: hostname().replace(/\.local$/, ''),
      os: osName(),
      terminal: this.allowed.terminal
    }
  }

  /** Ends the terminal's commands and the desktop connection, as asked. */
  private end(terminal: boolean, desktop: boolean): void {
    if (terminal) this.generations.terminal++
    if (desktop) this.generations.desktop++
    if (terminal) {
      for (const child of this.running) {
        this.running.delete(child)
        killTree(child)
      }
      this.groups.end()
    }
    if (desktop) this.closeClient()
  }

  /**
   * The connection to the daemon closed, the device was revoked, or the app
   * is quitting: what bots started here stops. Resolves once Cua has exited,
   * so whoever confirms the release does so after nothing can land; quitting
   * ends Cua with SIGKILL at once. The switch stays as the user set it; the
   * next connection offers this computer again.
   */
  release(quitting = false): Promise<void> {
    this.end(true, true)
    if (quitting) killCuaNow()
    return this.closing
  }

  private async save(): Promise<ComputerShare> {
    // Refuse and end at once what was on and is now off; the file can
    // follow. Turning something on (or a dialog cancelled) takes nothing
    // away, so work already waiting here goes on.
    const off = {
      desktop: this.on.desktop && !this.allowed.desktop,
      terminal: this.on.terminal && !this.allowed.terminal
    }
    this.on = { ...this.allowed }
    if (off.terminal || off.desktop) this.end(off.terminal, off.desktop)
    this.saving = this.saving
      .catch(() => {})
      .then(() => this.write(this.file, JSON.stringify(this.allowed)))
    await this.saving
    const share = await this.state()
    this.host.changed(share)
    return share
  }

  /**
   * Turning on asks first; turning off never does. An answer that comes
   * after bots lost this computer while the question was open (Stop, the
   * connection ending) is dropped: Stop is never undone by a dialog.
   */
  async allow(change: { desktop?: unknown; terminal?: unknown }): Promise<ComputerShare> {
    for (const what of ['terminal', 'desktop'] as const) {
      const next = change[what]
      if (typeof next !== 'boolean' || next === this.allowed[what]) continue
      // Computer Use here sits on Let bots work here: a computer no bot can
      // be given has no screen for a bot to reach.
      if (what === 'desktop' && next && !this.allowed.terminal) continue
      if (next) {
        const asked = this.generations[what]
        if (!(await this.host.confirm(what)) || asked !== this.generations[what]) continue
      }
      this.allowed = { ...this.allowed, [what]: next }
    }
    if (!this.allowed.terminal && this.allowed.desktop)
      this.allowed = { ...this.allowed, desktop: false }
    return this.save()
  }

  /** The daemon stopped one request: its command and its process group end. */
  cancel(requestId: unknown): void {
    if (typeof requestId !== 'string') return
    const child = this.byRequest.get(requestId)
    if (!child) {
      // In Cua now: ending Cua ends the action, and the request fails.
      if (this.desktopNow === requestId) {
        this.closeClient()
        return
      }
      // Still waiting, such as a desktop action whose Cua is starting.
      if (this.cancelled.size > 256) this.cancelled.clear()
      this.cancelled.add(requestId)
      return
    }
    this.byRequest.delete(requestId)
    this.running.delete(child)
    killTree(child)
    this.groups.endOne(child.pid)
  }

  /** The tray's Stop: nothing here takes a bot's work any more. */
  async stop(): Promise<ComputerShare> {
    // Always ends everything, so a dialog left open can't undo it.
    this.end(true, true)
    this.allowed = { desktop: false, terminal: false }
    return this.save()
  }

  /** Sets Cua up to share this desktop; the system asks for its permissions then. */
  async setupDesktop(): Promise<ComputerShare> {
    const cua = findCua()
    if (!cua)
      throw new Error(
        'Install Cua on this computer first: run "uv tool install cua" in a terminal, then try again.'
      )
    const result = await cuaJson(
      cua,
      ['host', 'setup', '--direct', '127.0.0.1:3211', '--no-provide-spaces', '--json'],
      300_000
    )
    this.readyCache = null
    if (result.code !== 0) {
      const line = result.stderr
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .pop()
      throw new Error(line ?? 'Cua could not set up this computer.')
    }
    return this.state()
  }

  async run(request: ComputerRequest): Promise<unknown> {
    const refused = refusal(request, this.allowed)
    if (refused) throw new Error(refused)
    const kind = request.kind === 'desktop' ? 'desktop' : 'terminal'
    const generation = this.generations[kind]
    // Checked again after every wait, right before anything reaches the computer.
    const id = typeof request.request_id === 'string' ? request.request_id : null
    // Set once the request ran out of time: whatever it still awaits then
    // never reaches the computer.
    let expired = false
    const still = () => {
      if (expired) throw new Error('This computer took too long to answer.')
      const now = refusal(request, this.allowed)
      if (now || generation !== this.generations[kind])
        throw new Error(now ?? 'Bots were stopped on this computer.')
      if (id && this.cancelled.has(id)) throw new Error('The request was stopped.')
    }
    still()
    this.active++
    this.host.acting(true)
    try {
      if (request.kind === 'terminal') {
        const timeout = Math.min(
          Math.max(Math.round(Number(request.timeout) || TERMINAL_DEFAULT), 1),
          TERMINAL_MAX
        )
        return await runCommand(
          request.command!,
          timeout,
          this.running,
          this.groups,
          this.byRequest,
          request.request_id
        )
      }
      // The whole request answers within 75 s, before the daemon stops
      // waiting at 90 s: past it Cua is ended, and the request fails once
      // Cua has exited.
      let overtime: NodeJS.Timeout | undefined
      const late = new Promise<never>((_, reject) => {
        overtime = setTimeout(() => {
          expired = true
          this.closeClient()
          void this.closing.then(() => reject(new Error('This computer took too long to answer.')))
        }, 75_000)
      })
      const final = request.final === true
      const work = (async () => {
        if (final) {
          // The daemon's last check of the app in front ran against the Cua
          // session up now: the action goes straight to it, with no lookup
          // or start in between, or not at all.
          if (!this.client) {
            throw new Error(
              'The connection to Cua changed before this ran. Take a screenshot and try again.'
            )
          }
        } else {
          const { target } = await this.desktopTarget()
          still()
          await this.closing
          still()
          if (!target) throw new Error("This computer's desktop is not set up for bots.")
          // Only a new connection needs Cua's program; one already up keeps going.
          if (!this.client) {
            const cua = findCua()
            if (!cua) throw new Error("This computer's desktop is not set up for bots.")
            this.client = new DesktopClient(cua, target)
          }
        }
        const client = this.client
        const args = desktopArgs(request.tool!, request.args)
        this.desktopNow = id
        try {
          return await client.call(request.tool!, args, still, final)
        } finally {
          if (this.desktopNow === id) this.desktopNow = null
        }
      })()
      try {
        return await Promise.race([work, late])
      } finally {
        clearTimeout(overtime)
        work.catch(() => {})
      }
    } finally {
      if (id) this.cancelled.delete(id)
      this.active--
      if (!this.active) this.host.acting(false)
    }
  }

  get allowedNow(): { desktop: boolean; terminal: boolean } {
    return this.allowed
  }
}
