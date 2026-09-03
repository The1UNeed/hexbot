import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function feedMetadataNames(releaseVersion, os) {
  const latest = `latest-${os}.yml`
  return releaseVersion.includes('-') ? [latest, `beta-${os}.yml`] : [latest]
}

export async function writeFeedMetadata(destination, releaseVersion, os, contents) {
  await mkdir(destination, { recursive: true })
  const names = feedMetadataNames(releaseVersion, os)
  await Promise.all(names.map(name => writeFile(join(destination, name), contents)))
  return names
}
