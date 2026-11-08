// Stage a native daemon and a pinned Pi runtime for the current build machine.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, stat, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { nativeBuildEnvironment } from './native-build.mjs'
import { downloadTool, installTool } from '../../apps/desktop/src/main/backend/tools.ts'
import { runtimeNotices } from './third-party-notices.mjs'
import { PDF_RUNTIME_FILES, stagePdfRuntime, validatePdfRuntime } from './pdf-runtime.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const execute = promisify(execFile)
export function nativeTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'win32-x64'
  if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch))
    throw new Error(`Unsupported native runtime target: ${platform}/${arch}`)
  return `${platform}-${arch}`
}
export function launchers() {
  const location = 'launcher=$0\nwhile [ -L "$launcher" ]; do\n  directory=$(CDPATH= cd -- "$(dirname -- "$launcher")" && pwd)\n  launcher=$(readlink "$launcher")\n  case "$launcher" in /*) ;; *) launcher="$directory/$launcher" ;; esac\ndone\n'
  return {
    hexbot: '#!/bin/sh\nset -eu\n' + location + 'root=$(CDPATH= cd -- "$(dirname -- "$launcher")" && pwd)\nexport HEXBOT_PI_EXECUTABLE="$root/pi/hexbot-pi"\nexport PATH="$root/bin:${HEXBOT_HOME:-$HOME/.hexbot}/bin:$PATH"\nexport HEXBOT_WEB_DIST="${HEXBOT_WEB_DIST:-$root/web}"\nexport HEXBOT_BUNDLED_SKILLS="${HEXBOT_BUNDLED_SKILLS:-$root/skills}"\nexec "$root/hexbot-core" "$@"\n',
    pi: '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nif [ "${1:-}" != "--version" ]; then\n  "$root/node" "$root/pi/search-tools.mjs" "$root/bin"\nfi\nexec "$root/node" "$root/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" "$@"\n'
  }
}
export function rustTarget(platform, arch) {
  nativeTarget(platform, arch)
  if (platform === 'win32') return 'x86_64-pc-windows-msvc'
  return `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}`
}

// npm can retain optional binaries for every platform in a nested dependency.
// Use package metadata rather than a list of package names, including nested scopes.
export async function pruneRuntimeDependencies(directory, platform, arch) {
  const compatible = (list, value) => !list ||
    (!list.includes(`!${value}`) && (!list.some(item => !item.startsWith('!')) || list.includes(value)))
  async function visit(path, packageRoot = false) {
    if (packageRoot) {
      const metadata = await readFile(join(path, 'package.json'), 'utf8').then(JSON.parse).catch(() => ({}))
      if (!compatible(metadata.os, platform) || !compatible(metadata.cpu, arch) ||
          (platform === 'linux' && !compatible(metadata.libc, 'glibc'))) {
        await rm(path, { recursive: true, force: true })
        return
      }
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isFile() && /(?:\.map|\.d\.(?:ts|mts|cts))$/.test(entry.name)) await rm(child)
      else if (entry.isDirectory()) {
        if (entry.name === '@types' || (packageRoot && ['docs', 'doc', 'examples', 'example', 'test', 'tests', '__tests__'].includes(entry.name)))
          await rm(child, { recursive: true, force: true })
        else if (entry.name === 'native' && (await readdir(child)).some(name => ['darwin', 'linux', 'win32'].includes(name))) {
          for (const name of await readdir(child)) {
            const target = join(child, name)
            if (['darwin', 'linux', 'win32'].includes(name)) {
              if (name !== platform) await rm(target, { recursive: true, force: true })
              else {
                const prebuilds = join(target, 'prebuilds')
                for (const cpu of await readdir(prebuilds).catch(() => []))
                  if (![arch, `${platform}-${arch}`].includes(cpu)) await rm(join(prebuilds, cpu), { recursive: true, force: true })
              }
            }
          }
          await visit(child)
        } else if (entry.name === 'node_modules') await packages(child)
        else await visit(child)
      }
    }
  }
  async function packages(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const child = join(path, entry.name)
      if (entry.name === '@types') await rm(child, { recursive: true, force: true })
      else if (entry.name.startsWith('@')) await packages(child)
      else await visit(child, true)
    }
  }
  await packages(directory)
}

export async function directoryBytes(directory) {
  let size = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) size += await directoryBytes(path)
    else if (entry.isFile()) size += (await stat(path)).size
  }
  return size
}
// Node 22 LTS is the newest line whose macOS builds run on macOS 11; Node 23
// and later need macOS 13.5, above the app's macOS 12 floor. Pi needs 22.19.
export const NODE_VERSION = '22.23.4'
// nodejs.org/dist/v22.23.4/SHASUMS256.txt (the .tar.gz archives). Update these with NODE_VERSION.
export const NODE_SHA256 = Object.freeze({
  'darwin-arm64': 'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428',
  'darwin-x64': 'efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819',
  'linux-arm64': 'f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9',
  'linux-x64': 'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406',
  'win32-x64': 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'
})
// nodejs.org and GitHub sometimes cut a release build's download short.
// Each attempt starts over; a wrong checksum is never retried.
export async function retryDownload(task, { attempts = 4, wait = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await task() } catch (error) {
      if (attempt === attempts) throw error
      console.warn(`Download failed (${error.cause?.message ?? error.message}); trying again (${attempt + 1}/${attempts})`)
      await wait(attempt * 5_000)
    }
  }
}
export async function standaloneNode(directory, platform, arch, version = NODE_VERSION, retry = retryDownload) {
  const digest = NODE_SHA256[nativeTarget(platform, arch)]
  if (version !== NODE_VERSION || !digest) throw new Error('Standalone Node checksum is not pinned')
  const windows = platform === 'win32'
  const name = `node-v${version}-${windows ? 'win' : platform}-${arch}`
  const filename = `${name}.${windows ? 'zip' : 'tar.gz'}`
  const origin = `https://nodejs.org/dist/v${version}`
  const archive = await retry(async () => {
    const response = await fetch(`${origin}/${filename}`, { signal: AbortSignal.timeout(300_000) })
    if (!response.ok) throw new Error(`Cannot download standalone Node: ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  })
  if (createHash('sha256').update(archive).digest('hex') !== digest) throw new Error('Standalone Node checksum mismatch')
  const path = join(directory, filename)
  await writeFile(path, archive)
  // Node's LICENSE also covers the libraries built into it (V8, OpenSSL, ICU, ...).
  const member = windows ? `${name}/node.exe` : `${name}/bin/node`
  await execute('tar', [windows ? '-xf' : '-xzf', path, '-C', directory, member, `${name}/LICENSE`])
  return join(directory, member)
}

export async function stageNativeRuntime({
  repository = root,
  destination = join(repository, 'apps/desktop/resources/hexbot-native'),
  platform = process.env.HEXBOT_BUILD_PLATFORM || process.platform,
  arch = process.env.HEXBOT_BUILD_ARCH || process.arch,
  nodeExecutable,
  pdfAssetsDirectory = process.env.HEXBOT_PDF_ASSETS_DIRECTORY,
  pdfSourceArchive = process.env.HEXBOT_PDF_SOURCE_ARCHIVE,
  channel = process.env.HEXBOT_CHANNEL || 'dev',
  notices = runtimeNotices,
  download = (url, dest) => retryDownload(() => downloadTool(url, dest)),
  run = (command, args, options) => execute(command, args, { ...options, maxBuffer: 32 * 1024 * 1024 })
} = {}) {
  const target = nativeTarget(platform, arch)
  const windows = platform === 'win32'
  const daemonName = windows ? 'hexbot.exe' : 'hexbot-core'
  const nodeName = windows ? 'node.exe' : 'node'
  nativeBuildEnvironment([platform === 'darwin' ? '--mac' : windows ? '--win' : '--linux', `--${arch}`])
  const triple = rustTarget(platform, arch)
  const metadata = JSON.parse(await readFile(join(repository, 'apps/desktop/package.json'), 'utf8'))
  if (channel !== 'dev' && (typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(metadata.version)))
    throw new Error('A release version is required before staging a native runtime')
  const piPackage = JSON.parse(await readFile(join(repository, 'backend/pi-runtime/package.json'), 'utf8'))
  const piVersion = piPackage.dependencies['@earendil-works/pi-coding-agent']
  if (!/^\d+\.\d+\.\d+$/.test(piVersion)) throw new Error('Pi must have an exact version')
  const nodeVersion = nodeExecutable ? (await run(nodeExecutable, ['-p', 'process.versions.node'])).stdout.trim() : NODE_VERSION
  const [major, minor] = nodeVersion.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('Pi needs Node 22.19 or later')
  await run('cargo', ['build', '--release', '--locked', '--bin', 'hexbot', ...(windows ? ['--bin', 'hexbot-cli'] : []), '--target', triple, '--manifest-path', join(repository, 'backend/hexbot-core/Cargo.toml')], { cwd: repository })
  await mkdir(dirname(destination), { recursive: true })
  const staging = await mkdtemp(`${destination}.staging-`)
  try {
    // Hexbot's own license and notices ship in the app, Headless, and update
    // archives; THIRD_PARTY_NOTICES below covers what the runtime includes.
    for (const file of ['LICENSE', 'NOTICE']) await cp(join(repository, file), join(staging, file))
    const pdf = platform === 'darwin' ? await stagePdfRuntime({
      repository, destination: join(staging, 'pdf'), arch, assetsDirectory: pdfAssetsDirectory,
      sourceArchivePath: pdfSourceArchive, channel, version: metadata.version, run,
      verifySources: async path => run('python3', [join(repository, 'backend/pdf-runtime/guest/verify-sources.py'),
        '--archive', path, '--sources', join(pdfAssetsDirectory, 'SOURCES.json'),
        '--notices', join(pdfAssetsDirectory, 'THIRD_PARTY_NOTICES'),
        '--lock', join(repository, 'backend/pdf-runtime/guest/assets.lock.json'), '--arch', arch === 'arm64' ? 'aarch64' : 'x86_64',
        '--version', metadata.version])
    }) : undefined
    const pi = join(staging, 'pi')
    await mkdir(pi)
    for (const file of ['package.json', 'package-lock.json'])
      await cp(join(repository, 'backend/pi-runtime', file), join(pi, file))
    await run(windows ? process.execPath : 'npm', [...(windows ? [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] : []), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--cpu=${arch}`, `--os=${platform}`], { cwd: pi })
    await cp(join(root, 'scripts/desktop/search-tools.mjs'), join(pi, 'search-tools.mjs'))
    for (const tool of ['rg', 'fd']) await installTool(tool, {
      binDirectory: join(staging, 'bin'), stagingDirectory: staging,
      platform, arch, exists: existsSync, download, run
    })
    const beforeBytes = await directoryBytes(pi)
    await pruneRuntimeDependencies(join(pi, 'node_modules'), platform, arch)
    const afterBytes = await directoryBytes(pi)
    console.log(`Runtime dependencies: ${beforeBytes} -> ${afterBytes} bytes`)
    await cp(join(repository, 'backend/hexbot-core/target', triple, windows ? 'release/hexbot.exe' : 'release/hexbot'), join(staging, daemonName))
    if (windows) await cp(join(repository, 'backend/hexbot-core/target', triple, 'release/hexbot-cli.exe'), join(staging, 'hexbot-cli.exe'))
    let license
    if (nodeExecutable) {
      // A local Node, for tests and development; release builds download theirs.
      await cp(nodeExecutable, join(staging, nodeName), { dereference: true })
      license = `Node.js ${nodeVersion}: https://github.com/nodejs/node/blob/v${nodeVersion}/LICENSE`
    } else {
      const download = await mkdtemp(`${destination}.node-`)
      try {
        const node = await standaloneNode(download, platform, arch)
        await cp(node, join(staging, nodeName))
        license = await readFile(join(dirname(node), windows ? 'LICENSE' : '../LICENSE'), 'utf8')
      } finally { await rm(download, { recursive: true, force: true }) }
    }
    // Third-party licenses for everything above; web/ carries the web app's own.
    const thirdPartyNotices = await notices({
      repository, nodeModules: join(pi, 'node_modules'), targets: [triple], node: { version: nodeVersion, license }
    })
    await writeFile(join(staging, 'THIRD_PARTY_NOTICES'), thirdPartyNotices +
      (pdf ? `\n\nPDF VM guest runtime\n\n${await readFile(join(staging, 'pdf/THIRD_PARTY_NOTICES'), 'utf8')}\n` : ''))
    await cp(join(repository, 'apps/web/dist'), join(staging, 'web'), { recursive: true })
    await cp(join(repository, 'skills'), join(staging, 'skills'), { recursive: true, dereference: true })
    if (!windows) {
      const scripts = launchers()
      await writeFile(join(staging, 'hexbot'), scripts.hexbot)
      await writeFile(join(pi, 'hexbot-pi'), scripts.pi)
      for (const file of ['hexbot', 'hexbot-core', 'node', 'pi/hexbot-pi']) await chmod(join(staging, file), 0o755)
    }
    await cp(join(root, 'scripts/desktop/pi-launch.mjs'), join(pi, 'launch.mjs'))
    const files = {}
    for (const file of [...(windows ? ['hexbot.exe', 'hexbot-cli.exe', 'node.exe', 'pi/launch.mjs'] : ['hexbot', 'hexbot-core', 'node', 'pi/hexbot-pi']), 'pi/package-lock.json', 'pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js', 'web/index.html', `bin/rg${windows ? '.exe' : ''}`, `bin/fd${windows ? '.exe' : ''}`, 'pi/search-tools.mjs'])
      files[file] = createHash('sha256').update(await readFile(join(staging, file))).digest('hex')
    Object.assign(files, pdf?.files)
    // The app keeps whichever installed runtime was built from newer source,
    // across Stable and Nightly (apps/desktop/src/main/backend/bootstrap.ts).
    const commit = await execute('git', ['log', '-1', '--format=%ct'], { cwd: repository }).catch(() => ({ stdout: '' }))
    const builtAt = Number(commit.stdout.trim()) || Math.floor(Date.now() / 1000)
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify({ version: metadata.version, target, piVersion, nodeVersion, builtAt, ...(pdf ? { pdfVm: 1 } : {}), files }, null, 2)}\n`)
    await run(join(staging, nodeName), [join(pi, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--version'], { cwd: staging })
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
    return { destination, version: metadata.version, target, piVersion, beforeBytes, afterBytes, ...(pdf?.archive ? { pdfSourceArchive: pdf.archive } : {}) }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
export function updateTarget(platformTarget) {
  const [platform, arch] = platformTarget.split('-')
  nativeTarget(platform, arch)
  return `${platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform}-${arch === 'arm64' ? 'aarch64' : 'x86_64'}`
}
export async function createNativeArchive(directory, destination) {
  // Materialize npm links as independent files. tar -h alone can emit hardlinks,
  // which the updater deliberately rejects along with symbolic links.
  const staging = await mkdtemp(join(dirname(destination), 'hexbot-native.archive-'))
  let unpackedSize
  try {
    const sourceManifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    if (sourceManifest.pdfVm === 1)
      await validatePdfRuntime(join(directory, 'pdf'), sourceManifest.target.split('-')[1])
    await cp(directory, staging, { recursive: true, dereference: true })
    // Signing changes Mach-O bytes. Refresh the archive's manifest, leaving the
    // signed app bundle untouched.
    const metadata = JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8'))
    if (metadata.pdfVm === 1) {
      const arch = metadata.target.split('-')[1]
      const pdf = await validatePdfRuntime(join(staging, 'pdf'), arch)
      if (PDF_RUNTIME_FILES.some(name => !metadata.files?.[`pdf/${name}`]))
        throw new Error('Native runtime manifest does not cover the complete PDF VM runtime')
      for (const [file, hash] of Object.entries(pdf.files))
        if (file !== 'pdf/hexbot-pdf-vm' && metadata.files[file] !== hash)
          throw new Error(`PDF VM runtime changed after staging: ${file}`)
    }
    for (const file of Object.keys(metadata.files ?? {})) {
      if (file.startsWith('/') || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..'))
        throw new Error('Invalid native runtime manifest path')
      metadata.files[file] = createHash('sha256').update(await readFile(join(staging, file))).digest('hex')
    }
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    unpackedSize = await directoryBytes(staging)
    await execute('tar', [
      ...(metadata.target === 'win32-x64' ? ['--format', 'zip'] : []),
      ...(process.platform === 'darwin' ? ['--no-mac-metadata', '--no-xattrs'] : []),
      metadata.target === 'win32-x64' ? '-cf' : '-czf', destination, '-C', staging, '.'
    ], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  } finally { await rm(staging, { recursive: true, force: true }) }
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const windows = manifest.target === 'win32-x64'
  const entrypoint = windows ? 'hexbot.exe' : 'hexbot'
  if (!existsSync(join(directory, entrypoint))) throw new Error('Native archive entrypoint is missing')
  return {
    version: manifest.version, builtAt: manifest.builtAt, target: updateTarget(manifest.target), format: windows ? 'zip' : 'tar.gz', entrypoint,
    size: (await stat(destination)).size, unpacked_size: unpackedSize,
    sha256: createHash('sha256').update(await readFile(destination)).digest('hex')
  }
}
