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

// Hexbot for iPhone, a client that pairs with a daemon, in public beta.
export const testflightUrl = 'https://testflight.apple.com/join/byKAKWMW'

// One entry per row of `full` and `client`, in feed order.
export const targets = [
  { key: 'mac-arm64', os: 'mac', name: 'Mac (Apple Silicon)', pill: 'Apple Silicon (.dmg)' },
  { key: 'mac-x64', os: 'mac', name: 'Mac (Intel)', pill: 'Intel (.dmg)' },
  { key: 'linux', os: 'linux', name: 'Linux', pill: 'AppImage' },
  { key: 'linux-deb', os: 'linux', name: 'Linux', pill: 'deb package' },
  { key: 'win-x64', os: 'win', name: 'Windows (x64)', pill: 'x64 (.exe)' },
] as const

let cached: Promise<Downloads | null> | undefined
export function loadDownloads(): Promise<Downloads | null> {
  return (cached ??= load())
}

async function load(): Promise<Downloads | null> {
  if (manifest.published === true) {
    const { version } = manifest
    return { channel: 'stable', version, built: `Version ${version}`, full: stableBuilds('full', manifest), client: stableBuilds('client', manifest.client) }
  }
  const nightly = await nightlyDownloads()
  if (!nightly) return null
  const { version, full, client } = nightly
  return { channel: 'nightly', version, built: `Nightly build from ${nightlyDate(version) ?? version}`, full, client }
}

export function stableBuilds(edition: 'full' | 'client', m: { mac: Record<string, string>; linux: Record<string, string>; win?: { x64: string } }): Build[] {
  return [
    { label: 'macOS, Apple Silicon', url: `${updates}/${edition}/mac/arm64/${m.mac.arm64}` },
    { label: 'macOS, Intel', url: `${updates}/${edition}/mac/x64/${m.mac.x64}` },
    { label: 'Linux AppImage', url: `${updates}/${edition}/linux/x64/${m.linux.AppImage}` },
    { label: 'Linux deb', url: `${updates}/${edition}/linux/x64/${m.linux.deb}` },
    ...(m.win ? [{ label: 'Windows, x64', url: `${updates}/${edition}/win/x64/${m.win.x64}` }] : []),
  ]
}
