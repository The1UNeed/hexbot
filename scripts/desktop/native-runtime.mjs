// Stage a native daemon and a pinned Pi runtime for the current build machine.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, stat, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { nativeBuildEnvironment } from './native-build.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const execute = promisify(execFile)
export function nativeTarget(platform = process.platform, arch = process.arch) {
  if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch))
    throw new Error(`Unsupported native runtime target: ${platform}/${arch}`)
  return `${platform}-${arch}`
}
export function launchers() {
  const location = 'launcher=$0\nwhile [ -L "$launcher" ]; do\n  directory=$(CDPATH= cd -- "$(dirname -- "$launcher")" && pwd)\n  launcher=$(readlink "$launcher")\n  case "$launcher" in /*) ;; *) launcher="$directory/$launcher" ;; esac\ndone\n'
  return {
    hexbot: '#!/bin/sh\nset -eu\n' + location + 'root=$(CDPATH= cd -- "$(dirname -- "$launcher")" && pwd)\nexport HEXBOT_PI_EXECUTABLE="$root/pi/hexbot-pi"\nexport PATH="${HEXBOT_HOME:-$HOME/.hexbot}/bin:$PATH"\nexport HEXBOT_WEB_DIST="${HEXBOT_WEB_DIST:-$root/web}"\nexport HEXBOT_BUNDLED_SKILLS="${HEXBOT_BUNDLED_SKILLS:-$root/skills}"\nexec "$root/hexbot-core" "$@"\n',
    pi: '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$root/node" "$root/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" "$@"\n'
  }
}
export function rustTarget(platform, arch) {
  nativeTarget(platform, arch)
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
        else if (entry.name === 'node_modules') await packages(child)
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
export const NODE_VERSION = '26.5.0'
export async function standaloneNode(directory, platform, arch, version = NODE_VERSION) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Node must have an exact version')
  const name = `node-v${version}-${platform}-${arch}`
  const filename = `${name}.tar.gz`
  const origin = `https://nodejs.org/dist/v${version}`
  const checksums = await fetch(`${origin}/SHASUMS256.txt`)
  if (!checksums.ok) throw new Error(`Cannot fetch Node checksums: ${checksums.status}`)
  const digest = (await checksums.text()).split('\n').map(line => line.trim().split(/\s+/))
    .find(([, file]) => file === filename)?.[0]
  if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Standalone Node checksum is missing')
  const response = await fetch(`${origin}/${filename}`)
  if (!response.ok) throw new Error(`Cannot download standalone Node: ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(archive).digest('hex') !== digest) throw new Error('Standalone Node checksum mismatch')
  const path = join(directory, filename)
  await writeFile(path, archive)
  await execute('tar', ['-xzf', path, '-C', directory, `${name}/bin/node`])
  return join(directory, name, 'bin/node')
}
export async function stageNativeRuntime({
  repository = root,
  destination = join(repository, 'apps/desktop/resources/hexbot-native'),
  platform = process.env.HEXBOT_BUILD_PLATFORM || process.platform,
  arch = process.env.HEXBOT_BUILD_ARCH || process.arch,
  nodeExecutable,
  run = (command, args, options) => execute(command, args, { ...options, maxBuffer: 32 * 1024 * 1024 })
} = {}) {
  const target = nativeTarget(platform, arch)
  nativeBuildEnvironment([platform === 'darwin' ? '--mac' : '--linux', `--${arch}`])
  const triple = rustTarget(platform, arch)
  const metadata = JSON.parse(await readFile(join(repository, 'apps/desktop/package.json'), 'utf8'))
  const piPackage = JSON.parse(await readFile(join(repository, 'backend/pi-runtime/package.json'), 'utf8'))
  const piVersion = piPackage.dependencies['@earendil-works/pi-coding-agent']
  if (!/^\d+\.\d+\.\d+$/.test(piVersion)) throw new Error('Pi must have an exact version')
  const nodeVersion = nodeExecutable ? (await run(nodeExecutable, ['-p', 'process.versions.node'])).stdout.trim() : NODE_VERSION
  const [major, minor] = nodeVersion.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('Pi needs Node 22.19 or later')
  await run('cargo', ['build', '--release', '--locked', '--target', triple, '--manifest-path', join(repository, 'backend/hexbot-core/Cargo.toml')], { cwd: repository })
  await mkdir(dirname(destination), { recursive: true })
  const staging = await mkdtemp(`${destination}.staging-`)
  try {
    const pi = join(staging, 'pi')
    await mkdir(pi)
    for (const file of ['package.json', 'package-lock.json'])
      await cp(join(repository, 'backend/pi-runtime', file), join(pi, file))
    await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--cpu=${arch}`, `--os=${platform}`], { cwd: pi })
    const beforeBytes = await directoryBytes(pi)
    await pruneRuntimeDependencies(join(pi, 'node_modules'), platform, arch)
    const afterBytes = await directoryBytes(pi)
    console.log(`Runtime dependencies: ${beforeBytes} -> ${afterBytes} bytes`)
    await cp(join(repository, 'backend/hexbot-core/target', triple, 'release/hexbot'), join(staging, 'hexbot-core'))
    if (nodeExecutable) await cp(nodeExecutable, join(staging, 'node'), { dereference: true })
    else {
      const download = await mkdtemp(`${destination}.node-`)
      try { await cp(await standaloneNode(download, platform, arch), join(staging, 'node')) }
      finally { await rm(download, { recursive: true, force: true }) }
    }
    await cp(join(repository, 'apps/web/dist'), join(staging, 'web'), { recursive: true })
    await cp(join(repository, 'skills'), join(staging, 'skills'), { recursive: true, dereference: true })
    const scripts = launchers()
    await writeFile(join(staging, 'hexbot'), scripts.hexbot)
    await writeFile(join(pi, 'hexbot-pi'), scripts.pi)
    for (const file of ['hexbot', 'hexbot-core', 'node', 'pi/hexbot-pi']) await chmod(join(staging, file), 0o755)
    const files = {}
    for (const file of ['hexbot', 'hexbot-core', 'node', 'pi/hexbot-pi', 'pi/package-lock.json', 'pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js', 'web/index.html'])
      files[file] = createHash('sha256').update(await readFile(join(staging, file))).digest('hex')
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify({ version: metadata.version, target, piVersion, nodeVersion, files }, null, 2)}\n`)
    await run(join(staging, 'node'), [join(pi, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--version'], { cwd: staging })
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
    return { destination, version: metadata.version, target, piVersion, beforeBytes, afterBytes }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
export function updateTarget(platformTarget) {
  const [platform, arch] = platformTarget.split('-')
  nativeTarget(platform, arch)
  return `${platform === 'darwin' ? 'macos' : platform}-${arch === 'arm64' ? 'aarch64' : 'x86_64'}`
}
export async function createNativeArchive(directory, destination) {
  // Materialize npm links as independent files. tar -h alone can emit hardlinks,
  // which the updater deliberately rejects along with symbolic links.
  const staging = await mkdtemp(join(dirname(destination), 'hexbot-native.archive-'))
  let unpackedSize
  try {
    await cp(directory, staging, { recursive: true, dereference: true })
    unpackedSize = await directoryBytes(staging)
    await execute('tar', ['-czf', destination, '-C', staging, '.'])
  } finally { await rm(staging, { recursive: true, force: true }) }
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  return {
    version: manifest.version, target: updateTarget(manifest.target), format: 'tar.gz', entrypoint: 'hexbot',
    size: (await stat(destination)).size, unpacked_size: unpackedSize,
    sha256: createHash('sha256').update(await readFile(destination)).digest('hex')
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await stageNativeRuntime()
  if (process.argv.includes('--archive')) {
    const archive = `${result.destination}.tar.gz`
    const manifest = await createNativeArchive(result.destination, archive)
    await writeFile(`${archive}.json`, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  console.log(`Staged Hexbot ${result.version} native daemon and Pi ${result.piVersion} for ${result.target}`)
}
