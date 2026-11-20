import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  capOutput,
  DesktopClient,
  desktopArgs,
  DESKTOP_PERMISSIONS,
  DESKTOP_TOOLS,
  findCua,
  Groups,
  localTarget,
  osName,
  readAllowed,
  refusal,
  runCommand,
  shellCommand,
  ThisComputer,
  type ComputerShare
} from './computer'

const dirs: string[] = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexbot-computer-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/** A fake Cua that ignores SIGTERM, so ending it takes the SIGKILL after 2 s; it never answers "hang". */
const stubbornCua = () => {
  const cua = join(temp(), 'cua')
  writeFileSync(
    cua,
    [
      '#!/usr/bin/env node',
      "process.on('SIGTERM', () => {})",
      "let buffer = ''",
      "process.stdin.on('data', chunk => {",
      '  buffer += chunk',
      "  let i; while ((i = buffer.indexOf('\\n')) >= 0) {",
      '    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1)',
      '    if (!line.trim()) continue',
      '    const m = JSON.parse(line)',
      "    if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\\n')",
      "    else if (m.method === 'tools/call' && m.params.name !== 'hang') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { ok: true } }) + '\\n')",
      '  }',
      '})'
    ].join('\n'),
    { mode: 0o755 }
  )
  return cua
}

describe('this computer', () => {
  it('starts off, and anything unreadable is off', () => {
    const dir = temp()
    expect(readAllowed(join(dir, 'missing.json'))).toEqual({ desktop: false, terminal: false })
    writeFileSync(join(dir, 'bad.json'), '{not json')
    expect(readAllowed(join(dir, 'bad.json'))).toEqual({ desktop: false, terminal: false })
    writeFileSync(join(dir, 'odd.json'), JSON.stringify({ desktop: 'yes', terminal: 1 }))
    expect(readAllowed(join(dir, 'odd.json'))).toEqual({ desktop: false, terminal: false })
    // Saved by an earlier build with only the screen on: Computer Use here
    // sits on Let bots work here, so neither is on.
    writeFileSync(join(dir, 'screen.json'), JSON.stringify({ desktop: true, terminal: false }))
    expect(readAllowed(join(dir, 'screen.json'))).toEqual({ desktop: false, terminal: false })
    writeFileSync(join(dir, 'both.json'), JSON.stringify({ desktop: true, terminal: true }))
    expect(readAllowed(join(dir, 'both.json'))).toEqual({ desktop: true, terminal: true })
  })

  it('ends a command waiting for input at once instead of at its timeout', async () => {
    if (process.platform === 'win32') return
    const started = Date.now()
    const result = await runCommand(
      'read x; echo done "$x"',
      30,
      new Set(),
      new Groups(),
      new Map(),
      undefined
    )
    expect(result.output.trim()).toBe('done')
    expect(result.timed_out).toBe(false)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('starts Cua with only the desktop tool groups', async () => {
    if (process.platform === 'win32') return
    const dir = temp()
    const cua = join(dir, 'cua')
    const argsFile = join(dir, 'args')
    writeFileSync(
      cua,
      [
        '#!/usr/bin/env node',
        "const fs = require('fs')",
        `fs.writeFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join(' '))`,
        "let buffer = ''",
        "process.stdin.on('data', chunk => {",
        '  buffer += chunk',
        "  let i; while ((i = buffer.indexOf('\\n')) >= 0) {",
        '    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1)',
        '    if (!line.trim()) continue',
        '    const m = JSON.parse(line)',
        "    if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { ok: true } }) + '\\n')",
        '  }',
        '})'
      ].join('\n'),
      { mode: 0o755 }
    )
    const client = new DesktopClient(cua, 'direct:127.0.0.1:3211')
    await client.call('computer_get_screen_size', {})
    const args = readFileSync(argsFile, 'utf8')
    expect(args).toContain(`--permissions ${DESKTOP_PERMISSIONS}`)
    expect(args).not.toContain('computer:all')
    await client.close()
  })

  it('passes Cua only the arguments each desktop tool takes', () => {
    expect(
      desktopArgs('computer_click', { button: 'left', sandbox: 'direct:10.0.0.7:3211', x: 1, y: 2 })
    ).toEqual({
      button: 'left',
      x: 1,
      y: 2
    })
    expect(desktopArgs('computer_launch', { app: 'Notes', args: ['--evil'] })).toEqual({
      app: 'Notes'
    })
    expect(desktopArgs('computer_screenshot', { sandbox: 'cloud-box' })).toEqual({})
    expect(desktopArgs('computer_shell', { command: 'ls' })).toEqual({})
  })

  it('refuses whatever the user has not allowed here', () => {
    const off = { desktop: false, terminal: false }
    const on = { desktop: true, terminal: true }
    expect(refusal({ command: 'ls', kind: 'terminal' }, off)).toMatch(
      /does not let bots work on it/
    )
    expect(refusal({ kind: 'desktop', tool: 'computer_click' }, off)).toMatch(/Computer Use/)
    expect(refusal({ command: 'ls', kind: 'terminal' }, on)).toBeNull()
    expect(refusal({ command: '  ', kind: 'terminal' }, on)).toMatch(/empty/)
    // Shell, files and the clipboard never run through the desktop.
    for (const tool of [
      'computer_shell',
      'computer_file_write',
      'computer_clipboard_get',
      'anything'
    ])
      expect(refusal({ kind: 'desktop', tool }, on)).toMatch(/not allowed/)
    for (const tool of DESKTOP_TOOLS) expect(refusal({ kind: 'desktop', tool }, on)).toBeNull()
    expect(refusal({ kind: 'other' }, on)).toMatch(/Unknown/)
  })

  it('runs commands in the user shell, PowerShell on Windows', () => {
    expect(shellCommand('ls', 'win32')).toEqual([
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'ls']
    ])
    expect(shellCommand('ls', 'darwin', '/no/such/shell')).toEqual(['/bin/sh', ['-lc', 'ls']])
    expect(osName('darwin')).toBe('macOS')
    expect(osName('win32')).toBe('Windows')
  })

  it('keeps the end of long output', () => {
    expect(capOutput('short', 10)).toBe('short')
    expect(capOutput('0123456789END', 5)).toBe('[earlier output cut]\n89END')
  })

  it('finds Cua and its loopback connection to this computer only', () => {
    expect(findCua({ PATH: '/a:/b' }, path => path === '/b/cua')).toBe('/b/cua')
    const listing = JSON.stringify([
      { id: 'direct:10.0.0.5:3211', location: 'direct', state: 'running' },
      { id: 'local:hexbot-computer-1', location: 'local', state: 'running' },
      { id: 'direct:127.0.0.1:3211', location: 'direct', state: 'stopped' },
      { id: 'direct:127.0.0.1:4000', location: 'direct', state: 'running' }
    ])
    expect(localTarget(listing)).toBe('direct:127.0.0.1:4000')
    expect(localTarget('[]')).toBeNull()
    expect(localTarget('not json')).toBeNull()
  })

  it('asks before turning on, never before turning off, and saves only what was allowed', async () => {
    const dir = temp()
    const file = join(dir, 'computer.json')
    const asked: string[] = []
    const changes: ComputerShare[] = []
    let answer = false
    const computer = new ThisComputer(file, {
      acting: () => {},
      changed: share => changes.push(share),
      confirm: async what => {
        asked.push(what)
        return answer
      }
    })
    await computer.allow({ terminal: true })
    expect(asked).toEqual(['terminal'])
    expect(computer.allowedNow.terminal).toBe(false)
    answer = true
    const share = await computer.allow({ terminal: true })
    expect(share.terminal).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ desktop: false, terminal: true })
    await expect(computer.run({ kind: 'desktop', tool: 'computer_click' })).rejects.toThrow(
      /Computer Use/
    )
    const result = (await computer.run({
      command: 'echo hello',
      kind: 'terminal',
      timeout: 10
    })) as {
      exit_code: number
      output: string
    }
    expect(result.exit_code).toBe(0)
    expect(result.output).toContain('hello')
    asked.length = 0
    await computer.allow({ terminal: false })
    expect(asked).toEqual([])
    await computer.allow({ terminal: true })
    await computer.stop()
    expect(computer.allowedNow).toEqual({ desktop: false, terminal: false })
    await expect(computer.run({ command: 'echo hi', kind: 'terminal' })).rejects.toThrow(
      /work on it/
    )
    expect(changes.length).toBeGreaterThan(0)
  })

  it('lets Computer Use reach the screen only while bots may work here', async () => {
    const asked: string[] = []
    const computer = new ThisComputer(join(temp(), 'c.json'), {
      acting: () => {},
      changed: () => {},
      confirm: async what => {
        asked.push(what)
        return true
      }
    })
    // Not a computer bots work on: nothing to ask, nothing turned on.
    await computer.allow({ desktop: true })
    expect(asked).toEqual([])
    expect(computer.allowedNow).toEqual({ desktop: false, terminal: false })
    // Both in one go: bots may work here, then its screen.
    await computer.allow({ desktop: true, terminal: true })
    expect(asked).toEqual(['terminal', 'desktop'])
    expect(computer.allowedNow).toEqual({ desktop: true, terminal: true })
    // Taking the computer away takes its screen too.
    await computer.allow({ terminal: false })
    expect(computer.allowedNow).toEqual({ desktop: false, terminal: false })
  })

  it('ends running commands, and what they started, when the user stops bots here', async () => {
    const computer = new ThisComputer(join(temp(), 'c.json'), {
      acting: () => {},
      changed: () => {},
      confirm: async () => true
    })
    await computer.allow({ terminal: true })
    const started = Date.now()
    const run = computer.run({
      command: 'sleep 30 & sleep 30; echo done',
      kind: 'terminal',
      timeout: 60
    }) as Promise<{
      output: string
    }>
    await new Promise(resolve => setTimeout(resolve, 300))
    await computer.stop()
    const result = await run
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(result.output).toContain('Stopped')
    expect(result.output).not.toContain('done')
  })

  it('ends what bots started when the connection goes, and keeps the switch', async () => {
    const file = join(temp(), 'c.json')
    const computer = new ThisComputer(file, {
      acting: () => {},
      changed: () => {},
      confirm: async () => true
    })
    await computer.allow({ terminal: true })
    const run = computer.run({
      command: 'sleep 30; echo done',
      kind: 'terminal',
      timeout: 60
    }) as Promise<{ output: string }>
    await new Promise(resolve => setTimeout(resolve, 300))
    computer.release()
    expect((await run).output).toContain('Stopped')
    expect(computer.allowedNow.terminal).toBe(true)
  })

  it(
    'ends background jobs a finished command left behind',
    { skip: process.platform === 'win32' },
    async () => {
      const dir = temp()
      const pidFile = join(dir, 'pid')
      const computer = new ThisComputer(join(dir, 'c.json'), {
        acting: () => {},
        changed: () => {},
        confirm: async () => true
      })
      await computer.allow({ terminal: true })
      const result = (await computer.run({
        command: `sleep 60 > /dev/null 2>&1 & echo $! > ${pidFile}`,
        kind: 'terminal',
        timeout: 10
      })) as { exit_code: number }
      expect(result.exit_code).toBe(0)
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(() => process.kill(pid, 0)).not.toThrow()
      computer.release()
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(() => process.kill(pid, 0)).toThrow()
    }
  )

  it('keeps the newest switch on disk when saves overlap', async () => {
    const file = join(temp(), 'c.json')
    let first = true
    let release: () => void = () => {}
    const computer = new ThisComputer(
      file,
      { acting: () => {}, changed: () => {}, confirm: async () => true },
      async (path, text) => {
        // The enabling save is slow; Stop's save comes after it anyway.
        if (first) {
          first = false
          await new Promise<void>(resolve => (release = resolve))
        }
        writeFileSync(path, text)
      }
    )
    const enabling = computer.allow({ terminal: true })
    await new Promise(resolve => setTimeout(resolve, 20))
    const stopping = computer.stop()
    release()
    await Promise.all([enabling, stopping])
    expect(readAllowed(file)).toEqual({ desktop: false, terminal: false })
  })

  it('drops an Allow that comes after Stop', async () => {
    let answer: (yes: boolean) => void = () => {}
    const computer = new ThisComputer(join(temp(), 'c.json'), {
      acting: () => {},
      changed: () => {},
      confirm: () => new Promise(resolve => (answer = resolve))
    })
    const allowing = computer.allow({ terminal: true })
    await computer.stop()
    answer(true)
    await allowing
    expect(computer.allowedNow.terminal).toBe(false)
  })

  it('ends one stopped request and leaves the others running', async () => {
    const computer = new ThisComputer(join(temp(), 'c.json'), {
      acting: () => {},
      changed: () => {},
      confirm: async () => true
    })
    await computer.allow({ terminal: true })
    const first = computer.run({
      command: 'sleep 30; echo one',
      kind: 'terminal',
      request_id: 'a',
      timeout: 60
    }) as Promise<{
      output: string
    }>
    const second = computer.run({
      command: 'sleep 0.5; echo two',
      kind: 'terminal',
      request_id: 'b',
      timeout: 60
    }) as Promise<{
      output: string
    }>
    await new Promise(resolve => setTimeout(resolve, 200))
    computer.cancel('a')
    expect((await first).output).toContain('Stopped')
    expect((await second).output).toContain('two')
  })

  it('never signals a group whose leader is now another process', () => {
    const killed: number[] = []
    const real = process.kill
    let leader = 'Mon Nov 18 10:00:00 2026'
    const groups = new Groups(() => leader)
    ;(process as unknown as { kill: (pid: number, signal?: string | number) => boolean }).kill = (
      pid,
      signal
    ) => {
      if (signal === 'SIGKILL') killed.push(pid)
      return true
    }
    try {
      groups.add(4242)
      leader = 'Tue Nov 19 12:00:00 2026'
      groups.end()
      expect(killed).toEqual([])
      leader = 'Mon Nov 18 10:00:00 2026'
      groups.add(4343)
      groups.end()
      expect(killed).toEqual([-4343])
    } finally {
      ;(process as unknown as { kill: typeof real }).kill = real
    }
  })

  it('refuses a desktop request the daemon stopped while Cua was starting', async () => {
    let found: (value: { note: null; target: string }) => void = () => {}
    const computer = new ThisComputer(join(temp(), 'c.json'), {
      acting: () => {},
      changed: () => {},
      confirm: async () => true
    })
    const inner = computer as unknown as {
      allowed: { desktop: boolean; terminal: boolean }
      desktopTarget: () => Promise<{ note: null; target: string }>
    }
    inner.allowed = { desktop: true, terminal: false }
    inner.desktopTarget = () => new Promise(resolve => (found = resolve))
    const waiting = computer.run({
      args: { text: 'x' },
      kind: 'desktop',
      request_id: 'd1',
      tool: 'computer_type'
    })
    computer.cancel('d1')
    found({ note: null, target: 'direct:127.0.0.1:3211' })
    await expect(waiting).rejects.toThrow(/stopped/)
  })

  it('keeps desktop work waiting here when the terminal is turned on, and ends it on Stop, a release, or the terminal or desktop turned off', async () => {
    const make = () => {
      // Every lookup waits for one answer: the request's, and the offer's after a save.
      const waiting: ((value: { note: null; target: string }) => void)[] = []
      const answer = { note: null, target: 'direct:127.0.0.1:3211' }
      let answered = false
      const computer = new ThisComputer(join(temp(), 'c.json'), {
        acting: () => {},
        changed: () => {},
        confirm: async () => true
      })
      const inner = computer as unknown as {
        allowed: { desktop: boolean; terminal: boolean }
        desktopTarget: () => Promise<{ note: null; target: string }>
        on: { desktop: boolean; terminal: boolean }
        client: { call: () => Promise<never>; close: () => Promise<void> } | null
      }
      inner.allowed = { desktop: true, terminal: false }
      inner.on = { desktop: true, terminal: false }
      // Past the switch check a request reaches Cua: a fake one, so no Cua runs here.
      inner.client = {
        call: async () => {
          throw new Error('Cua reached')
        },
        close: async () => {}
      }
      // Once answered, a later lookup (the offer's, after the save's write) answers at once.
      inner.desktopTarget = () =>
        answered ? Promise.resolve(answer) : new Promise(resolve => waiting.push(resolve))
      const found = () => {
        answered = true
        waiting.splice(0).forEach(resolve => resolve(answer))
      }
      return { computer, found }
    }
    {
      const kept = make()
      const waiting = kept.computer
        .run({ args: {}, kind: 'desktop', request_id: 'd1', tool: 'computer_screenshot' })
        .catch((error: Error) => error)
      const turnedOn = kept.computer.allow({ terminal: true })
      await new Promise(resolve => setTimeout(resolve, 0))
      kept.found()
      await turnedOn
      // Past the switch, it reaches Cua: not stopped.
      expect(String(await waiting)).toMatch(/Cua reached/)

      // Turning the terminal off takes the screen with it (Computer Use here
      // sits on Let bots work here): desktop work waiting there ends.
      const terminalOff = make()
      ;(terminalOff.computer as unknown as { allowed: object; on: object }).allowed = {
        desktop: true,
        terminal: true
      }
      ;(terminalOff.computer as unknown as { allowed: object; on: object }).on = {
        desktop: true,
        terminal: true
      }
      const stillWaiting = terminalOff.computer
        .run({ args: {}, kind: 'desktop', request_id: 'd3', tool: 'computer_screenshot' })
        .catch((error: Error) => error)
      const turnedTerminalOff = terminalOff.computer.allow({ terminal: false })
      await new Promise(resolve => setTimeout(resolve, 0))
      terminalOff.found()
      await turnedTerminalOff
      expect(terminalOff.computer.allowedNow).toEqual({ desktop: false, terminal: false })
      expect(String(await stillWaiting)).toMatch(
        /stopped|does not let Computer Use reach its screen/
      )

      // A release keeps the switch on: only the desktop's generation ends it.
      const released = make()
      const releasedWork = released.computer
        .run({ args: {}, kind: 'desktop', request_id: 'd5', tool: 'computer_screenshot' })
        .catch((error: Error) => error)
      const releasing = released.computer.release()
      released.found()
      await releasing
      expect(String(await releasedWork)).toMatch(/Bots were stopped on this computer/)

      // Off and on again while it waits: the switch is on, the work still ends.
      const toggled = make()
      // Bots may work here, so its screen can be turned back on.
      ;(toggled.computer as unknown as { allowed: object; on: object }).allowed = {
        desktop: true,
        terminal: true
      }
      ;(toggled.computer as unknown as { allowed: object; on: object }).on = {
        desktop: true,
        terminal: true
      }
      const toggledWork = toggled.computer
        .run({ args: {}, kind: 'desktop', request_id: 'd6', tool: 'computer_screenshot' })
        .catch((error: Error) => error)
      const off = toggled.computer.allow({ desktop: false })
      const on = toggled.computer.allow({ desktop: true })
      await new Promise(resolve => setTimeout(resolve, 0))
      // The lookup answers only once the desktop is on again.
      toggled.found()
      await off
      await on
      expect(String(await toggledWork)).toMatch(/Bots were stopped on this computer/)

      // Stop ends it, whatever was turned off.
      const stopped = make()
      const stoppedWork = stopped.computer
        .run({ args: {}, kind: 'desktop', request_id: 'd4', tool: 'computer_screenshot' })
        .catch((error: Error) => error)
      const stopping = stopped.computer.stop()
      await new Promise(resolve => setTimeout(resolve, 0))
      stopped.found()
      await stopping
      expect(String(await stoppedWork)).toMatch(
        /stopped|does not let Computer Use reach its screen/
      )

      const ended = make()
      const refused = ended.computer
        .run({ args: {}, kind: 'desktop', request_id: 'd2', tool: 'computer_screenshot' })
        .catch((error: Error) => error)
      const turnedOff = ended.computer.allow({ desktop: false })
      await new Promise(resolve => setTimeout(resolve, 0))
      ended.found()
      await turnedOff
      expect(String(await refused)).toMatch(/stopped|does not let Computer Use reach its screen/)
    }
  })

  it('fails a desktop request when Cua cannot start, without crashing the app', async () => {
    const computer = new ThisComputer(join(temp(), 'c.json'), {
      acting: () => {},
      changed: () => {},
      confirm: async () => true
    })
    const inner = computer as unknown as {
      allowed: { desktop: boolean; terminal: boolean }
      desktopTarget: () => Promise<{ note: null; target: string }>
    }
    inner.allowed = { desktop: true, terminal: false }
    inner.desktopTarget = async () => ({ note: null, target: 'direct:127.0.0.1:3211' })
    const previous = process.env.PATH
    process.env.PATH = join(temp(), 'nowhere')
    try {
      // findCua also looks in the usual install folders; this test needs one that can't run.
      const missing = join(temp(), 'cua')
      writeFileSync(missing, 'not a program', { mode: 0o600 })
      process.env.PATH = dirname(missing)
      await expect(
        computer.run({ args: {}, kind: 'desktop', tool: 'computer_screenshot' })
      ).rejects.toThrow()
    } finally {
      process.env.PATH = previous
    }
  })

  it('ends Cua when the daemon stops a desktop action already running there', async () => {
    const computer = new ThisComputer(join(temp(), 'c.json'), {
      acting: () => {},
      changed: () => {},
      confirm: async () => true
    })
    let closed = false
    let finish: (value: unknown) => void = () => {}
    const inner = computer as unknown as {
      allowed: { desktop: boolean; terminal: boolean }
      client: unknown
      desktopTarget: () => Promise<{ note: null; target: string }>
    }
    inner.allowed = { desktop: true, terminal: false }
    inner.desktopTarget = async () => ({ note: null, target: 'direct:127.0.0.1:3211' })
    inner.client = {
      call: () => new Promise((_, reject) => (finish = reject)),
      close: async () => {
        closed = true
        finish(new Error('The desktop connection closed.'))
      }
    }
    const running = computer.run({
      args: {},
      kind: 'desktop',
      request_id: 'k1',
      tool: 'computer_key'
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    computer.cancel('k1')
    await expect(running).rejects.toThrow(/closed/)
    expect(closed).toBe(true)
  })

  it('settles waiting Cua calls when it closes, and sends a final action only on a running Cua', async () => {
    const dir = temp()
    const cua = join(dir, 'cua')
    // A Cua that answers initialize and never answers a "hang" tool.
    writeFileSync(
      cua,
      [
        '#!/usr/bin/env node',
        "let buffer = ''",
        "process.stdin.on('data', chunk => {",
        '  buffer += chunk',
        "  let i; while ((i = buffer.indexOf('\\n')) >= 0) {",
        '    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1)',
        '    if (!line.trim()) continue',
        '    const m = JSON.parse(line)',
        "    if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\\n')",
        "    else if (m.method === 'tools/call' && m.params.name !== 'hang') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { ok: true } }) + '\\n')",
        '  }',
        '})'
      ].join('\n'),
      { mode: 0o755 }
    )
    const client = new DesktopClient(cua, 'direct:127.0.0.1:3211')
    // Not started yet: a final action is refused rather than starting Cua.
    await expect(client.call('computer_key', {}, () => {}, true)).rejects.toThrow(
      /changed before this ran/
    )
    await expect(client.call('computer_get_screen_size', {})).resolves.toEqual({ ok: true })
    await expect(client.call('computer_key', {}, () => {}, true)).resolves.toEqual({ ok: true })
    const started = Date.now()
    const hanging = client.call('hang', {})
    await new Promise(resolve => setTimeout(resolve, 100))
    let exited = false
    const closing = client.close().then(() => (exited = true))
    // A second close while Cua is exiting waits for the same exit.
    let exitedFirst = false
    const second = client.close().then(() => (exitedFirst = exited))
    // The waiting call fails only once Cua has exited.
    await expect(hanging).rejects.toThrow(/closed/)
    await closing
    await second
    expect(exited).toBe(true)
    expect(exitedFirst).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
    // After it closed, a final action needs a running Cua again.
    await expect(client.call('computer_key', {}, () => {}, true)).rejects.toThrow(
      /changed before this ran/
    )
  })

  it('fails a call after a broken pipe only once Cua has exited', async () => {
    const cua = stubbornCua()
    const client = new DesktopClient(cua, 'direct:127.0.0.1:3211')
    await expect(client.call('computer_get_screen_size', {})).resolves.toEqual({ ok: true })
    const child = (
      client as unknown as {
        child: {
          exitCode: null | number
          signalCode: null | string
          stdin: { emit: (e: string, x: Error) => void }
        }
      }
    ).child
    const hanging = client.call('hang', {})
    await new Promise(resolve => setTimeout(resolve, 100))
    const started = Date.now()
    child.stdin.emit('error', new Error('EPIPE'))
    await expect(hanging).rejects.toThrow(/broke: EPIPE/)
    // Cua was ended, and the call failed only after it had exited.
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900)
    await client.close()
  }, 10_000)

  it('keeps answering while Cua writes a lot of log to stderr', async () => {
    const cua = join(temp(), 'cua')
    // A Cua that writes 256 KB of log before each reply: more than a pipe holds.
    writeFileSync(
      cua,
      [
        '#!/usr/bin/env node',
        "const fs = require('fs')",
        "let buffer = ''",
        "process.stdin.on('data', chunk => {",
        '  buffer += chunk',
        "  let i; while ((i = buffer.indexOf('\\n')) >= 0) {",
        '    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1)',
        '    if (!line.trim()) continue',
        '    const m = JSON.parse(line)',
        '    if (m.id === undefined) continue',
        "    fs.writeSync(2, 'x'.repeat(256 * 1024))",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { ok: true } }) + '\\n')",
        '  }',
        '})'
      ].join('\n'),
      { mode: 0o755 }
    )
    const client = new DesktopClient(cua, 'direct:127.0.0.1:3211')
    await expect(client.call('computer_get_screen_size', {})).resolves.toEqual({ ok: true })
    await expect(client.call('computer_get_screen_size', {})).resolves.toEqual({ ok: true })
    await client.close()
  }, 10_000)

  it('confirms a release only once Cua has exited, and kills it at once on quit', async () => {
    const computer = new ThisComputer(join(temp(), 'c.json'), {
      acting: () => {},
      changed: () => {},
      confirm: async () => true
    })
    type Child = { exitCode: null | number; signalCode: null | string }
    const inner = computer as unknown as { client: unknown }
    const up = async () => {
      const client = new DesktopClient(stubbornCua(), 'direct:127.0.0.1:3211')
      await client.call('computer_get_screen_size', {})
      inner.client = client
      return (client as unknown as { child: Child }).child
    }
    const gone = (child: Child) => child.exitCode !== null || child.signalCode !== null
    let child = await up()
    let started = Date.now()
    await computer.release()
    expect(gone(child)).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900)
    child = await up()
    started = Date.now()
    await computer.release(true)
    expect(gone(child)).toBe(true)
    expect(Date.now() - started).toBeLessThan(1500)
  }, 15_000)

  it('never sends a desktop action that ran out of time, even once its lookup finishes', async () => {
    vi.useFakeTimers()
    try {
      const computer = new ThisComputer(join(temp(), 'c.json'), {
        acting: () => {},
        changed: () => {},
        confirm: async () => true
      })
      const calls: unknown[] = []
      const fake = { call: async (...args: unknown[]) => calls.push(args), close: async () => {} }
      let lookedUp: (value: { note: null; target: string }) => void = () => {}
      const inner = computer as unknown as {
        allowed: { desktop: boolean; terminal: boolean }
        client: unknown
        desktopTarget: () => Promise<{ note: null; target: string }>
      }
      inner.allowed = { desktop: true, terminal: false }
      inner.desktopTarget = () => new Promise(resolve => (lookedUp = resolve))
      const running = computer.run({
        args: {},
        kind: 'desktop',
        request_id: 't1',
        tool: 'computer_scroll'
      })
      const settled = expect(running).rejects.toThrow(/too long/)
      await vi.advanceTimersByTimeAsync(75_000)
      await settled
      // Another request has a Cua up by the time the slow lookup returns.
      inner.client = fake
      lookedUp({ note: null, target: 'direct:127.0.0.1:3211' })
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers the desktop the user turned on even before Cua is up, so the daemon never shows it off', async () => {
    const computer = new ThisComputer(join(temp(), 'c.json'), {
      acting: () => {},
      changed: () => {},
      confirm: async () => true
    })
    const inner = computer as unknown as {
      allowed: { desktop: boolean; terminal: boolean }
      desktopTarget: () => Promise<{ note: null | string; target: null | string }>
    }
    inner.allowed = { desktop: true, terminal: false }
    inner.desktopTarget = async () => ({
      note: 'Cua is installed; Set up shares this desktop with it.',
      target: null
    })
    const share = await computer.state()
    expect(share.desktop).toBe(true)
    expect(share.desktopReady).toBe(false)
  })

  it('sends a final desktop action only to the Cua already up, without looking anything up', async () => {
    const computer = new ThisComputer(join(temp(), 'c.json'), {
      acting: () => {},
      changed: () => {},
      confirm: async () => true
    })
    let lookups = 0
    const calls: unknown[] = []
    const inner = computer as unknown as {
      allowed: { desktop: boolean; terminal: boolean }
      client: unknown
      desktopTarget: () => Promise<{ note: null; target: string }>
    }
    inner.allowed = { desktop: true, terminal: false }
    inner.desktopTarget = async () => {
      lookups++
      return { note: null, target: 'direct:127.0.0.1:3211' }
    }
    // No Cua up: refused, nothing looked up or started.
    await expect(
      computer.run({
        args: {},
        final: true,
        kind: 'desktop',
        request_id: 'f1',
        tool: 'computer_key'
      })
    ).rejects.toThrow(/changed before this ran/)
    expect(lookups).toBe(0)
    inner.client = { call: async (...args: unknown[]) => calls.push(args), close: async () => {} }
    await computer.run({
      args: {},
      final: true,
      kind: 'desktop',
      request_id: 'f2',
      tool: 'computer_key'
    })
    expect(lookups).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('refuses desktop work that waited past Stop', async () => {
    const computer = new ThisComputer(join(temp(), 'c.json'), {
      acting: () => {},
      changed: () => {},
      confirm: async () => true
    })
    // Desktop allowed, and finding Cua's target is the wait the user stops in.
    let found: (value: { note: null; target: string }) => void = () => {}
    const inner = computer as unknown as {
      allowed: { desktop: boolean; terminal: boolean }
      desktopTarget: () => Promise<{ note: null; target: string }>
    }
    inner.allowed = { desktop: true, terminal: false }
    let calls = 0
    inner.desktopTarget = () =>
      calls++ === 0
        ? new Promise(resolve => (found = resolve))
        : Promise.resolve({ note: null, target: 'direct:127.0.0.1:3211' })
    const waiting = computer.run({ args: {}, kind: 'desktop', tool: 'computer_screenshot' })
    await computer.stop()
    found({ note: null, target: 'direct:127.0.0.1:3211' })
    await expect(waiting).rejects.toThrow(/does not let Computer Use reach its screen|stopped/)
  })

  it('stops a command at its timeout', async () => {
    const computer = new ThisComputer(join(temp(), 'c.json'), {
      acting: () => {},
      changed: () => {},
      confirm: async () => true
    })
    await computer.allow({ terminal: true })
    const result = (await computer.run({ command: 'sleep 5', kind: 'terminal', timeout: 1 })) as {
      exit_code: number
      timed_out: boolean
    }
    expect(result.timed_out).toBe(true)
    expect(result.exit_code).toBe(124)
  })
})
