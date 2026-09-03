import { cp, mkdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const input = process.argv[2]
if (!input) throw new Error('Usage: node scripts/desktop/make-update-feed.mjs <electron-builder-output-directory>')
const outputDirectory = resolve(input)
const feedRoot = join(repositoryRoot, 'dist/updates')
const feeds = [
  { sourceNames: ['latest-mac-arm64.yml', 'latest-mac.yml'], os: 'mac', arch: 'arm64', artifactArch: 'arm64' },
  { sourceNames: ['latest-mac-x64.yml', 'latest-mac.yml'], os: 'mac', arch: 'x64', artifactArch: 'x64' },
  { sourceNames: ['latest-linux.yml'], os: 'linux', arch: 'x64', artifactArch: 'x86_64|x64|amd64' }
]

async function findFeed(names, artifactArch) {
  for (const name of names) {
    const candidate = join(outputDirectory, name)
    try {
      const yaml = await readFile(candidate, 'utf8')
      const artifacts = referencedArtifacts(yaml)
      if (name !== 'latest-mac.yml' || artifacts.some(file => new RegExp(`(?:^|[-_.])(?:${artifactArch})(?:[-_.]|$)`, 'i').test(file))) return { candidate, yaml, artifacts }
    } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  return undefined
}

function referencedArtifacts(yaml) {
  const urls = [...yaml.matchAll(/^\s*-?\s*url:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map(match => match[1])
  const pathMatch = yaml.match(/^path:\s*['"]?([^'"\s]+)['"]?\s*$/m)
  return [...new Set(urls.length ? urls : pathMatch ? [pathMatch[1]] : [])]
}

for (const feed of feeds) {
  const found = await findFeed(feed.sourceNames, feed.artifactArch)
  if (!found) throw new Error(`Missing ${feed.os}/${feed.arch} update metadata in ${outputDirectory}`)
  if (!found.artifacts.length) throw new Error(`${basename(found.candidate)} does not reference an artifact`)
  const destination = join(feedRoot, feed.os, feed.arch)
  await mkdir(destination, { recursive: true })
  for (const artifact of found.artifacts) {
    const source = isAbsolute(artifact) ? artifact : join(outputDirectory, artifact)
    const details = await stat(source).catch(() => undefined)
    if (!details?.isFile()) throw new Error(`${basename(found.candidate)} references missing artifact: ${artifact}`)
    await cp(source, join(destination, basename(artifact)))
  }
  await cp(found.candidate, join(destination, feed.os === 'mac' ? 'latest-mac.yml' : 'latest-linux.yml'))
  console.log(`Prepared ${feed.os}/${feed.arch}`)
}
