// What the site can offer right now: the stable release named in the
// committed manifest once it is published, otherwise the current nightly read
// from the update server while the site builds (nightly.ts). Both pages that
// show downloads call loadDownloads(), so the feed is fetched once per build.
import manifest from '../../public/downloads/manifest.json'
import { nightlyDate, nightlyDownloads, updates, type Build } from './nightly'

export type Downloads = {
  channel: 'stable' | 'nightly'
  version: string
  built: string
  full: Build[]
  client: Build[]
}

export const releasesUrl = 'https://github.com/The1UNeed/hexbot/releases'

// Match rows by key so unpublished platforms cannot shift another platform's label.
export const targets = [
  { key: 'mac-arm64', os: 'mac', name: 'Mac (Apple Silicon)', pill: 'Apple Silicon (.dmg)' },
  { key: 'mac-x64', os: 'mac', name: 'Mac (Intel)', pill: 'Intel (.dmg)' },
  { key: 'linux', os: 'linux', name: 'Linux', pill: 'AppImage' },
  { key: 'linux-deb', os: 'linux', name: 'Linux', pill: 'deb package' },
  { key: 'windows', os: 'windows', name: 'Windows (x64)', pill: 'Windows x64 (.exe)' },
] as const

let cached: Promise<Downloads | null> | undefined
export function loadDownloads(): Promise<Downloads | null> {
  return (cached ??= load())
}

type Packages = { mac: Record<string, string>; linux: Record<string, string>; windows?: { x64?: string } }

export function packageRows(edition: 'full' | 'client', m: Packages): Build[] {
  return [
    { key: 'mac-arm64', label: 'macOS, Apple Silicon', url: `${updates}/${edition}/mac/arm64/${m.mac.arm64}` },
    { key: 'mac-x64', label: 'macOS, Intel', url: `${updates}/${edition}/mac/x64/${m.mac.x64}` },
    { key: 'linux', label: 'Linux AppImage', url: `${updates}/${edition}/linux/x64/${m.linux.AppImage}` },
    { key: 'linux-deb', label: 'Linux deb', url: `${updates}/${edition}/linux/x64/${m.linux.deb}` },
    ...(m.windows?.x64 ? [{ key: 'windows', label: 'Windows x64', url: `${updates}/${edition}/win/x64/${m.windows.x64}` }] : []),
  ]
}

async function load(): Promise<Downloads | null> {
  if (manifest.published === true) {
    const { version } = manifest
    return { channel: 'stable', version, built: `Version ${version}`, full: packageRows('full', manifest), client: packageRows('client', manifest.client) }
  }
  const nightly = await nightlyDownloads()
  if (!nightly) return null
  const { version, full, client } = nightly
  return { channel: 'nightly', version, built: `Nightly build from ${nightlyDate(version) ?? version}`, full, client }
}
