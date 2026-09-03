import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

import { app } from 'electron'

import { binDir, hexbotHome, srcDir, venvDir } from './paths'

export type BootstrapStage =
  'uv' | 'python' | 'source' | 'venv' | 'dependencies' | 'git' | 'ripgrep' | 'done'
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

export function ripgrepAssetName(targetPlatform: NodeJS.Platform, targetArch: string): string {
  if (targetPlatform === 'darwin' && targetArch === 'arm64')
    return 'ripgrep-14.1.1-aarch64-apple-darwin.tar.gz'
  if (targetPlatform === 'darwin' && targetArch === 'x64')
    return 'ripgrep-14.1.1-x86_64-apple-darwin.tar.gz'
  if (targetPlatform === 'linux' && targetArch === 'x64')
    return 'ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz'
  throw new Error(`Unsupported ripgrep platform: ${targetPlatform}/${targetArch}`)
}

async function keepLatestSources(current: string): Promise<void> {
  const root = dirname(current)
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const directories = await Promise.all(
    entries
      .filter(item => item.isDirectory())
      .map(async item => ({
        path: join(root, item.name),
        mtime: (await stat(join(root, item.name))).mtimeMs
      }))
  )
  directories.sort((a, b) => b.mtime - a.mtime)
  const keep = new Set([
    current,
    ...directories
      .filter(item => item.path !== current)
      .slice(0, 1)
      .map(item => item.path)
  ])
  await Promise.all(
    directories
      .filter(item => !keep.has(item.path))
      .map(item => rm(item.path, { recursive: true, force: true }))
  )
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
  await mkdir(binDir(), { recursive: true })
  const uv = join(binDir(), 'uv')
  emit('uv', 'Checking uv')
  if (!deps.exists(uv)) {
    const script = join(hexbotHome(), 'runtime', 'uv-install.sh')
    await deps.download('https://astral.sh/uv/install.sh', script, percent =>
      emit('uv', 'Downloading uv', percent)
    )
    await deps.run(
      'sh',
      [script],
      { env: { ...process.env, UV_INSTALL_DIR: binDir(), UV_NO_MODIFY_PATH: '1' } },
      line => emit('uv', line)
    )
  }
  const pythonRoot = join(hexbotHome(), 'python')
  emit('python', 'Installing Python 3.11')
  await deps.run(
    uv,
    ['python', 'install', '3.11'],
    { env: { ...process.env, UV_PYTHON_INSTALL_DIR: pythonRoot } },
    line => emit('python', line)
  )
  const source = srcDir(deps.appVersion)
  emit('source', 'Preparing Hexbot source')
  if (!deps.exists(source))
    await cp(join(deps.resourcesPath, 'hexbot-src'), source, { recursive: true })
  await keepLatestSources(source)
  emit('venv', 'Preparing virtual environment')
  if (!deps.exists(venvDir()))
    await deps.run(uv, ['venv', venvDir(), '--python', '3.11'], {}, line => emit('venv', line))
  emit('dependencies', 'Installing locked dependencies')
  const syncEnv = {
    ...process.env,
    UV_PROJECT_ENVIRONMENT: venvDir(),
    UV_PYTHON: join(venvDir(), 'bin', 'python'),
    UV_PYTHON_INSTALL_DIR: pythonRoot,
    VIRTUAL_ENV: venvDir()
  }
  await deps.run(uv, ['sync', '--extra', 'all', '--locked'], { cwd: source, env: syncEnv }, line =>
    emit('dependencies', line)
  )
  emit('git', 'Checking Git')
  try {
    await deps.run('git', ['--version'], {}, line => emit('git', line))
  } catch {
    emit(
      'git',
      deps.platform === 'darwin'
        ? 'Git is missing. Run: xcode-select --install'
        : 'Git is missing. Install it with your distribution package manager.'
    )
  }
  emit('ripgrep', 'Checking ripgrep')
  if (!deps.exists(join(binDir(), 'rg'))) {
    let available = true
    try {
      await deps.run('rg', ['--version'], {}, line => emit('ripgrep', line))
    } catch {
      available = false
    }
    if (!available) {
      const asset = ripgrepAssetName(deps.platform, deps.arch)
      const archive = join(hexbotHome(), 'runtime', asset)
      await deps.download(
        `https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/${asset}`,
        archive,
        percent => emit('ripgrep', 'Downloading ripgrep', percent)
      )
      const extractDir = join(hexbotHome(), 'runtime', 'ripgrep-extract')
      await rm(extractDir, { recursive: true, force: true })
      await mkdir(extractDir, { recursive: true })
      await deps.run('tar', ['-xzf', archive, '-C', extractDir], {}, line => emit('ripgrep', line))
      await cp(join(extractDir, asset.replace('.tar.gz', ''), 'rg'), join(binDir(), 'rg'))
      await chmod(join(binDir(), 'rg'), 0o755)
    }
  }
  emit('done', 'Hexbot runtime is ready', 100)
}

export function bootstrap(emit: ProgressListener): Promise<void> {
  activeInstall ??= performBootstrap({ emit }).finally(() => {
    activeInstall = undefined
  })
  return activeInstall
}
