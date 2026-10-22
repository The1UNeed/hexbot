import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { performBootstrap } from './bootstrap'
import { nativeServiceExecutable } from './paths'
vi.mock('../service', () => ({ migrateLegacyService: async () => undefined }))

describe.skipIf(process.platform !== 'win32' || !process.env.HEXBOT_NATIVE_TEST_BUNDLE)('real Windows Full bootstrap', () => {
  it('activates the same verified EXE Headless selects, without a stable EXE or symlink', async () => {
    const bundle = process.env.HEXBOT_NATIVE_TEST_BUNDLE!
    const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')) as { version: string }
    const root = await mkdtemp(join(tmpdir(), 'hexbot Windows Full '))
    const previous = { home: process.env.HEXBOT_HOME, user: process.env.HOME }
    process.env.HEXBOT_HOME = join(root, 'home')
    process.env.HOME = root
    try {
      await performBootstrap({ appIsPackaged: true, appVersion: manifest.version, resourcesPath: dirname(bundle), platform: 'win32', arch: 'x64' })
      const exe = nativeServiceExecutable()
      expect(exe.endsWith('hexbot.exe')).toBe(true)
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      expect((await promisify(execFile)(exe, ['version'])).stdout.trim()).toBe(manifest.version)
      await performBootstrap({ appIsPackaged: true, appVersion: manifest.version, resourcesPath: dirname(bundle), platform: 'win32', arch: 'x64' })
      expect(nativeServiceExecutable()).toBe(exe)
    } finally {
      if (previous.home === undefined) delete process.env.HEXBOT_HOME; else process.env.HEXBOT_HOME = previous.home
      if (previous.user === undefined) delete process.env.HOME; else process.env.HOME = previous.user
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)
})
