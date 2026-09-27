import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { uvAsset } from './uv'
import { performBootstrap, pruneNativeRuntimes, type BootstrapDeps } from './bootstrap'

const migration = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../service', () => ({ migrateLegacyService: migration }))

describe('native runtime bootstrap', () => {
  it('installs verified Rust/Pi and managed code and voice runtimes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hexbot-native-bootstrap-'))
    const oldHome = process.env.HEXBOT_HOME
    process.env.HEXBOT_HOME = join(root, 'home')
    try {
      const source = join(root, 'resources', 'hexbot-native')
      const files: Record<string, string> = {}
      for (const file of ['hexbot', 'hexbot-core', 'node', 'pi/hexbot-pi', 'pi/package-lock.json',
        'pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js']) {
        const path = join(source, file)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, file)
        files[file] = createHash('sha256').update(file).digest('hex')
      }
      await writeFile(join(source, 'manifest.json'), JSON.stringify({ version: '1.0.0', target: 'darwin-arm64', files }))
      const commands: { command: string; args: string[] }[] = []
      const run: BootstrapDeps['run'] = async (command, args, _options, onLine) => {
        commands.push({ command, args })
        if (command === 'tar') {
          const path = join(args[args.indexOf('-C') + 1]!, uvAsset('darwin', 'arm64').directory, 'uv')
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, 'uv')
        }
        if (args[0] === 'python' && args[1] === 'find') {
          const python = join(root, 'home', 'python', 'managed', 'bin', 'python3.11')
          await mkdir(dirname(python), { recursive: true })
          await writeFile(python, '#!/bin/sh')
          onLine?.(python)
        }
        if (args[0] === 'tool' && args[1] === 'install')
          await writeFile(join(root, 'home', 'bin', 'edge-tts'), '#!/bin/sh')
      }
      const piRuns = (): number => commands.filter(item => item.command.endsWith('/pi/hexbot-pi')).length
      const options = { appIsPackaged: true, appVersion: '1.0.0', resourcesPath: join(root, 'resources'),
        exists: existsSync, run, download: async () => uvAsset('darwin', 'arm64').sha256, platform: 'darwin' as const, arch: 'arm64' }
      migration.mockRejectedValueOnce(new Error('service unavailable'))
      await performBootstrap(options)
      let installed = join(root, 'home/runtime/native/1.0.0')
      const stable = join(root, 'home/runtime/native-executable')
      expect(await realpath(stable)).toBe(await realpath(join(installed, 'hexbot')))
      expect(await readFile(join(installed, 'hexbot-core'), 'utf8')).toBe('hexbot-core')
      expect(piRuns()).toBe(1)
      expect(commands.some(item => item.args.includes('edge-tts==7.2.7'))).toBe(true)
      expect(commands.some(item => item.args[0] === 'sync')).toBe(false)
      const setupCalls = commands.length
      await performBootstrap(options)
      expect(commands).toHaveLength(setupCalls)
      await writeFile(join(installed, 'hexbot-core'), 'broken')
      await performBootstrap(options)
      expect(piRuns()).toBe(2)
      installed = dirname(await realpath(stable))
      expect(await readFile(join(installed, 'hexbot-core'), 'utf8')).toBe('hexbot-core')
      // Reopening this app preserves a newer verified service update.
      const newer = join(root, 'home/runtime/native/2.0.0')
      await cp(installed, newer, { recursive: true })
      await writeFile(join(newer, 'manifest.json'), JSON.stringify({ version: '2.0.0', target: 'darwin-arm64', files }))
      await rm(stable)
      await symlink(await realpath(join(newer, 'hexbot')), stable)
      await writeFile(join(root, 'home/runtime/native-current.json'), JSON.stringify({
        version: '2.0.0', executable: await realpath(join(newer, 'hexbot'))
      }))
      await performBootstrap(options)
      expect(await realpath(stable)).toBe(await realpath(join(newer, 'hexbot')))
      // Installing a newer app advances past the old service update.
      await writeFile(join(source, 'manifest.json'), JSON.stringify({ version: '3.0.0', target: 'darwin-arm64', files }))
      await performBootstrap({ ...options, appVersion: '3.0.0' })
      const newest = join(root, 'home/runtime/native/3.0.0/hexbot')
      expect(await realpath(stable)).toBe(await realpath(newest))
      expect(existsSync(installed)).toBe(false)
      expect(existsSync(newer)).toBe(true)
      await writeFile(join(source, 'manifest.json'), JSON.stringify({ version: '1.0.0', target: 'darwin-arm64', files }))
      await performBootstrap(options)
      expect(await realpath(stable)).toBe(await realpath(newest))
      await writeFile(join(source, 'manifest.json'), JSON.stringify({ version: '3.0.0', target: 'darwin-arm64', files }))
      await writeFile(join(source, 'pi/hexbot-pi'), 'broken')
      await expect(performBootstrap({ ...options, appVersion: '3.0.0' })).rejects.toThrow('checksum failed')
      expect(await realpath(stable)).toBe(await realpath(newest))
    } finally {
      if (oldHome === undefined) delete process.env.HEXBOT_HOME
      else process.env.HEXBOT_HOME = oldHome
      await rm(root, { recursive: true, force: true })
    }
  })
})

it.skipIf(!process.env.HEXBOT_NATIVE_TEST_BUNDLE)('boots a real packaged native runtime in an isolated home', async () => {
  const source = process.env.HEXBOT_NATIVE_TEST_BUNDLE!
  const metadata = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')) as { version: string }
  const root = await mkdtemp(join(tmpdir(), 'hexbot native installed '))
  const oldHome = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = root
  try {
    await performBootstrap({ appIsPackaged: true, appVersion: metadata.version,
      resourcesPath: dirname(source), platform: process.platform, arch: process.arch })
    const { execFile, spawn } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const launcher = join(root, 'runtime/native-executable')
    const result = await promisify(execFile)(launcher, ['version'])
    expect(result.stdout.trim()).toBe(metadata.version)
    const pi = await promisify(execFile)(join(root, 'runtime/native', metadata.version, 'pi/hexbot-pi'), ['--version'])
    expect(pi.stdout).toContain('0.87.1')
    const daemon = spawn(launcher, ['serve', '--port', '0', '--host', '127.0.0.1'], {
      env: { ...process.env, HEXBOT_HOME: root }, stdio: ['ignore', 'pipe', 'pipe']
    })
    const stopped = new Promise<void>(resolve => daemon.once('exit', () => resolve()))
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Packaged daemon did not become ready')), 20_000)
        let output = ''
        daemon.stdout.on('data', chunk => {
          output += chunk.toString()
          const match = /HERMES_BACKEND_READY port=(\d+)/.exec(output)
          if (match) { clearTimeout(timeout); resolve(Number(match[1])) }
        })
        daemon.once('error', error => { clearTimeout(timeout); reject(error) })
        daemon.once('exit', code => { clearTimeout(timeout); reject(new Error(`Packaged daemon exited ${code}`)) })
      })
      const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(10_000) })
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('<!doctype html>')
    } finally {
      daemon.kill('SIGTERM')
      const kill = setTimeout(() => daemon.kill('SIGKILL'), 10_000)
      await stopped
      clearTimeout(kill)
    }
    const code = await promisify(execFile)(join(root, 'bin/python3.11'), ['-c', 'print(6 * 7)'])
    expect(code.stdout.trim()).toBe('42')
    const voice = await promisify(execFile)(join(root, 'bin/edge-tts'), ['--version'])
    expect(voice.stdout).toContain('7.2.7')
  } finally {
    if (oldHome === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = oldHome
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)

it('pruning protects a running runtime until its process has exited', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-prune-'))
  const oldHome = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = root
  try {
    const native = join(root, 'runtime/native')
    const paths = ['old-random', 'unused-random', 'previous-random', 'active-random'].map(name => join(native, name, 'hexbot'))
    for (const path of paths) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'runtime')
    }
    const actual = await Promise.all(paths.map(path => realpath(path)))
    const marker = join(root, 'runtime/native-running.json')
    await writeFile(marker, JSON.stringify({ pid: process.pid, executable: actual[0] }))
    await pruneNativeRuntimes(actual[3]!, actual[2])
    expect(existsSync(paths[0]!)).toBe(true)
    expect(existsSync(paths[1]!)).toBe(false)
    await writeFile(marker, JSON.stringify({ pid: process.pid, executable: join(root, 'missing') }))
    await pruneNativeRuntimes(actual[3]!, actual[2])
    expect(existsSync(paths[0]!)).toBe(true)
    await writeFile(marker, 'broken metadata')
    await pruneNativeRuntimes(actual[3]!, actual[2])
    expect(existsSync(paths[0]!)).toBe(true)
    await writeFile(marker, JSON.stringify({ pid: 2147483647, executable: actual[0] }))
    await writeFile(join(root, 'native-daemon.lock'), String(process.pid))
    await pruneNativeRuntimes(actual[3]!, actual[2])
    expect(existsSync(paths[0]!)).toBe(true)
    await rm(join(root, 'native-daemon.lock'))
    await rm(marker)
    await pruneNativeRuntimes(actual[3]!, actual[2])
    expect(existsSync(paths[0]!)).toBe(false)
    expect(existsSync(paths[2]!)).toBe(true)
    expect(existsSync(paths[3]!)).toBe(true)
    const { rename } = await import('node:fs/promises')
    const moved = join(root, 'elsewhere')
    await rename(native, moved)
    await symlink(moved, native)
    await expect(pruneNativeRuntimes(actual[3]!, actual[2])).rejects.toThrow('symbolic links')
    expect(existsSync(join(moved, 'previous-random/hexbot'))).toBe(true)
  } finally {
    if (oldHome === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = oldHome
    await rm(root, { recursive: true, force: true })
  }
})
