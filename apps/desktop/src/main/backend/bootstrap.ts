import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

import { app } from 'electron'
import { gte, valid } from 'semver'

import { migrateLegacyService } from '../service'
import { uvAsset, UV_VERSION } from './uv'

import { binDir, hexbotHome, nativeDir, nativeServiceExecutable, runtimeDir } from './paths'

export type BootstrapStage =
  'uv' | 'python' | 'runtime' | 'dependencies' | 'done'
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

let activeInstall: Promise<void> | undefined

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
  onLine?: (line: string) => void
): Promise<void> {
  await mkdir(join(hexbotHome(), 'logs'), { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env })
    const pending = new Map<NodeJS.ReadableStream, string>()
    const consume = (stream: NodeJS.ReadableStream, chunk: Buffer): void => {
      void appendLog(chunk)
      const parts = `${pending.get(stream) ?? ''}${chunk.toString()}`.split(/\r?\n/)
      pending.set(stream, parts.pop() ?? '')
      for (const line of parts.filter(Boolean)) onLine?.(line)
    }
    const flush = (): void => {
      for (const line of pending.values()) if (line) onLine?.(line)
      pending.clear()
    }
    child.stdout.on('data', chunk => consume(child.stdout, chunk))
    child.stderr.on('data', chunk => consume(child.stderr, chunk))
    child.once('error', reject)
    child.once('exit', code => {
      flush()
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

export async function download(
  url: string,
  dest: string,
  onProgress?: (percent: number) => void
): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!response.ok || !response.body)
    throw new Error(`Download failed (${response.status}): ${url}`)
  await mkdir(dirname(dest), { recursive: true })
  const total = Number(response.headers.get('content-length')) || 0
  let received = 0
  const hash = createHash('sha256')
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength
      hash.update(chunk)
      if (total) onProgress?.(Math.round((received / total) * 100))
      controller.enqueue(chunk)
    }
  })
  await pipeline(
    Readable.fromWeb(response.body.pipeThrough(stream) as never),
    createWriteStream(dest)
  )
  const digest = hash.digest('hex')
  await appendLog(`sha256 ${digest}  ${basename(dest)}\n`)
  return digest
}

interface NativeManifest {
  version: string
  target: string
  files: Record<string, string>
}

async function verifyNativeRuntime(
  directory: string, deps: BootstrapDeps, signedHashes?: Record<string, string>
): Promise<Record<string, string>> {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as NativeManifest
  if (manifest.version !== deps.appVersion || manifest.target !== `${deps.platform}-${deps.arch}`)
    throw new Error('Native runtime version or architecture does not match this app')
  const required = ['hexbot', 'hexbot-core', 'node', 'pi/hexbot-pi', 'pi/package-lock.json',
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
    const expected = deps.platform === 'darwin' && ['node', 'hexbot-core'].includes(file)
      ? signedHashes?.[file] ?? hash : digest
    if (hash !== expected) throw new Error(`Native runtime checksum failed: ${file}`)
    actualHashes[file] = hash
  }
  return actualHashes
}

export async function installCodeRuntime(deps: BootstrapDeps): Promise<void> {
  const python = join(binDir(), 'python3.11')
  const voice = join(binDir(), 'edge-tts')
  if (deps.exists(python) && deps.exists(voice)) return
  await mkdir(binDir(), { recursive: true })
  const uv = join(binDir(), 'uv')
  const receipt = join(binDir(), 'uv-version')
  if (!deps.exists(uv) || await readFile(receipt, 'utf8').catch(() => '') !== UV_VERSION) {
    deps.emit({ stage: 'uv', message: 'Preparing the code runtime installer' })
    const asset = uvAsset(deps.platform, deps.arch)
    const staging = await mkdtemp(join(runtimeDir(), '.uv-'))
    try {
      const archive = join(staging, 'uv.tar.gz')
      const digest = await deps.download(asset.url, archive)
      if (digest !== asset.sha256) throw new Error('Code runtime installer checksum mismatch')
      await deps.run('tar', ['-xzf', archive, '-C', staging, `${asset.directory}/uv`])
      const executable = join(staging, asset.directory, 'uv')
      await chmod(executable, 0o755)
      await rename(executable, uv)
      await writeFile(receipt, UV_VERSION)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  const env = { ...process.env,
    UV_PYTHON_INSTALL_DIR: join(hexbotHome(), 'python'),
    UV_PYTHON_BIN_DIR: binDir(),
    UV_TOOL_DIR: join(hexbotHome(), 'runtime', 'tools'),
    UV_TOOL_BIN_DIR: binDir(),
    UV_CACHE_DIR: join(hexbotHome(), 'runtime', 'uv-cache')
  }
  if (!deps.exists(python)) {
    deps.emit({ stage: 'python', message: 'Installing Python for code tools' })
    await deps.run(uv, ['python', 'install', '--no-bin', '3.11'], { env })
    let executable = ''
    await deps.run(uv, ['python', 'find', '--no-project', '--managed-python', '3.11'], { env }, line => {
      if (line.startsWith('/')) executable = line.trim()
    })
    if (!executable) throw new Error('Managed code interpreter was not found')
    await rm(python, { force: true })
    await symlink(executable, python)
  }
  if (!deps.exists(voice)) {
    deps.emit({ stage: 'dependencies', message: 'Installing voice tools' })
    await deps.run(uv, ['tool', 'install', '--python', python, 'edge-tts==7.2.7'], { env })
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
    if (!alive(running.pid)) return undefined
    return dirname(await realpath(running.executable))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    // Older native versions only recorded a PID. Defer cleanup until restart
    // rather than guess which installed runtime that process has open.
    const pid = Number(await readFile(join(hexbotHome(), 'native-daemon.lock'), 'utf8').catch(() => ''))
    return Number.isSafeInteger(pid) && pid > 0 && alive(pid) ? null : undefined
  }
}

export async function pruneNativeRuntimes(active: string, previous?: string): Promise<void> {
  if (!(await lstat(runtimeDir())).isDirectory() || !(await lstat(join(runtimeDir(), 'native'))).isDirectory())
    throw new Error('Runtime directories cannot be symbolic links')
  const root = await realpath(join(runtimeDir(), 'native'))
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

async function activateNativeRuntime(destination: string, deps: BootstrapDeps, files: Record<string, string>): Promise<void> {
  const stable = nativeServiceExecutable()
  let previous: string | undefined
  // Reopening an older app must not replace a newer verified service runtime.
  try {
    const selected = JSON.parse(await readFile(join(runtimeDir(), 'native-current.json'), 'utf8')) as {
      version: string; executable: string; files?: Record<string, string>
    }
    const executable = await realpath(stable)
    previous = executable
    const nativeRoot = await realpath(join(runtimeDir(), 'native'))
    if (valid(selected.version) && gte(selected.version, deps.appVersion) &&
      executable === selected.executable && executable.startsWith(`${nativeRoot}/`)) {
      const directory = dirname(executable)
      const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as NativeManifest
      await verifyNativeRuntime(directory, { ...deps, appVersion: selected.version }, selected.files ?? manifest.files)
      await pruneNativeRuntimes(executable, (selected as { previous?: string }).previous).catch(error => appendLog(`Runtime cleanup: ${String(error)}\n`).catch(() => undefined))
      return
    }
  } catch {
    // A missing, interrupted or damaged selection is replaced by this verified bundle.
  }
  const staging = await mkdtemp(join(runtimeDir(), '.native-link-'))
  try {
    const link = join(staging, 'launcher')
    const executable = await realpath(join(destination, 'hexbot'))
    await symlink(executable, link)
    const metadata = join(staging, 'current.json')
    await writeFile(metadata, JSON.stringify({ version: deps.appVersion, executable, previous, files }))
    await rename(link, stable)
    await rename(metadata, join(runtimeDir(), 'native-current.json'))
    await pruneNativeRuntimes(executable, previous).catch(error => appendLog(`Runtime cleanup: ${String(error)}\n`).catch(() => undefined))
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function installNativeRuntime(deps: BootstrapDeps): Promise<void> {
  const source = join(deps.resourcesPath, 'hexbot-native')
  let destination = nativeDir(deps.appVersion)
  deps.emit({ stage: 'runtime', message: 'Preparing Hexbot runtime' })
  const signedHashes = await verifyNativeRuntime(source, deps)
  try {
    const selected = JSON.parse(await readFile(join(runtimeDir(), 'native-current.json'), 'utf8')) as { version: string }
    const selectedPath = await realpath(nativeServiceExecutable())
    const nativeRoot = await realpath(join(runtimeDir(), 'native'))
    if (selected.version === deps.appVersion && selectedPath.startsWith(`${nativeRoot}/`)) destination = dirname(selectedPath)
  } catch { /* First install has no selected runtime. */ }
  // Always verify the installed binary before reusing it after an interrupted install.
  try {
    await verifyNativeRuntime(destination, deps, signedHashes)
  } catch {
    await mkdir(dirname(destination), { recursive: true })
    const staging = await mkdtemp(`${destination}.staging-`)
    try {
      await cp(source, staging, { recursive: true })
      await verifyNativeRuntime(staging, deps, signedHashes)
      for (const file of ['hexbot', 'hexbot-core', 'node', 'pi/hexbot-pi'])
        await chmod(join(staging, file), 0o755)
      await deps.run(join(staging, 'pi/hexbot-pi'), ['--version'])
      // Never replace files in a runtime that an existing daemon may be using.
      if (existsSync(destination)) destination = `${destination}-${basename(staging).split('.staging-')[1]}`
      await rename(staging, destination)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  await installCodeRuntime(deps)
  await activateNativeRuntime(destination, deps, signedHashes)
  await migrateLegacyService()
  deps.emit({ stage: 'done', message: 'Hexbot runtime is ready', percent: 100 })
}

export async function performBootstrap(overrides: Partial<BootstrapDeps> = {}): Promise<void> {
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
  await installNativeRuntime(deps)
}

export function bootstrap(emit: ProgressListener): Promise<void> {
  activeInstall ??= performBootstrap({ emit }).finally(() => {
    activeInstall = undefined
  })
  return activeInstall
}
