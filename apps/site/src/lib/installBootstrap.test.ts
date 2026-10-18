import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The real Windows PowerShell host, a local update origin, and a tiny native
// executable exercise the download boundary without a published release.
describe.skipIf(process.platform !== 'win32')('Windows terminal bootstrap', () => {
  let temporary: string
  let executable: Buffer
  let checksum: string
  let server: Server
  let base: string
  let index: string
  let redirect = false
  let stableStatus = 404
  let indexStatus = 200
  let executableStatus = 200
  const requests: string[] = []
  let result: string
  let withoutHashCmdlet: string
  const bootstrap = fileURLToPath(new URL('../../public/install.ps1', import.meta.url))
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

  beforeAll(async () => {
    const host = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' })
    expect(host.status, host.stderr).toBe(0)
    expect(host.stdout.trim()).toMatch(/^5\.1\./)
    temporary = await mkdtemp(join(tmpdir(), 'hexbot-bootstrap-test-'))
    const source = join(temporary, 'installer.cs')
    const target = join(temporary, 'installer.exe')
    result = join(temporary, 'result.txt')
    withoutHashCmdlet = join(temporary, 'without-hash-cmdlet.ps1')
    await writeFile(withoutHashCmdlet, `function Get-FileHash { throw 'Get-FileHash is unavailable in this host.' }\n& ${quote(bootstrap)} @args\n`)
    await writeFile(source, 'using System; using System.IO; public class Installer { public static int Main(string[] args) { File.WriteAllText(Environment.GetEnvironmentVariable("HEXBOT_BOOTSTRAP_RESULT"), String.Join("|", args)); return 0; } }')
    const compiled = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition ([IO.File]::ReadAllText(${quote(source)})) -OutputAssembly ${quote(target)} -OutputType ConsoleApplication`], { encoding: 'utf8' })
    expect(compiled.status, compiled.stderr).toBe(0)
    executable = await readFile(target)
    checksum = createHash('sha256').update(executable).digest('hex')
    server = createServer((request, response) => {
      requests.push(request.url ?? '')
      if (request.url === '/install/stable.json') { response.writeHead(stableStatus).end('{}'); return }
      if (request.url === '/install/nightly.txt') { response.writeHead(indexStatus).end(index); return }
      if (request.url === '/installer.exe') {
        if (redirect) response.writeHead(302, { Location: `${base}/redirected.exe` }).end()
        else response.writeHead(executableStatus).end(executable)
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test server address')
    base = `http://127.0.0.1:${address.port}`
  }, 30_000)

  beforeEach(() => {
    index = `windows-x86_64 ${checksum} ${base}/installer.exe\n`
    stableStatus = 404
    indexStatus = 200
    executableStatus = 200
    redirect = false
    requests.length = 0
  })

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    if (temporary) await rm(temporary, { recursive: true, force: true })
  })

  async function run(script = bootstrap) {
    await rm(result, { force: true })
    return new Promise<{ status: number; output: string }>(resolve => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '--headless', '--yes'], {
        env: { ...process.env, HEXBOT_UPDATE_URL: base, HEXBOT_TRACK: '', HEXBOT_BOOTSTRAP_RESULT: result },
        timeout: 20_000,
      }, (error, stdout, stderr) => resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stdout}${stderr}` }))
    })
  }

  it('falls back only from missing stable metadata and preserves installer arguments', async () => {
    const { status, output } = await run()
    expect(status, output).toBe(0)
    expect(await readFile(result, 'utf8')).toBe('--headless|--yes')
    expect(requests).toEqual(['/install/stable.json', '/install/nightly.txt', '/installer.exe'])
  }, 30_000)

  it('verifies downloaded bytes without the Get-FileHash cmdlet', async () => {
    const { status, output } = await run(withoutHashCmdlet)
    expect(status, output).toBe(0)
    expect(await readFile(result, 'utf8')).toBe('--headless|--yes')

    index = `windows-x86_64 ${'0'.repeat(64)} ${base}/installer.exe\n`
    const failed = await run(withoutHashCmdlet)
    expect(failed.status).not.toBe(0)
    expect(failed.output).toContain('The installer checksum does not match.')
    await expect(readFile(result)).rejects.toThrow()
  }, 30_000)

  it('requires HTTP 200 and never falls back from a stable server error', async () => {
    stableStatus = 503
    expect((await run()).status).not.toBe(0)
    expect(requests).toEqual(['/install/stable.json'])
    await expect(readFile(result)).rejects.toThrow()

    stableStatus = 204
    requests.length = 0
    expect((await run()).status).not.toBe(0)
    expect(requests).toEqual(['/install/stable.json'])

    stableStatus = 404
    indexStatus = 201
    expect((await run()).status).not.toBe(0)
    await expect(readFile(result)).rejects.toThrow()

    indexStatus = 200
    executableStatus = 201
    expect((await run()).status).not.toBe(0)
    await expect(readFile(result)).rejects.toThrow()
  }, 30_000)

  it('does not run a checksum mismatch, duplicate target, off-origin URL, or redirect', async () => {
    for (const invalid of [
      `windows-x86_64 ${'0'.repeat(64)} ${base}/installer.exe\n`,
      `windows-x86_64 ${checksum} ${base}/installer.exe\nwindows-x86_64 ${checksum} ${base}/installer.exe\n`,
      `windows-x86_64 ${checksum} https://example.invalid/installer.exe\n`,
    ]) {
      index = invalid
      expect((await run()).status).not.toBe(0)
      await expect(readFile(result)).rejects.toThrow()
    }
    index = `windows-x86_64 ${checksum} ${base}/installer.exe\n`
    redirect = true
    try {
      expect((await run()).status).not.toBe(0)
      await expect(readFile(result)).rejects.toThrow()
    } finally { redirect = false }
  }, 30_000)
})
