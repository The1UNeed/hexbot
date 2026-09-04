import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function sha256(file) {
  const hash = createHash('sha256')
  hash.update(await readFile(file))
  return hash.digest('hex')
}

export async function updateCask(releaseDirectory, caskFile, requestedVersion, prefix = 'Hexbot') {
  const files = await import('node:fs/promises').then(fs => fs.readdir(releaseDirectory))
  const pattern = new RegExp(`^${prefix}-(.+)-mac-(arm64|x64)\\.dmg$`)
  const matches = files.map(file => [file, file.match(pattern)]).filter(([, match]) => match)
  const versions = new Set(matches.map(([, match]) => match[1]))
  const version = requestedVersion ?? (versions.size === 1 ? [...versions][0] : undefined)
  if (!version) throw new Error('Could not infer one release version from the macOS DMGs')

  const artifacts = Object.fromEntries(
    matches.filter(([, match]) => match[1] === version).map(([file, match]) => [match[2], file])
  )
  if (!artifacts.arm64 || !artifacts.x64)
    throw new Error(`Missing arm64 or x64 DMG for version ${version}`)

  const hashes = {
    arm64: await sha256(join(releaseDirectory, artifacts.arm64)),
    x64: await sha256(join(releaseDirectory, artifacts.x64))
  }
  let source = await readFile(caskFile, 'utf8')
  source = source.replace(/^\s*version ".*"$/m, `  version "${version}"`)
  source = source.replace(
    /^\s*sha256 arm: ".*", intel: ".*"$/m,
    `  sha256 arm: "${hashes.arm64}", intel: "${hashes.x64}"`
  )
  await writeFile(caskFile, source)
  return { version, hashes }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const client = process.argv.includes('--client')
  const [releaseDirectory, requestedVersion] = process.argv.slice(2).filter(a => a !== '--client')
  if (!releaseDirectory)
    throw new Error(
      'Usage: node scripts/desktop/update-cask.mjs [--client] <release-directory> [version]'
    )
  const caskFile = join(
    repositoryRoot,
    client ? 'packaging/homebrew/hexbot-client.rb' : 'packaging/homebrew/hexbot.rb'
  )
  const prefix = client ? 'HexbotClient' : 'Hexbot'
  const result = await updateCask(resolve(releaseDirectory), caskFile, requestedVersion, prefix)
  console.log(`Updated ${basename(caskFile)} for ${prefix} ${result.version}`)
}
