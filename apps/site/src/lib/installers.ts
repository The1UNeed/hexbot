// The Hexbot Installer for each computer, read from the install manifest on
// the update server while the site builds (scripts/desktop/make-install-manifest.mjs
// writes it). The stable track is offered once install/stable.json exists,
// the nightly track until then, the same default the installers use. Any
// failure returns null and the download page offers the packages alone.
import { updates } from './nightly'

export type Track = 'stable' | 'nightly'
export type InstallerBuild = { key: 'mac-arm64' | 'mac-x64' | 'linux'; name: string; pill: string; url: string; size?: number }
export type Installers = { track: Track; version: string; builds: InstallerBuild[] }

// Manifest targets, in the order the page lists them, with the site's names for them.
const targets = [
  ['macos-aarch64', 'mac-arm64', 'Mac (Apple Silicon)', 'Apple Silicon (.dmg)'],
  ['macos-x86_64', 'mac-x64', 'Mac (Intel)', 'Intel (.dmg)'],
  ['linux-x86_64', 'linux', 'Linux', 'Linux (AppImage)'],
] as const

type Load = (url: string) => Promise<unknown | null>

// null for a missing manifest (404), so stable can fall through to nightly.
async function fetchJson(url: string): Promise<unknown | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return response.json()
}

type Manifest = { schema?: unknown; channel?: unknown; version?: unknown; targets?: Record<string, { installerApp?: { url?: unknown; size?: unknown } }> }

export function readManifest(manifest: unknown, track: Track): Installers | null {
  const m = manifest as Manifest | null
  if (!m || m.schema !== 1 || m.channel !== track || typeof m.version !== 'string') return null
  const builds: InstallerBuild[] = []
  for (const [target, key, name, pill] of targets) {
    const app = m.targets?.[target]?.installerApp
    if (typeof app?.url !== 'string' || !app.url.trim()) continue
    let url: URL
    try { url = new URL(app.url, `${updates}/`) } catch { continue }
    if (url.origin !== new URL(updates).origin || url.username || url.password) continue
    builds.push({ key, name, pill, url: url.href, ...(typeof app.size === 'number' ? { size: app.size } : {}) })
  }
  return builds.length ? { track, version: m.version, builds } : null
}

export async function installers(load: Load = fetchJson): Promise<Installers | null> {
  try {
    const stable = await load(`${updates}/install/stable.json`)
    const result = stable ? readManifest(stable, 'stable') : readManifest(await load(`${updates}/install/nightly.json`), 'nightly')
    if (!result) console.warn('No Hexbot Installer in the install manifest, offering the packages alone.')
    return result
  } catch (error) {
    console.warn(`Install manifest unavailable, offering the packages alone: ${(error as Error).message}`)
    return null
  }
}

let cached: Promise<Installers | null> | undefined
export function loadInstallers(): Promise<Installers | null> {
  return (cached ??= installers())
}
