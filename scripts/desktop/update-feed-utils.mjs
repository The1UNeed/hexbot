import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// electron-updater reads `${channel}-${os}.yml`. The stable channel is called
// `latest` on the wire (electron-updater's default); nightly is `nightly`.
export const feedChannels = { stable: 'latest', nightly: 'nightly' }

export function feedMetadataName(channel, os) {
  const wire = feedChannels[channel]
  if (!wire) throw new Error(`Unknown channel "${channel}". Use stable or nightly.`)
  return `${wire}-${os}.yml`
}

export async function writeFeedMetadata(destination, channel, os, contents) {
  await mkdir(destination, { recursive: true })
  const name = feedMetadataName(channel, os)
  await writeFile(join(destination, name), contents)
  return name
}
