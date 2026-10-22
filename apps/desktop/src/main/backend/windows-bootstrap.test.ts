import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { performBootstrap } from './bootstrap'
import { hexbotHome, nativeServiceExecutable } from './paths'
vi.mock('../service', () => ({ migrateLegacyService: async () => undefined }))

describe.skipIf(process.platform !== 'win32' || !process.env.HEXBOT_NATIVE_TEST_BUNDLE)('real Windows Full bootstrap', () => {
  it('activates the same verified EXE Headless selects, without a stable EXE or symlink', async () => {
    const bundle = process.env.HEXBOT_NATIVE_TEST_BUNDLE!
    const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')) as { version: string }
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
    try {
      await performBootstrap({ emit: event => progress.push(event.stage), appIsPackaged: true, appVersion: manifest.version, resourcesPath: dirname(bundle), platform: 'win32', arch: 'x64' })
      expect(progress.at(-1)).toBe('done')
      await expect(readFile(join(decoy, '.hexbot/runtime/native-current.json'))).rejects.toThrow()
      const exe = nativeServiceExecutable()
      expect(exe.endsWith('hexbot.exe')).toBe(true)
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      expect((await promisify(execFile)(exe, ['version'])).stdout.trim()).toBe(manifest.version)
      await performBootstrap({ emit: event => progress.push(event.stage), appIsPackaged: true, appVersion: manifest.version, resourcesPath: dirname(bundle), platform: 'win32', arch: 'x64' })
      expect(nativeServiceExecutable()).toBe(exe)
      await expect(readFile(join(chosen, 'runtime/native-executable.exe'))).rejects.toThrow()
      const older = join(root, 'older runtime')
      await cp(bundle, older, { recursive: true })
      const metadata = JSON.parse(await readFile(join(older, 'manifest.json'), 'utf8')) as Record<string, unknown>
      await writeFile(join(older, 'manifest.json'), JSON.stringify({ ...metadata, builtAt: 1 }))
      await expect(promisify(execFile)(join(older, 'hexbot.exe'), ['setup', '--activate', '--no-code-tools', '--json'], { env: { ...process.env, HEXBOT_HOME: chosen } })).rejects.toThrow()
      expect(nativeServiceExecutable()).toBe(exe)
    } finally {
      process.env = previous
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)
})
