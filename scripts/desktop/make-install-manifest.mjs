// Describe the already-built update tree for the terminal and windowed installers.
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appId, productName } from './release-version.mjs'
import { feedMetadataName } from './update-feed-utils.mjs'

// The oldest installer that reads this manifest correctly. Raise it only when
// a manifest change breaks older installers, never per release: a nightly
// installer sorts below the stable version and must still install stable.
export const MIN_INSTALLER = '0.1.5-0'

const targets = [
  ['macos-aarch64', 'mac', 'arm64'],
  ['macos-x86_64', 'mac', 'x64'],
  ['linux-x86_64', 'linux', 'x64']
]

async function exists(path) {
  try { return (await stat(path)).isFile() } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function digest(path, algorithm, encoding) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest(encoding)
}

// electron-builder emits a files list of scalar url, sha512 and size fields.
// Keep this reader dependency-free like make-update-feed, which runs before
// publish installs any npm packages.
function scalar(value) {
  const text = value.trim()
  if (text.startsWith('"')) return JSON.parse(text)
  if (text.startsWith("'")) return text.slice(1, -1).replaceAll("''", "'")
  return text
}

function readFeed(source) {
  const version = source.match(/^version:\s*(.+)$/m)
  const files = source.match(/^files:\s*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1]
  if (!version || !files) throw new Error('Invalid update feed: version and files are required')
  return {
    version: scalar(version[1]),
    files: files.split(/^\s*-\s+/m).slice(1).map(row => Object.fromEntries(
      [...row.matchAll(/^\s*(url|sha512|size):\s*(.+)$/gm)].map(([, key, value]) => [key, scalar(value)])
    ))
  }
}

export async function makeInstallManifest(root, { channel, version, baseUrl = 'https://updates.hexbot.app', allowMissing = false }) {
  feedMetadataName(channel, 'mac')
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid install version')
  const base = new URL(`${baseUrl.replace(/\/+$/, '')}/`)
  if (!['https:', 'http:'].includes(base.protocol) || base.search || base.hash || /\s/.test(base.href))
    throw new Error('Invalid install base URL')
  const url = path => new URL(path, base).href
  const manifest = { schema: 1, channel, version, minInstaller: MIN_INSTALLER, targets: {} }
  const lines = []
  const optional = async path => {
    if (await exists(join(root, path))) return true
    if (allowMissing) return false
    throw new Error(`Missing install artifact: ${path}`)
  }
  const verify = async (path, hash, algorithm, encoding, size) => {
    const file = join(root, path)
    if (!(await exists(file))) throw new Error(`Referenced file is missing: ${path}`)
    if (!Number.isSafeInteger(size) || size < 1 || (await stat(file)).size !== size)
      throw new Error(`Invalid artifact size: ${path}`)
    if (await digest(file, algorithm, encoding) !== hash) throw new Error(`Artifact checksum mismatch: ${path}`)
  }
  for (const [target, os, arch] of targets) {
    const options = {}
    for (const edition of ['full', 'client']) {
      const directory = `${edition}/${os}/${arch}`
      const feedPath = `${directory}/${feedMetadataName(channel, os)}`
      if (!(await optional(feedPath))) continue
      const feed = readFeed(await readFile(join(root, feedPath), 'utf8'))
      if (feed.version !== version) throw new Error(`Wrong feed version: ${feedPath}`)
      for (const file of feed.files) {
        if (!file.url || /[/\\]/.test(file.url) || file.url === '..') throw new Error(`Invalid artifact URL: ${feedPath}`)
        if (!(await exists(join(root, directory, file.url)))) throw new Error(`Referenced file is missing: ${directory}/${file.url}`)
      }
      const format = os === 'mac' ? 'zip' : 'AppImage'
      const file = feed.files.find(file => file.url.endsWith(`.${format}`))
      if (!file) {
        if (allowMissing) continue
        throw new Error(`Missing ${format} entry: ${feedPath}`)
      }
      const path = `${directory}/${file.url}`
      const size = Number(file.size)
      await verify(path, file.sha512, 'sha512', 'base64', size)
      options[edition] = { url: url(path), path, sha512: file.sha512, size, format,
        productName: productName(channel, version, edition === 'client'), appId: appId(channel, edition === 'client') }
    }
    const native = `daemon/native/${version}/${target}`
    if (await optional(`${native}/manifest.json`)) {
      const metadata = JSON.parse(await readFile(join(root, native, 'manifest.json'), 'utf8'))
      const path = `${native}/hexbot-native-${version}-${target}.tar.gz`
      if (metadata.version !== version || metadata.target !== target || metadata.format !== 'tar.gz')
        throw new Error(`Invalid native manifest: ${native}/manifest.json`)
      if (new URL(metadata.path ?? metadata.url, base).pathname !== new URL(path, base).pathname) throw new Error(`Invalid native archive URL: ${metadata.url}`)
      await verify(path, metadata.sha256, 'sha256', 'hex', metadata.size)
      options.headless = { url: url(path), path, sha256: metadata.sha256, size: metadata.size,
        format: 'tar.gz', manifest: `${native}/manifest.json` }
    }
    const appName = os === 'mac' ? `mac-${arch}.dmg` : 'linux-x86_64.AppImage'
    for (const [option, filename] of [
      ['installer', `hexbot-install-${version}-${target}`],
      ['installerApp', `HexbotInstaller-${version}-${appName}`]
    ]) {
      const path = `install/${version}/${filename}`
      if (!(await optional(path))) continue
      options[option] = { url: url(path), path, sha256: await digest(join(root, path), 'sha256', 'hex'), size: (await stat(join(root, path))).size }
      if (option === 'installer') lines.push(`${target} ${options[option].sha256} ${url(path)}`)
    }
    if (Object.keys(options).length) manifest.targets[target] = options
  }
  await mkdir(join(root, 'install'), { recursive: true })
  await writeFile(join(root, 'install', `${channel}.json`), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(root, 'install', `${channel}.txt`), lines.length ? `${lines.join('\n')}\n` : '')
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const options = {}
  let root
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]
    if (argument === '--allow-missing') options.allowMissing = true
    else if (['--channel', '--version', '--base-url'].includes(argument)) {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`)
      options[{ '--channel': 'channel', '--version': 'version', '--base-url': 'baseUrl' }[argument]] = value
    } else if (argument.startsWith('-') || root) throw new Error(`Unexpected argument: ${argument}`)
    else root = argument
  }
  if (!root) throw new Error('Usage: node make-install-manifest.mjs --channel stable|nightly --version V <updates-root> [--base-url URL] [--allow-missing]')
  await makeInstallManifest(resolve(root), options)
  console.log(`Prepared install/${options.channel}.json and .txt`)
}
