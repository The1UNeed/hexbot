import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { performBootstrap, runChild } from './bootstrap'
import { hexbotHome, nativeServiceExecutable } from './paths'
vi.mock('../service', () => ({ migrateLegacyService: async () => undefined }))

describe.skipIf(process.platform !== 'win32' || !process.env.HEXBOT_NATIVE_TEST_BUNDLE)('real Windows Full bootstrap', () => {
  it('activates the same verified EXE Headless selects, without a stable EXE or symlink', async () => {
    const bundle = process.env.HEXBOT_NATIVE_TEST_BUNDLE!
    const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')) as { version: string; target: string; builtAt?: number }
    const root = await mkdtemp(join(tmpdir(), 'hexbot Windows Full '))
    const previous = { ...process.env }
    process.env.HEXBOT_CLI_NO_PATH = '1'
    const profile = join(root, 'José profile with spaces')
    const decoy = join(root, 'Git Bash HOME')
    await mkdir(profile)
    await mkdir(decoy)
    delete process.env.HEXBOT_HOME
    process.env.USERPROFILE = profile
    process.env.HOME = decoy
    const chosen = hexbotHome()
    expect(chosen).toBe(join(profile, '.hexbot'))
    const progress: string[] = []
    const events: unknown[] = []
    const output: string[] = []
    const secretValues = Object.entries(previous)
      .filter(([name, value]) => /token|secret|password|credential|api_?key/i.test(name) && value && value.length >= 8)
      .map(([, value]) => value!)
    const redact = (text: string): string => {
      for (const value of secretValues) text = text.replaceAll(value, '[redacted]')
      return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
        .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, '$1 [redacted]')
    }
    const emit = (event: { stage: string; message: string }): void => {
      progress.push(event.stage)
      events.push({ stage: event.stage, message: redact(event.message).slice(-512) })
      if (events.length > 32) events.shift()
    }
    // Capture only this disposable test's child output. Production logging and
    // Pi stderr privacy are unchanged; failures still throw the original error.
    const run: typeof runChild = async (command, args, options = {}, onLine) => {
      events.push({ command, args: args.slice(0, 16).map(value => redact(value).slice(0, 1024)),
        home: options.env?.HEXBOT_HOME ?? chosen, cwd: options.cwd })
      if (events.length > 32) events.shift()
      await runChild(command, args, options, line => {
        output.push(redact(line).slice(-1024))
        while (output.join('\n').length > 8192) output.shift()
        onLine?.(line)
      })
    }
    try {
      await performBootstrap({ run, emit, appIsPackaged: true, appVersion: manifest.version, resourcesPath: dirname(bundle), platform: 'win32', arch: 'x64' })
      expect(progress.at(-1)).toBe('done')
      await expect(readFile(join(decoy, '.hexbot/runtime/native-current.json'))).rejects.toThrow()
      const exe = nativeServiceExecutable()
      expect(exe.endsWith('hexbot.exe')).toBe(true)
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      expect((await promisify(execFile)(exe, ['version'])).stdout.trim()).toBe(manifest.version)
      await performBootstrap({ run, emit, appIsPackaged: true, appVersion: manifest.version, resourcesPath: dirname(bundle), platform: 'win32', arch: 'x64' })
      expect(nativeServiceExecutable()).toBe(exe)
      await expect(readFile(join(chosen, 'runtime/native-executable.exe'))).rejects.toThrow()
      const older = join(root, 'older runtime')
      await cp(bundle, older, { recursive: true })
      const metadata = JSON.parse(await readFile(join(older, 'manifest.json'), 'utf8')) as Record<string, unknown>
      await writeFile(join(older, 'manifest.json'), JSON.stringify({ ...metadata, builtAt: 1 }))
      await expect(promisify(execFile)(join(older, 'hexbot.exe'), ['setup', '--activate', '--no-code-tools', '--json'], { env: { ...process.env, HEXBOT_HOME: chosen } })).rejects.toThrow()
      expect(nativeServiceExecutable()).toBe(exe)
    } catch (error) {
      const selected = await readFile(join(chosen, 'runtime/native-current.json'), 'utf8').then(JSON.parse).catch(() => undefined) as { executable?: string; builtAt?: number } | undefined
      const bootstrapTail = await readFile(join(chosen, 'logs/bootstrap.log'), 'utf8').then(text => redact(text.slice(-8192))).catch(() => undefined)
      console.error('Isolated Windows bootstrap failure:', JSON.stringify({
        home: chosen, manifest: { version: manifest.version, target: manifest.target, builtAt: manifest.builtAt },
        selection: selected && { executable: selected.executable, builtAt: selected.builtAt },
        events, outputTail: output.join('\n'), bootstrapTail
      }))
      throw error
    } finally {
      process.env = previous
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)
})
