// Build the electron-updater feed from an electron-builder output directory.
//
//   node scripts/desktop/make-update-feed.mjs --channel stable|nightly --version <v> [--client] <builder-output> [feed-root]
//
// Layout mirrors the publish URL in electron-builder.base.yml,
// `https://updates.hexbot.app/${edition}/${os}/${arch}`:
//   dist/updates/full/mac/arm64/latest-mac.yml + Hexbot-<v>-mac-arm64.zip|.dmg
//   dist/updates/full/mac/x64/latest-mac.yml   + Hexbot-<v>-mac-x64.zip|.dmg
//   dist/updates/full/linux/x64/latest-linux.yml + AppImage + deb
//   dist/updates/client/...                    the same for HexbotClient-*
// A nightly writes nightly-*.yml instead of latest-*.yml, so both channels
// share one directory and the updater picks the file for its channel.
//
// electron-builder writes one latest-mac.yml per run and the second
// architecture overwrites the first, so the mac manifests are generated here
// from the artifacts themselves (sha512 base64 + size, as electron-updater
// expects). Linux reuses electron-builder's manifest after validation.
import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { feedMetadataName, writeFeedMetadata } from './update-feed-utils.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const client = args.includes('--client')
const channel = option('--channel') ?? 'stable'
const version =
  option('--version') ??
  JSON.parse(await readFile(join(repositoryRoot, 'apps/desktop/package.json'), 'utf8')).version
const positional = args.filter(
  (arg, i) =>
    arg !== '--client' &&
    !['--channel', '--version'].includes(arg) &&
    !['--channel', '--version'].includes(args[i - 1])
)
if (!positional[0])
  throw new Error(
    'Usage: node scripts/desktop/make-update-feed.mjs --channel stable|nightly [--version <v>] [--client] <electron-builder-output-directory> [feed-root]'
  )
const outputDirectory = resolve(positional[0])
const prefix = client ? 'HexbotClient' : 'Hexbot'
const feedRoot = join(
  positional[1] ? resolve(positional[1]) : join(repositoryRoot, 'dist/updates'),
  client ? 'client' : 'full'
)
const releaseDate = new Date().toISOString()

async function sha512(file) {
  const hash = createHash('sha512')
  await new Promise((done, fail) =>
    createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .on('end', done)
      .on('error', fail)
  )
  return hash.digest('base64')
}

async function entry(file) {
  return { url: basename(file), sha512: await sha512(file), size: (await stat(file)).size }
}

function manifest(entries, primary) {
  const lines = [`version: ${version}`, 'files:']
  for (const e of entries)
    lines.push(`  - url: ${e.url}`, `    sha512: ${e.sha512}`, `    size: ${e.size}`)
  lines.push(
    `path: ${primary.url}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: '${releaseDate}'`,
    ''
  )
  return lines.join('\n')
}

const files = await readdir(outputDirectory)
let prepared = 0

for (const arch of ['arm64', 'x64']) {
  const zip = files.find(f => f === `${prefix}-${version}-mac-${arch}.zip`)
  const dmg = files.find(f => f === `${prefix}-${version}-mac-${arch}.dmg`)
  if (!zip) {
    console.log(`mac/${arch}: no zip artifact, skipped`)
    continue
  }
  const entries = [await entry(join(outputDirectory, zip))]
  if (dmg) entries.push(await entry(join(outputDirectory, dmg)))
  const destination = join(feedRoot, 'mac', arch)
  await mkdir(destination, { recursive: true })
  for (const e of entries) await cp(join(outputDirectory, e.url), join(destination, e.url))
  await writeFeedMetadata(destination, channel, 'mac', manifest(entries, entries[0]))
  console.log(`Prepared mac/${arch}`)
  prepared++
}

const linuxYml = join(outputDirectory, 'latest-linux.yml')
const linuxManifest = await readFile(linuxYml, 'utf8').catch(() => undefined)
if (linuxManifest) {
  if (!linuxManifest.includes(`version: ${version}`))
    throw new Error(`latest-linux.yml is not for version ${version}`)
  const urls = [...linuxManifest.matchAll(/^\s*-?\s*url:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map(
    m => m[1]
  )
  const pathMatch = linuxManifest.match(/^path:\s*['"]?([^'"\s]+)['"]?\s*$/m)
  const artifacts = [...new Set(urls.length ? urls : pathMatch ? [pathMatch[1]] : [])]
  if (!artifacts.length) throw new Error('latest-linux.yml does not reference an artifact')
  const destination = join(feedRoot, 'linux', 'x64')
  await mkdir(destination, { recursive: true })
  for (const artifact of artifacts) {
    const source = join(outputDirectory, artifact)
    if (!(await stat(source).catch(() => undefined))?.isFile())
      throw new Error(`latest-linux.yml references missing artifact: ${artifact}`)
    await cp(source, join(destination, basename(artifact)))
  }
  // The deb is not an update payload but is published next to the feed so the
  // website and the docs can link to it.
  const deb = files.find(f => f === `${prefix}-${version}-linux-amd64.deb`)
  if (deb) await cp(join(outputDirectory, deb), join(destination, deb))
  await cp(linuxYml, join(destination, feedMetadataName(channel, 'linux')))
  console.log('Prepared linux/x64')
  prepared++
} else {
  console.log('linux/x64: no latest-linux.yml, skipped')
}

if (!prepared) throw new Error(`No update artifacts found in ${outputDirectory}`)
