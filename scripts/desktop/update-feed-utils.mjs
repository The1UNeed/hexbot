import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Windows reads `${channel}.yml`; macOS/Linux append the OS. Stable is called
// `latest` on the wire (electron-updater's default); nightly is `nightly`.
export const feedChannels = { stable: 'latest', nightly: 'nightly' }

export function feedMetadataName(channel, os) {
  const wire = feedChannels[channel]
  if (!wire) throw new Error(`Unknown channel "${channel}". Use stable or nightly.`)
  return os === 'win' ? `${wire}.yml` : `${wire}-${os}.yml`
}

export async function writeFeedMetadata(destination, channel, os, contents) {
  await mkdir(destination, { recursive: true })
  const name = feedMetadataName(channel, os)
  await writeFile(join(destination, name), contents)
  return name
}
