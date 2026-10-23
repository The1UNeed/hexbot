import { channel } from 'node:diagnostics_channel'
// Stage a native daemon and a pinned Pi runtime for the current build machine.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, lstat, stat, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { nativeBuildEnvironment } from './native-build.mjs'
import { downloadTool, installTool } from '../../apps/desktop/src/main/backend/tools.ts'

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
export const NODE_VERSION = '22.23.3'
// nodejs.org/dist/v22.23.3/SHASUMS256.txt (the .tar.gz archives). Update these with NODE_VERSION.
export const NODE_SHA256 = Object.freeze({
  'darwin-arm64': '23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53',
  'darwin-x64': '8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8',
  'linux-arm64': '5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2',
  'linux-x64': '1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af',
  'win32-x64': '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71'
})
async function archiveTool() {
  if (process.platform !== 'win32') return 'tar'
  if (!process.env.SystemRoot || !isAbsolute(process.env.SystemRoot)) throw new Error('Windows SystemRoot must be absolute')
  const program = join(process.env.SystemRoot, 'System32/tar.exe')
  const file = await lstat(program)
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('Windows tar must be an ordinary system executable')
  const { stdout } = await execute(program, ['--version'], { windowsHide: true })
  console.log('Windows archive tool:', JSON.stringify({ program: await realpath(program), version: stdout.trim().slice(0, 1024) }))
  return program
}
export async function extractStandaloneNode(directory, filename, member, windows, run = execute) {
  if (windows) {
    // Windows bsdtar can narrow Unicode argv through the active code page.
    // CreateProcessW carries cwd separately: keep all file operands ASCII.
    if (!/^[\x20-\x7e]+$/.test(filename) || basename(filename) !== filename ||
        !/^[\x20-\x7e]+$/.test(member) || member.includes('\\') || member.includes(':') || member.split('/').some(p => !p || p === '.' || p === '..'))
      throw new Error('Invalid standalone Node archive member')
    await run(await archiveTool(), ['-xf', filename, '-C', '.', member], { cwd: directory, windowsHide: true })
  } else {
    await run('tar', ['-xzf', join(directory, filename), '-C', directory, member])
  }
}
export async function standaloneNode(directory, platform, arch, version = NODE_VERSION) {
  const digest = NODE_SHA256[nativeTarget(platform, arch)]
  if (version !== NODE_VERSION || !digest) throw new Error('Standalone Node checksum is not pinned')
  const windows = platform === 'win32'
  const name = `node-v${version}-${windows ? 'win' : platform}-${arch}`
  const filename = `${name}.${windows ? 'zip' : 'tar.gz'}`
  const origin = `https://nodejs.org/dist/v${version}`
  const response = await fetch(`${origin}/${filename}`)
  if (!response.ok) throw new Error(`Cannot download standalone Node: ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(archive).digest('hex') !== digest) throw new Error('Standalone Node checksum mismatch')
  const path = join(directory, filename)
  await writeFile(path, archive)
  const member = windows ? `${name}/node.exe` : `${name}/bin/node`
  await extractStandaloneNode(directory, filename, member, windows)
  return join(directory, member)
}
export async function stageNativeRuntime({
  repository = root,
  destination = join(repository, 'apps/desktop/resources/hexbot-native'),
  platform = process.env.HEXBOT_BUILD_PLATFORM || process.platform,
  arch = process.env.HEXBOT_BUILD_ARCH || process.arch,
  nodeExecutable,
  download = downloadTool,
  run = (command, args, options) => execute(command, args, { ...options, maxBuffer: 32 * 1024 * 1024 })
} = {}) {
  const target = nativeTarget(platform, arch)
  const windows = platform === 'win32'
  const daemonName = windows ? 'hexbot.exe' : 'hexbot-core'
  const nodeName = windows ? 'node.exe' : 'node'
  nativeBuildEnvironment([platform === 'darwin' ? '--mac' : windows ? '--win' : '--linux', `--${arch}`])
  const triple = rustTarget(platform, arch)
  const metadata = JSON.parse(await readFile(join(repository, 'apps/desktop/package.json'), 'utf8'))
  const piPackage = JSON.parse(await readFile(join(repository, 'backend/pi-runtime/package.json'), 'utf8'))
  const piVersion = piPackage.dependencies['@earendil-works/pi-coding-agent']
  if (!/^\d+\.\d+\.\d+$/.test(piVersion)) throw new Error('Pi must have an exact version')
  const nodeVersion = nodeExecutable ? (await run(nodeExecutable, ['-p', 'process.versions.node'])).stdout.trim() : NODE_VERSION
  const [major, minor] = nodeVersion.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('Pi needs Node 22.19 or later')
  await run('cargo', ['build', '--release', '--locked', '--bin', 'hexbot', ...(windows ? ['--bin', 'hexbot-cli'] : []), '--target', triple, '--manifest-path', join(repository, 'backend/hexbot-core/Cargo.toml')], { cwd: repository })
  await mkdir(dirname(destination), { recursive: true })
  const staging = await mkdtemp(`${destination}.staging-`)
  let failure
  try {
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
    if (nodeExecutable) await cp(nodeExecutable, join(staging, nodeName), { dereference: true })
    else {
      const download = await mkdtemp(`${destination}.node-`)
      try { await cp(await standaloneNode(download, platform, arch), join(staging, nodeName)) }
      finally { await rm(download, { recursive: true, force: true }) }
    }
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
    // The app keeps whichever installed runtime was built from newer source,
    // across Stable and Nightly (apps/desktop/src/main/backend/bootstrap.ts).
    const commit = await execute('git', ['log', '-1', '--format=%ct'], { cwd: repository }).catch(() => ({ stdout: '' }))
    const builtAt = Number(commit.stdout.trim()) || Math.floor(Date.now() / 1000)
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify({ version: metadata.version, target, piVersion, nodeVersion, builtAt, files }, null, 2)}\n`)
    const versionProbe = run(join(staging, nodeName), [join(pi, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--version'], { cwd: staging })
    const child = versionProbe.child
    const lifecycle = { pid: child?.pid, program: join(staging, nodeName), cwd: staging }
    child?.once('exit', (code, signal) => { lifecycle.exit = { code, signal } })
    child?.once('close', (code, signal) => { lifecycle.close = { code, signal } })
    await versionProbe
    console.log('Staged version probe completed:', JSON.stringify(lifecycle))
    await publishNativeRuntime(staging, destination, lifecycle)
    return { destination, version: metadata.version, target, piVersion, beforeBytes, afterBytes }
  } catch (error) {
    failure = error
    throw error
  } finally {
    try { await rm(staging, { recursive: true, force: true }) }
    catch (cleanup) {
      if (failure) throw new AggregateError([failure, cleanup], 'Native runtime staging and cleanup failed', { cause: failure })
      throw cleanup
    }
  }
}
// Keep the unverified tree private. A failed rename never leaves a partial
// destination; report only filesystem/process metadata, never child env/stdout.
export async function publishNativeRuntime(staging, destination, versionProbe) {
  await rm(destination, { recursive: true, force: true })
  try { await rename(staging, destination) }
  catch (error) {
    // A test-only prewarmed observer can request read-only evidence before the
    // slower failure diagnostics start. This never retries or replaces rename.
    channel('hexbot.native-publication-failed').publish({ staging, destination, versionProbe, error })
    const describe = async path => {
      try {
        const m = await lstat(path)
        return { exists: true, canonical: await realpath(path), directory: m.isDirectory(), symlink: m.isSymbolicLink(), mode: m.mode, entries: m.isDirectory() ? (await readdir(path)).slice(0, 24) : undefined }
      } catch (e) { return { error: e.code } }
    }
    let windows
    if (process.platform === 'win32') {
      try {
        const system = process.env.SystemRoot
        if (!system || !isAbsolute(system)) throw new Error('System directory unavailable')
        const powershell = join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe')
        const program = await lstat(powershell)
        if (!program.isFile() || program.isSymbolicLink()) throw new Error('System PowerShell is not an ordinary file')
        const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts/desktop/windows-runtime-locks.ps1')], {
          windowsHide: true, timeout: 8000, maxBuffer: 32768,
          env: { ...process.env, HEXBOT_STAGING_DIAGNOSTIC: staging, HEXBOT_STAGING_OWNER: String(process.pid), HEXBOT_STAGING_PROBER: String(versionProbe?.pid ?? 0) },
        })
        windows = JSON.parse(stdout)
      } catch (diagnostic) { windows = { error: diagnostic.code ?? diagnostic.name } }
    }
    const details = { operation: 'publish native runtime', pid: process.pid, cwd: process.cwd(), activeResources: process.getActiveResourcesInfo().slice(0, 32), versionProbe,
      platform: process.platform, node: process.versions.node, staging, destination, staged: await describe(staging), target: await describe(destination), windows }
    console.error('Native runtime publication failed:', JSON.stringify(details))
    throw error
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
  const temporaryZip = `${staging}.zip`
  let unpackedSize
  try {
    await cp(directory, staging, { recursive: true, dereference: true })
    // Signing changes Mach-O bytes. Refresh the archive's manifest, leaving the
    // signed app bundle untouched.
    const metadata = JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8'))
    for (const file of Object.keys(metadata.files ?? {})) {
      if (file.startsWith('/') || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..'))
        throw new Error('Invalid native runtime manifest path')
      metadata.files[file] = createHash('sha256').update(await readFile(join(staging, file))).digest('hex')
    }
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    unpackedSize = await directoryBytes(staging)
    if (metadata.target === 'win32-x64') {
      // Both temporary names are ASCII even if their parent or the final
      // archive name is Unicode. Publish only after tar has closed successfully.
      await execute(await archiveTool(), ['--format', 'zip', '-cf', basename(temporaryZip), '-C', basename(staging), '.'],
        { cwd: dirname(staging), windowsHide: true, env: { ...process.env, COPYFILE_DISABLE: '1' } })
      await rename(temporaryZip, destination)
    } else {
      await execute('tar', [
        ...(process.platform === 'darwin' ? ['--no-mac-metadata', '--no-xattrs'] : []),
        '-czf', destination, '-C', staging, '.'
      ], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    }
  } finally {
    await rm(temporaryZip, { force: true })
    await rm(staging, { recursive: true, force: true })
  }
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
