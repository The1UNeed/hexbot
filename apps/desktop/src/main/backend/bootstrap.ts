import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { spawn } from 'node:child_process'

import { tmpdir } from 'node:os'

import { app } from 'electron'
import semver from 'semver'

import { migrateLegacyService } from '../service'
import voiceRequirements from '../../../../../backend/hexbot-core/assets/edge-tts.requirements.txt?raw'
import { lockedDaemonPid, type RuntimeActivation } from './manager'
import { downloadTool, installTool } from './tools'
import { nodePath } from './node-path'

import { binDir, canonicalRuntimePath, hexbotHome, nativeDir, nativeServiceExecutable, runtimeDir } from './paths'

export type BootstrapStage = 'uv' | 'python' | 'runtime' | 'dependencies' | 'done'
export interface BootstrapProgress {
  stage: BootstrapStage
  message: string
  percent?: number
}
export type ProgressListener = (progress: BootstrapProgress) => void

export interface BootstrapDeps {
  appIsPackaged: boolean
  appVersion: string
  resourcesPath: string
  emit: ProgressListener
  run: typeof runChild
  download: typeof download
  exists: typeof existsSync
  platform: NodeJS.Platform
  arch: string
}

let activeInstall: Promise<RuntimeActivation | undefined> | undefined

async function appendLog(data: string | Buffer): Promise<void> {
  const { appendFile } = await import('node:fs/promises')
  const logDir = join(hexbotHome(), 'logs')
  await mkdir(logDir, { recursive: true })
  await appendFile(join(logDir, 'bootstrap.log'), data)
}

export async function runChild(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
): Promise<void> {
  await mkdir(join(hexbotHome(), 'logs'), { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: process.platform === 'win32', cwd: options.cwd, env: { ...(options.env ?? process.env), HEXBOT_HOME: hexbotHome() } })
    const pending = new Map<NodeJS.ReadableStream, string>()
    let stderr = ''
    let logs = Promise.resolve()
    let logFailure: unknown
    const emitLine = (stream: NodeJS.ReadableStream, line: string): void =>
      onLine?.(line, stream === child.stdout ? 'stdout' : 'stderr')
    const consume = (stream: NodeJS.ReadableStream, chunk: Buffer): void => {
      logs = logs.then(() => appendLog(chunk)).catch(error => { logFailure ??= error })
      if (stream === child.stderr) stderr = `${stderr}${chunk.toString()}`.slice(-4096)
      const parts = `${pending.get(stream) ?? ''}${chunk.toString()}`.split(/\r?\n/)
      pending.set(stream, parts.pop() ?? '')
      for (const line of parts.filter(Boolean)) emitLine(stream, line)
    }
    const flush = (): void => {
      for (const [stream, line] of pending) if (line) emitLine(stream, line)
      pending.clear()
    }
    child.stdout.on('data', chunk => consume(child.stdout, chunk))
    child.stderr.on('data', chunk => consume(child.stderr, chunk))
    child.once('error', reject)
    // close follows stdio draining; exit can precede the last protocol bytes.
    child.once('close', code => {
      flush()
      void logs.then(() => {
        const failure = code === 0 ? undefined : new Error(
          `${command} exited with code ${code ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`
        )
        if (logFailure) reject(new AggregateError(
          [...(failure ? [failure] : []), logFailure], 'Runtime command logging failed'
        ))
        else if (failure) reject(failure)
        else resolve()
      })
    })
  })
}

export async function download(
  url: string,
  dest: string,
  onProgress?: (percent: number) => void
): Promise<string> {
  const digest = await downloadTool(url, dest, onProgress)
  await appendLog(`sha256 ${digest}  ${basename(dest)}\n`)
  return digest
}

interface NativeManifest {
  version: string
  target: string
  files: Record<string, string>
  // Commit time of the source in seconds. Bundles built before it was recorded have none.
  builtAt?: number
}

const readManifest = async (directory: string): Promise<NativeManifest> =>
  JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as NativeManifest

async function verifyNativeRuntime(
  directory: string, deps: BootstrapDeps, signedHashes?: Record<string, string>
): Promise<Record<string, string>> {
  const manifest = await readManifest(directory)
  if (manifest.version !== deps.appVersion || manifest.target !== `${deps.platform}-${deps.arch}`)
    throw new Error('Native runtime version or architecture does not match this app')
  const required = [...(deps.platform === 'win32' ? ['hexbot.exe', 'hexbot-cli.exe', 'node.exe', 'pi/launch.mjs', 'pi/search-tools.mjs', 'bin/rg.exe', 'bin/fd.exe', 'web/index.html'] : ['hexbot', 'hexbot-core', 'node', 'pi/hexbot-pi']), 'pi/package-lock.json',
    'pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js']
  if (!manifest.files || required.some(file => !manifest.files[file]))
    throw new Error('Native runtime manifest is incomplete')
  const actualHashes: Record<string, string> = {}
  for (const [file, digest] of Object.entries(manifest.files)) {
    if (file.startsWith('/') || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error('Invalid native runtime manifest path')
    const hash = createHash('sha256').update(await readFile(join(directory, file))).digest('hex')
    // macOS signs Mach-O files after staging. The signed app's resource is
    // authoritative; installed copies must still match its exact bytes.
    const expected = deps.platform === 'darwin' && ['node', 'hexbot-core', 'bin/rg', 'bin/fd'].includes(file)
      ? signedHashes?.[file] ?? hash : digest
    if (hash !== expected) throw new Error(`Native runtime checksum failed: ${file}`)
    actualHashes[file] = hash
  }
  return actualHashes
}

export async function installCodeRuntime(deps: BootstrapDeps): Promise<void> {
  await mkdir(binDir(), { recursive: true })
  await mkdir(runtimeDir(), { recursive: true })
  const toolDeps = { ...deps, binDirectory: binDir(), stagingDirectory: runtimeDir() }
  const python = join(binDir(), 'python3.11')
  const voice = join(binDir(), 'edge-tts')
  const voiceReceipt = join(runtimeDir(), 'tools', 'edge-tts.requirements.txt')
  const voiceCurrent = deps.exists(voice) && await readFile(voiceReceipt, 'utf8').catch(() => '') === voiceRequirements
  if (deps.exists(python) && voiceCurrent) return
  const uv = await installTool('uv', toolDeps,
    () => deps.emit({ stage: 'uv', message: 'Preparing the code runtime installer' }))
  const options = { cwd: runtimeDir(), env: { ...process.env,
    UV_PYTHON_INSTALL_DIR: join(hexbotHome(), 'python'),
    UV_PYTHON_BIN_DIR: binDir(),
    UV_CACHE_DIR: join(hexbotHome(), 'runtime', 'uv-cache'),
    UV_LINK_MODE: 'copy'
  } }
  if (!deps.exists(python)) {
    deps.emit({ stage: 'python', message: 'Installing Python for code tools' })
    await deps.run(uv, ['python', 'install', '--no-bin', '3.11'], options)
    let executable = ''
    await deps.run(uv, ['python', 'find', '--no-project', '--managed-python', '3.11'], options, line => {
      if (line.startsWith('/')) executable = line.trim()
    })
    if (!executable) throw new Error('Managed code interpreter was not found')
    await rm(python, { force: true })
    await symlink(executable, python)
  }
  if (!voiceCurrent) {
    // Every package is pinned with its hash, so a new upstream release never reaches this machine.
    deps.emit({ stage: 'dependencies', message: 'Installing voice tools' })
    const environment = join(runtimeDir(), 'tools', 'edge-tts')
    await rm(voiceReceipt, { force: true })
    await rm(environment, { recursive: true, force: true })
    await deps.run(uv, ['venv', '--no-project', '--python', python, environment], options)
    const requirements = join(environment, 'requirements.txt')
    await writeFile(requirements, voiceRequirements)
    await deps.run(uv, ['pip', 'install', '--python', join(environment, 'bin', 'python'),
      '--require-hashes', '--no-deps', '--no-build', '-r', requirements], options)
    await rm(voice, { force: true })
    await symlink(join(environment, 'bin', 'edge-tts'), voice)
    await writeFile(voiceReceipt, voiceRequirements)
  }
}

// A daemon records the executable it is using, independently of the selected update.
// Treat permission errors as alive; uncertain ownership must never cause deletion.
export async function runningNativeDirectory(): Promise<string | null | undefined> {
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }
  try {
    const running = JSON.parse(await readFile(join(runtimeDir(), 'native-running.json'), 'utf8')) as { pid: number; executable: string }
    if (!Number.isSafeInteger(running.pid) || running.pid <= 0) return null
    if (!alive(running.pid)) return await lockedDaemonPid() ? null : undefined
    return await realpath(running.executable).then(dirname).catch(() => null)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    // Older native versions only recorded a PID. Defer cleanup until restart
    // rather than guess which installed runtime that process has open.
    return await lockedDaemonPid() ? null : undefined
  }
}

export async function pruneNativeRuntimes(active: string, previous?: string): Promise<void> {
  if (!(await lstat(runtimeDir())).isDirectory() || !(await lstat(join(runtimeDir(), 'native'))).isDirectory())
    throw new Error('Runtime directories cannot be symbolic links')
  const root = await realpath(nativeDir(''))
  const running = await runningNativeDirectory()
  if (running === null) return
  const keep = new Set([dirname(active), previous && dirname(previous), running])
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.includes('.staging-') || entry.name.startsWith('.')) continue
    const directory = join(root, entry.name)
    if (!keep.has(directory) && existsSync(join(directory, 'hexbot')))
      await rm(directory, { recursive: true, force: true })
  }
}

interface SelectedRuntime { executable: string; previous?: string; builtAt: number }

// The runtime native-executable points at, if it is intact. The daemon's own
// updater also selects runtimes and records their hashes in native-current.json.
async function selectedRuntime(deps: BootstrapDeps): Promise<SelectedRuntime | undefined> {
  try {
    const selected = JSON.parse(await readFile(join(runtimeDir(), 'native-current.json'), 'utf8')) as {
      version: string; executable: string; previous?: string; files?: Record<string, string>
    }
    const executable = canonicalRuntimePath(nativeServiceExecutable(deps.platform))
    const nativeRoot = canonicalRuntimePath(join(runtimeDir(), 'native'))
    if (executable !== canonicalRuntimePath(selected.executable) || relative(nativeRoot, executable).startsWith('..') || isAbsolute(relative(nativeRoot, executable))) return undefined
    const directory = dirname(executable)
    const manifest = await readManifest(directory)
    await verifyNativeRuntime(directory, { ...deps, appVersion: selected.version }, selected.files ?? manifest.files)
    return { executable, previous: selected.previous, builtAt: manifest.builtAt ?? 0 }
  } catch {
    return undefined
  }
}

// A probe that cannot start usually means this system is older than the runtime supports.
async function probe(deps: BootstrapDeps, command: string, args: string[]): Promise<void> {
  let last = ''
  await deps
    .run(command, args, {}, line => {
      last = line
    })
    .catch((error: Error) => {
      throw new Error(`This system cannot run the Hexbot runtime: ${last || error.message}`, {
        cause: error
      })
    })
}

async function installNativeRuntime(deps: BootstrapDeps): Promise<RuntimeActivation | undefined> {
  const source = join(deps.resourcesPath, 'hexbot-native')
  deps.emit({ stage: 'runtime', message: 'Preparing Hexbot runtime' })
  const signedHashes = await verifyNativeRuntime(source, deps)
  const { builtAt = 0 } = await readManifest(source)
  if (deps.platform === 'win32') {
    const selected = await selectedRuntime(deps)
    // Rust owns Windows setup and atomic selection for both Full and Headless.
    const executable = selected && selected.builtAt >= builtAt ? selected.executable : join(source, 'hexbot.exe')
    const launcher = nodePath(canonicalRuntimePath(join(dirname(executable), 'pi/launch.mjs')))
    await probe(deps, join(dirname(executable), 'node.exe'), [launcher, '--version'])
    await deps.run(executable, ['setup', ...(selected && selected.builtAt >= builtAt ? [] : ['--activate']), '--json'], { env: { ...process.env, HEXBOT_HOME: hexbotHome() } })
    deps.emit({ stage: 'done', message: 'Hexbot runtime is ready', percent: 100 })
    return
  }
  // The newest build wins whichever app or updater installed it, so Stable and
  // Nightly apps sharing this home never go back to an older daemon.
  return selectPosixRuntime(deps, source, signedHashes)
}

export async function performBootstrap(
  overrides: Partial<BootstrapDeps> = {}
): Promise<RuntimeActivation | undefined> {
  const deps: BootstrapDeps = {
    appIsPackaged: app?.isPackaged ?? false,
    appVersion: app?.getVersion?.() ?? '0.0.0',
    resourcesPath: process.resourcesPath,
    emit: () => undefined,
    run: runChild,
    download,
    exists: existsSync,
    platform: platform(),
    arch: arch(),
    ...overrides
  }
  const emit = (stage: BootstrapStage, message: string, percent?: number): void =>
    deps.emit({ stage, message, percent })
  if (!deps.appIsPackaged) {
    emit('done', 'Development runtime is ready', 100)
    return
  }
  if (!deps.exists(join(deps.resourcesPath, 'hexbot-native', 'manifest.json')))
    throw new Error('This app is missing its Hexbot runtime. Reinstall the full package.')
  const activation = await installNativeRuntime(deps)
  if (deps.platform !== 'win32') return activation
  // Windows setup owns selection; authenticate its returned durable selection.
  const selected = await selectedRuntime(deps)
  if (!selected) throw new Error('Runtime preparation returned no verified selection')
  const manifest = await readManifest(dirname(selected.executable))
  return { executable: selected.executable, version: manifest.version }
}

export function bootstrap(emit: ProgressListener): Promise<RuntimeActivation | undefined> {
  activeInstall ??= performBootstrap({ emit }).finally(() => {
    activeInstall = undefined
  })
  return activeInstall
}

async function selectPosixRuntime(deps: BootstrapDeps, source: string, files: Record<string, string>): Promise<RuntimeActivation> {
  if (deps.platform !== 'darwin' && deps.platform !== 'linux')
    throw new Error('Runtime-only selection is unavailable on this platform')
  const manifest = await readManifest(source)
  await probe(deps, join(source, 'pi/hexbot-pi'), ['--version'])
  await probe(deps, join(source, 'hexbot'), ['version'])
  await installCodeRuntime(deps)
  const scratch = await mkdtemp(join(tmpdir(), 'hexbot-runtime-manifest-'))
  let failure: unknown
  try {
    const effective = join(scratch, 'manifest.json')
    await writeFile(effective, JSON.stringify({ ...manifest, files }), { mode: 0o600 })
    let activation: RuntimeActivation | undefined
    let reportedError: string | undefined
    let protocolError: unknown
    await deps
      .run(
        join(source, 'hexbot'),
        ['setup', '--select-runtime', '--manifest', effective, '--json'],
        { env: { ...process.env, HEXBOT_HOME: hexbotHome() } },
        (line, stream) => {
          if (stream !== 'stdout') return
          try {
            const result = JSON.parse(line) as {
              stage?: string
              message?: string
              executable?: string
              version?: string
            }
            if (result.stage === 'error') reportedError = result.message
            if (result.stage === 'done' && result.executable && result.version)
              activation = { executable: result.executable, version: result.version }
          } catch (error) {
            protocolError = error
          }
        }
      )
      .catch(error => {
        throw reportedError ? new Error(reportedError, { cause: error }) : error
      })
    if (protocolError)
      throw new Error('Runtime selection returned an invalid response', { cause: protocolError })
    if (!activation || !semver.valid(activation.version))
      throw new Error('Runtime selection did not return a verified identity')
    const executable = await realpath(activation.executable)
    const root = await realpath(nativeDir(''))
    if (executable !== activation.executable || !executable.startsWith(`${root}/`))
      throw new Error('Runtime selection returned an invalid executable')
    await migrateLegacyService().catch(error => appendLog(`Service migration: ${String(error)}\n`))
    deps.emit({ stage: 'done', message: 'Hexbot runtime is ready', percent: 100 })
    return activation
  } catch (error) {
    failure = error
    throw error
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(error => {
      throw failure
        ? new AggregateError([failure, error], 'Runtime preparation and cleanup failed')
        : error
    })
  }
}
