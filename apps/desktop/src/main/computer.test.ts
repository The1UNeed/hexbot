import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { fetchLocal, readChoice, runRequest, runShell, Screen, writeChoice } from './computer'

const dirs: string[] = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexbot-lend-'))
  dirs.push(dir)

  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('lending this computer', () => {
  it('keeps the choice, and never the screen without the computer', () => {
    const dir = temp()
    expect(readChoice(dir)).toEqual({ on: false, screen: false })
    expect(writeChoice(dir, { on: false, screen: true })).toEqual({ on: false, screen: false })
    writeChoice(dir, { on: true, screen: true })
    expect(readChoice(dir)).toEqual({ on: true, screen: true })
  })

  it('refuses everything once the user stops lending, and the screen unless lent', async () => {
    const dir = temp()
    const screen = new Screen()
    await expect(
      runRequest({ command: 'echo hi', kind: 'shell', level: 'none' }, { dataDir: dir, home: dir, screen })
    ).rejects.toThrow(/no longer lent/)
    writeChoice(dir, { on: true, screen: false })
    await expect(
      runRequest({ kind: 'mcp', tool: 'computer_screenshot' }, { dataDir: dir, home: dir, screen })
    ).rejects.toThrow(/not its screen/)
    await expect(screen.call('computer_shell', {})).rejects.toThrow(/Only screen tools/)
  })

  it('fetches a preview from this computer\'s loopback only, by port', async () => {
    const seen: string[] = []
    const fetcher = (async (url: string) => {
      seen.push(url)

      return new Response('hi', {
        headers: { 'content-encoding': 'gzip', 'content-type': 'text/html' },
        status: 200
      })
    }) as unknown as typeof fetch
    const page = await fetchLocal({ method: 'GET', path: '/app?x=1', port: 5173 }, fetcher)
    expect(seen).toEqual(['http://127.0.0.1:5173/app?x=1'])
    expect(page.status).toBe(200)
    expect(Buffer.from(page.body, 'base64').toString()).toBe('hi')
    // The body arrives decompressed, so the header goes.
    expect(page.headers.map(([name]) => name)).not.toContain('content-encoding')
    await fetchLocal({ path: '//evil.example/x', port: 80 }, fetcher)
    expect(seen.at(-1)).toBe('http://127.0.0.1:80//evil.example/x')
    await expect(fetchLocal({ port: 0 }, fetcher)).rejects.toThrow(/port/)
  })

  it('stops a command and everything it started at its timeout', async () => {
    const home = temp()
    const started = Date.now()
    // A child holds the pipes open long after the shell would be killed.
    const result = await runShell(
      { command: 'sleep 30 & sleep 30; echo late', level: 'none', timeout: 1 },
      home
    )
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.exit_code).toBe(124)
    expect(result.output).toContain('[Stopped after 1 s.]')
    expect(result.output).not.toContain('late')
  })

  it('runs a command in the workspace and reports its exit code', async () => {
    const home = temp()
    const result = await runShell({ command: 'pwd; exit 3', level: 'none' }, home)
    expect(result.exit_code).toBe(3)
    expect(result.output.trim()).toBe(join(homedir(), 'Hexbot'))
  })

  it.runIf(process.platform === 'darwin')(
    'keeps a confined command off the network and out of other folders',
    async () => {
      const home = temp()
      // Temp folders are writable in the sandbox; the home is not.
      const outside = mkdtempSync(join(homedir(), '.hexbot-lend-outside-'))
      dirs.push(outside)
      const write = await runShell(
        { command: `touch ${join(outside, 'x')} && echo wrote`, level: 'confined' },
        home
      )
      expect(write.output).not.toContain('wrote')
      expect(write.exit_code).not.toBe(0)
      const net = await runShell(
        { command: 'curl -sS -m 5 https://example.com >/dev/null && echo reached', level: 'confined' },
        home
      )
      expect(net.output).not.toContain('reached')
      // Read only: not even the workspace.
      const readOnly = await runShell(
        { command: 'touch "$HOME/Hexbot/.hexbot-lend-probe" && echo wrote', level: 'confined', read_only: true },
        home
      )
      expect(readOnly.output).not.toContain('wrote')
    }
  )
})
