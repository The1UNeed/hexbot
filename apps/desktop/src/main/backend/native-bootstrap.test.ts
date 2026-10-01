import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { runningDaemonPort } from './manager'
import { toolAsset, type Tool } from './tools'
import { performBootstrap, pruneNativeRuntimes, type BootstrapDeps } from './bootstrap'

const migration = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../service', () => ({ migrateLegacyService: migration }))

const bundleFiles = ['hexbot', 'hexbot-core', 'node', 'pi/hexbot-pi', 'pi/package-lock.json',
  'pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js']
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

// A fake full-package home: the app bundle under resources and a mocked uv, tar and Pi.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-native-bootstrap-'))
  const home = join(root, 'home')
  const source = join(root, 'resources', 'hexbot-native')
  const files: Record<string, string> = {}
  for (const file of bundleFiles) {
    await mkdir(dirname(join(source, file)), { recursive: true })
    await writeFile(join(source, file), file)
    files[file] = sha256(file)
  }
  const bundle = async (version: string, builtAt?: number): Promise<void> =>
    writeFile(join(source, 'manifest.json'), JSON.stringify({ version, target: 'darwin-arm64', files, builtAt }))
  const commands: { command: string; args: string[] }[] = []
  const run: BootstrapDeps['run'] = async (command, args, _options, onLine) => {
    commands.push({ command, args })
    if (command === 'tar') {
      const path = join(args[args.indexOf('-C') + 1]!, args.at(-1)!)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'tool')
    }
    if (args[0] === 'python' && args[1] === 'find') {
      const python = join(home, 'python', 'managed', 'bin', 'python3.11')
      await mkdir(dirname(python), { recursive: true })
      await writeFile(python, '#!/bin/sh')
      onLine?.(python)
    }
    if (args[0] === 'venv') await mkdir(join(args.at(-1)!, 'bin'), { recursive: true })
    if (args[0] === 'pip') await writeFile(join(dirname(args[args.indexOf('--python') + 1]!), 'edge-tts'), '#!/bin/sh')
  }
  const downloads: string[] = []
  const download = async (url: string): Promise<string> => {
    downloads.push(url)
    return (['uv', 'rg', 'fd'] as Tool[]).map(tool => toolAsset(tool, 'darwin', 'arm64')).find(asset => asset.url === url)!.sha256
  }
  const options = (appVersion: string): Partial<BootstrapDeps> => ({ appIsPackaged: true, appVersion,
    resourcesPath: join(root, 'resources'), exists: existsSync, run, download, platform: 'darwin', arch: 'arm64' })
  const probes = (): number => commands.filter(item => item.command.endsWith('/pi/hexbot-pi')).length
  const stable = join(home, 'runtime/native-executable')
  const selected = async (): Promise<string> => dirname(await realpath(stable))
  const oldHome = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  const close = async (): Promise<void> => {
    if (oldHome === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = oldHome
    await rm(root, { recursive: true, force: true })
  }
  return { root, home, source, files, bundle, commands, downloads, run, options, probes, stable, selected, close }
}

describe('native runtime bootstrap', () => {
  it('installs verified Rust/Pi and hash-locked code and voice runtimes', async () => {
    const f = await fixture()
    try {
      await f.bundle('1.0.0', 100)
      migration.mockRejectedValueOnce(new Error('service unavailable'))
      const progress: { stage: string; message: string }[] = []
      await performBootstrap({ ...f.options('1.0.0'), emit: value => progress.push(value) })
      expect([...new Set(progress.map(value => value.stage))]).toEqual(['runtime', 'uv', 'python', 'dependencies', 'done'])
      let installed = join(f.home, 'runtime/native/1.0.0')
      expect(await f.selected()).toBe(await realpath(installed))
      expect(await readFile(join(installed, 'hexbot-core'), 'utf8')).toBe('hexbot-core')
      expect(f.probes()).toBe(1)
      expect(f.commands.some(item => item.command.endsWith('/hexbot') && item.args[0] === 'version')).toBe(true)
      // The bundle ships verified search tools; first launch downloads only the installer.
      expect(f.downloads).toEqual([toolAsset('uv', 'darwin', 'arm64').url])
      for (const tool of ['rg', 'fd']) expect(existsSync(join(f.home, 'bin', tool))).toBe(false)
      const pip = f.commands.find(item => item.args[0] === 'pip')!.args
      expect(pip).toEqual(expect.arrayContaining(['--require-hashes', '--no-deps', '--no-build']))
      expect(await readFile(pip.at(-1)!, 'utf8')).toMatch(/^edge-tts==7\.2\.7 \\\n {4}--hash=sha256:[a-f0-9]{64}$/m)
      expect(f.commands.some(item => item.args[0] === 'tool' || item.args[0] === 'sync')).toBe(false)
      expect(existsSync(join(f.home, 'bin/edge-tts'))).toBe(true)

      // A second launch copies, probes and installs nothing.
      const setupCalls = f.commands.length
      await performBootstrap(f.options('1.0.0'))
      expect(f.commands).toHaveLength(setupCalls)

      // A voice install from an earlier build, without the lock receipt, is replaced.
      await rm(join(f.home, 'runtime/tools/edge-tts.requirements.txt'))
      await performBootstrap(f.options('1.0.0'))
      expect(f.commands.slice(setupCalls).map(item => item.args[0])).toEqual(['venv', 'pip'])

      // A damaged runtime is copied again from the verified bundle.
      await writeFile(join(installed, 'hexbot-core'), 'broken')
      await performBootstrap(f.options('1.0.0'))
      expect(f.probes()).toBe(2)
      installed = await f.selected()
      expect(await readFile(join(installed, 'hexbot-core'), 'utf8')).toBe('hexbot-core')

      await writeFile(join(f.source, 'pi/hexbot-pi'), 'broken')
      await f.bundle('3.0.0', 300)
      await expect(performBootstrap(f.options('3.0.0'))).rejects.toThrow('checksum failed')
      expect(await f.selected()).toBe(installed)
    } finally {
      await f.close()
    }
  })

  it('keeps the newest build across channels and never copies a runtime it will not use', async () => {
    const f = await fixture()
    try {
      await f.bundle('0.1.6-alpha.1', 100)
      await performBootstrap(f.options('0.1.6-alpha.1'))
      await f.bundle('0.1.6-nightly.20261001.1', 200)
      await performBootstrap(f.options('0.1.6-nightly.20261001.1'))
      // semver sorts this nightly above alpha.2; the later build must still win.
      await f.bundle('0.1.6-alpha.2', 300)
      await performBootstrap(f.options('0.1.6-alpha.2'))
      expect(await f.selected()).toBe(await realpath(join(f.home, 'runtime/native/0.1.6-alpha.2')))
      expect(f.probes()).toBe(3)

      // Reopening the older Nightly app keeps the newer runtime without copying or probing.
      await f.bundle('0.1.6-nightly.20261001.1', 200)
      const before = await readdir(join(f.home, 'runtime/native'))
      for (let launch = 0; launch < 3; launch += 1) await performBootstrap(f.options('0.1.6-nightly.20261001.1'))
      expect(await f.selected()).toBe(await realpath(join(f.home, 'runtime/native/0.1.6-alpha.2')))
      expect(await readdir(join(f.home, 'runtime/native'))).toEqual(before)
      expect(f.probes()).toBe(3)
    } finally {
      await f.close()
    }
  })

  it('keeps a newer signed service update when an older app opens', async () => {
    const f = await fixture()
    try {
      await f.bundle('2.0.0', 200)
      await performBootstrap(f.options('2.0.0'))
      // Signing changes Node and the daemon after the staging manifest was written.
      const updated = join(f.home, 'runtime/native/2.0.0-update')
      await cp(await f.selected(), updated, { recursive: true })
      await writeFile(join(updated, 'node'), 'signed node')
      await writeFile(join(updated, 'hexbot-core'), 'signed daemon')
      await writeFile(join(updated, 'manifest.json'), JSON.stringify({ version: '3.0.0', target: 'darwin-arm64', builtAt: 300,
        files: { ...f.files, node: sha256('signed node'), 'hexbot-core': sha256('signed daemon') } }))
      await rm(f.stable)
      await symlink(await realpath(join(updated, 'hexbot')), f.stable)
      await writeFile(join(f.home, 'runtime/native-current.json'), JSON.stringify({
        version: '3.0.0', executable: await realpath(join(updated, 'hexbot')),
        files: { ...f.files, node: sha256('signed node'), 'hexbot-core': sha256('signed daemon') }
      }))
      for (let launch = 0; launch < 3; launch += 1) await performBootstrap(f.options('2.0.0'))
      expect(await f.selected()).toBe(await realpath(updated))
      expect(f.probes()).toBe(1)
    } finally {
      await f.close()
    }
  })

  it('reports a runtime this system cannot start and keeps the current one', async () => {
    const f = await fixture()
    try {
      await f.bundle('1.0.0', 100)
      await performBootstrap(f.options('1.0.0'))
      const installed = await f.selected()
      await f.bundle('2.0.0', 200)
      const run: BootstrapDeps['run'] = async (command, args, options, onLine) => {
        if (command.endsWith('/hexbot') && args[0] === 'version') {
          onLine?.("hexbot-core: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34' not found")
          throw new Error(`${command} exited with code 1`)
        }
        return f.run(command, args, options, onLine)
      }
      await expect(performBootstrap({ ...f.options('2.0.0'), run }))
        .rejects.toThrow("This system cannot run the Hexbot runtime: hexbot-core: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34' not found")
      expect(await f.selected()).toBe(installed)
    } finally {
      await f.close()
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
      expect(await runningDaemonPort(root)).toBe(port)
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
    for (const tool of ['rg', 'fd']) {
      const version = await promisify(execFile)(join(root, 'runtime/native', metadata.version, 'bin', tool), ['--version'])
      expect(version.stdout).toContain(toolAsset(tool as Tool, process.platform, process.arch).version)
    }
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
