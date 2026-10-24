import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { runningDaemonPort } from './manager'
import { toolAsset, type Tool } from './tools'
import { performBootstrap, pruneNativeRuntimes, runChild, type BootstrapDeps } from './bootstrap'

const migration = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../service', () => ({ migrateLegacyService: migration }))

const bundleFiles = [
  'hexbot',
  'hexbot-core',
  'node',
  'pi/hexbot-pi',
  'pi/package-lock.json',
  'pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
]
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
    writeFile(
      join(source, 'manifest.json'),
      JSON.stringify({ version, target: 'darwin-arm64', files, builtAt })
    )
  const commands: { command: string; args: string[] }[] = []
  const run: BootstrapDeps['run'] = async (command, args, _options, onLine) => {
    commands.push({ command, args })
    if (args.includes('--select-runtime')) {
      const manifest = JSON.parse(await readFile(args[args.indexOf('--manifest') + 1]!, 'utf8'))
      const installed = join(home, 'runtime/native', manifest.version)
      await mkdir(installed, { recursive: true })
      await cp(source, installed, { recursive: true })
      await writeFile(join(installed, 'manifest.json'), JSON.stringify(manifest))
      const executable = await realpath(join(installed, 'hexbot'))
      await rm(join(home, 'runtime/native-executable'), { force: true })
      await symlink(executable, join(home, 'runtime/native-executable'))
      await writeFile(
        join(home, 'runtime/native-current.json'),
        JSON.stringify({ ...manifest, executable })
      )
      onLine?.(JSON.stringify({ stage: 'done', executable, version: manifest.version }), 'stdout')
    }

    if (command === 'tar') {
      const path = join(args[args.indexOf('-C') + 1]!, args.at(-1)!)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'tool')
    }
    if (args[0] === 'python' && args[1] === 'find') {
      const python = join(home, 'python', 'managed', 'bin', 'python3.11')
      await mkdir(dirname(python), { recursive: true })
      await writeFile(python, '#!/bin/sh')
      onLine?.(python, 'stdout')
    }
    if (args[0] === 'venv') await mkdir(join(args.at(-1)!, 'bin'), { recursive: true })
    if (args[0] === 'pip')
      await writeFile(join(dirname(args[args.indexOf('--python') + 1]!), 'edge-tts'), '#!/bin/sh')
  }
  const downloads: string[] = []
  const download = async (url: string): Promise<string> => {
    downloads.push(url)
    return (['uv', 'rg', 'fd'] as Tool[])
      .map(tool => toolAsset(tool, 'darwin', 'arm64'))
      .find(asset => asset.url === url)!.sha256
  }
  const options = (appVersion: string): Partial<BootstrapDeps> => ({
    appIsPackaged: true,
    appVersion,
    resourcesPath: join(root, 'resources'),
    exists: existsSync,
    run,
    download,
    platform: 'darwin',
    arch: 'arm64'
  })
  const probes = (): number =>
    commands.filter(item => item.command.endsWith('/pi/hexbot-pi')).length
  const stable = join(home, 'runtime/native-executable')
  const selected = async (): Promise<string> => dirname(await realpath(stable))
  const oldHome = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  const close = async (): Promise<void> => {
    if (oldHome === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = oldHome
    await rm(root, { recursive: true, force: true })
  }
  return {
    root,
    home,
    source,
    files,
    bundle,
    commands,
    downloads,
    run,
    options,
    probes,
    stable,
    selected,
    close
  }
}

describe('native runtime bootstrap', () => {
  it('passes only authoritative effective hashes to runtime-only setup and cleans scratch', async () => {
    const f = await fixture()
    try {
      await f.bundle('1.0.0', 100)
      await writeFile(join(f.source, 'hexbot-core'), 'signed daemon')
      const original = await readFile(join(f.source, 'manifest.json'), 'utf8')
      const activation = await performBootstrap(f.options('1.0.0'))
      expect(activation?.version).toBe('1.0.0')
      const select = f.commands.find(item => item.args.includes('--select-runtime'))!
      expect(select.command).toBe(join(f.source, 'hexbot'))
      expect(select.args.slice(0, 3)).toEqual(['setup', '--select-runtime', '--manifest'])
      expect(select.args).not.toContain('--activate')
      await expect(readFile(select.args[3]!)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(f.source, 'manifest.json'), 'utf8')).toBe(original)
      const effective = JSON.parse(
        await readFile(join(dirname(activation!.executable), 'manifest.json'), 'utf8')
      )
      expect(Object.keys(effective.files).sort()).toEqual([...bundleFiles].sort())
      expect(effective.files['hexbot-core']).toBe(sha256('signed daemon'))
      const pip = f.commands.find(item => item.args[0] === 'pip')!.args
      expect(pip).toEqual(expect.arrayContaining(['--require-hashes', '--no-deps', '--no-build']))
    } finally {
      await f.close()
    }
  })

  it('rejects a changed launcher before calling selection', async () => {
    const f = await fixture()
    try {
      await f.bundle('1.0.0', 100)
      await writeFile(join(f.source, 'hexbot'), 'broken')
      await expect(performBootstrap(f.options('1.0.0'))).rejects.toThrow('checksum failed')
      expect(f.commands).toEqual([])
    } finally {
      await f.close()
    }
  })

  it('propagates selection refusal without writing a fallback pointer or record', async () => {
    const f = await fixture()
    try {
      await f.bundle('1.0.0', 100)
      const activation = await performBootstrap(f.options('1.0.0'))
      const record = await readFile(join(f.home, 'runtime/native-current.json'), 'utf8')
      const run: BootstrapDeps['run'] = async (command, args, options, onLine) => {
        if (args.includes('--select-runtime'))
          throw new Error('Runtime identity cannot be verified; repair the installation')
        return f.run(command, args, options, onLine)
      }
      await expect(performBootstrap({ ...f.options('1.0.0'), run })).rejects.toThrow(
        'identity cannot be verified'
      )
      expect(await readFile(join(f.home, 'runtime/native-current.json'), 'utf8')).toBe(record)
      expect(await realpath(f.stable)).toBe(activation?.executable)
    } finally {
      await f.close()
    }
  })

  it.each([true, false])('accepts stdout setup completion with stderr diagnostics (newline=%s)', async newline => {
    const f = await fixture()
    const diagnostics: string[] = []
    try {
      await f.bundle('1.0.0', 100)
      const run: BootstrapDeps['run'] = async (command, args, options, onLine) => {
        if (!args.includes('--select-runtime')) return f.run(command, args, options, onLine)
        let done = ''
        await f.run(command, args, options, line => { done = line })
        await runChild(process.execPath, ['-e',
          `process.stdout.write(${JSON.stringify(done + (newline ? '\n' : ''))}); process.stderr.write('Runtime cleanup: permission denied')`
        ], options, (...line) => {
          diagnostics.push(line[0])
          onLine?.(...line)
        })
      }
      expect(await performBootstrap({ ...f.options('1.0.0'), run })).toMatchObject({ version: '1.0.0' })
      expect(diagnostics).toContain('Runtime cleanup: permission denied')
      expect(await readFile(join(f.home, 'logs/bootstrap.log'), 'utf8')).toContain('Runtime cleanup: permission denied')
    } finally { await f.close() }
  })

  it('refuses malformed stdout even when stderr contains a valid completion', async () => {
    const f = await fixture()
    try {
      await f.bundle('1.0.0', 100)
      const run: BootstrapDeps['run'] = async (command, args, options, onLine) => {
        if (!args.includes('--select-runtime')) return f.run(command, args, options, onLine)
        let done = ''
        await f.run(command, args, options, line => { done = line })
        return runChild(process.execPath, ['-e',
          `process.stdout.write('malformed\\n'); process.stderr.write(${JSON.stringify(done + '\n')})`
        ], options, onLine)
      }
      await expect(performBootstrap({ ...f.options('1.0.0'), run })).rejects.toThrow('invalid response')
    } finally { await f.close() }
  })

  it('retains a stdout JSON error and failing child stderr in the cause chain', async () => {
    const f = await fixture()
    try {
      await f.bundle('1.0.0', 100)
      const run: BootstrapDeps['run'] = async (command, args, options, onLine) => {
        if (!args.includes('--select-runtime')) return f.run(command, args, options, onLine)
        return runChild(process.execPath, ['-e',
          `process.stdout.write(JSON.stringify({stage:'error',message:'Durable identity refused'})+'\\n'); process.stderr.write('useful child diagnostic'); process.exitCode=7`
        ], options, onLine)
      }
      const error: unknown = await performBootstrap({ ...f.options('1.0.0'), run }).catch(error => error)
      expect(error).toMatchObject({ message: 'Durable identity refused' })
      if (!(error instanceof Error) || !(error.cause instanceof Error)) throw error
      expect(error.cause.message).toContain('exited with code 7')
      expect(error.cause.message).toContain('useful child diagnostic')
    } finally { await f.close() }
  })

  it('reports an unsupported runtime before changing selection', async () => {
    const f = await fixture()
    try {
      await f.bundle('1.0.0', 100)
      const run: BootstrapDeps['run'] = async (command, args, options, onLine) => {
        if (command.endsWith('/hexbot') && args[0] === 'version') {
          onLine?.('unsupported system', 'stderr')
          throw new Error('probe failed')
        }
        return f.run(command, args, options, onLine)
      }
      await expect(performBootstrap({ ...f.options('1.0.0'), run })).rejects.toThrow(
        'unsupported system'
      )
      expect(existsSync(f.stable)).toBe(false)
    } finally {
      await f.close()
    }
  })
})

it.skipIf(!process.env.HEXBOT_NATIVE_TEST_BUNDLE)(
  'boots a real packaged native runtime in an isolated home',
  async () => {
    const source = process.env.HEXBOT_NATIVE_TEST_BUNDLE!
    const metadata = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')) as {
      version: string
    }
    const root = await mkdtemp(join(tmpdir(), 'hexbot native installed '))
    const oldHome = process.env.HEXBOT_HOME
    process.env.HEXBOT_HOME = root
    try {
      await performBootstrap({
        appIsPackaged: true,
        appVersion: metadata.version,
        resourcesPath: dirname(source),
        platform: process.platform,
        arch: process.arch
      })
      const { execFile, spawn } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const launcher = join(root, 'runtime/native-executable')
      const result = await promisify(execFile)(launcher, ['version'])
      expect(result.stdout.trim()).toBe(metadata.version)
      const installed = dirname(await realpath(launcher))
      const pi = await promisify(execFile)(join(installed, 'pi/hexbot-pi'), ['--version'])
      expect(pi.stdout).toContain('1.0.1')
      const daemon = spawn(launcher, ['serve', '--port', '0', '--host', '127.0.0.1'], {
        env: { ...process.env, HEXBOT_HOME: root },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const stopped = new Promise<void>(resolve => daemon.once('exit', () => resolve()))
      try {
        const port = await new Promise<number>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Packaged daemon did not become ready')),
            20_000
          )
          let output = ''
          daemon.stdout.on('data', chunk => {
            output += chunk.toString()
            const match = /HERMES_BACKEND_READY port=(\d+)/.exec(output)
            if (match) {
              clearTimeout(timeout)
              resolve(Number(match[1]))
            }
          })
          daemon.once('error', error => {
            clearTimeout(timeout)
            reject(error)
          })
          daemon.once('exit', code => {
            clearTimeout(timeout)
            reject(new Error(`Packaged daemon exited ${code}`))
          })
        })
        expect(await runningDaemonPort(root)).toBe(port)
        const page = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(10_000)
        })
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
        const version = await promisify(execFile)(join(installed, 'bin', tool), ['--version'])
        expect(version.stdout).toContain(
          toolAsset(tool as Tool, process.platform, process.arch).version
        )
      }
    } finally {
      if (oldHome === undefined) delete process.env.HEXBOT_HOME
      else process.env.HEXBOT_HOME = oldHome
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000
)

it('pruning protects a running runtime until its process has exited', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-prune-'))
  const oldHome = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = root
  try {
    const native = join(root, 'runtime/native')
    const paths = ['old-random', 'unused-random', 'previous-random', 'active-random'].map(name =>
      join(native, name, 'hexbot')
    )
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
