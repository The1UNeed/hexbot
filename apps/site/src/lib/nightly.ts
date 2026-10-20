// Nightly builds are never committed to the repository (docs/channels.md), so
// the download page reads the nightly electron-updater feed on the update
// server while the site builds and links the files that feed names. The
// release workflow asks Vercel to rebuild the site after every nightly.
// Any failure returns null and the page falls back to the GitHub listing.
export const updates = 'https://updates.hexbot.app'

export type Build = { label: string; url: string; size?: number }
export type Downloads = { version: string; full: Build[]; client: Build[] }

// One row per build on the download page: label, feed directory, feed file, artifact.
const targets = [
  ['macOS, Apple Silicon', 'mac/arm64', 'nightly-mac.yml', /\.dmg$/],
  ['macOS, Intel', 'mac/x64', 'nightly-mac.yml', /\.dmg$/],
  ['Linux AppImage', 'linux/x64', 'nightly-linux.yml', /\.AppImage$/],
  ['Linux deb', 'linux/x64', 'nightly-linux.yml', /\.deb$/]
] as const

// Missing on the server until a Windows package is published. A 404 skips the
// row. A feed that exists with a different version fails the whole set.
const windowsTarget = ['Windows', 'win/x64', 'nightly-win.yml', /\.exe$/] as const

export type FeedFile = { url: string; size?: number }

export function parseFeed(yml: string): { version: string; files: FeedFile[] } | null {
  const version = yml.match(/^version:\s*['"]?([^'"\s]+)/m)?.[1]
  const files: FeedFile[] = []
  for (const line of yml.split('\n')) {
    const url = line.match(/^\s*-\s*url:\s*['"]?([^'"\s]+)/)?.[1]
    const size = line.match(/^\s*size:\s*(\d+)/)?.[1]
    if (url) files.push({ url })
    else if (size && files.length) files[files.length - 1].size = Number(size)
  }
  return version && files.length ? { version, files } : null
}

// "0.1.5-nightly.20260913.2" was built on 13 September 2026.
export function nightlyDate(version: string): string | null {
  const m = version.match(/-nightly\.(\d{4})(\d{2})(\d{2})\./)
  if (!m) return null
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return response.text()
}

export async function nightlyDownloads(load = fetchText): Promise<Downloads | null> {
  try {
    const versions = new Set<string>()
    const missing = (error: unknown) => /\b404\b/.test((error as Error).message ?? '')
    const edition = async (name: 'full' | 'client') => {
      const feeds = new Map<string, FeedFile[] | null>()
      const rows: Build[] = []
      const loadFeed = async (dir: string, feed: string, optional: boolean) => {
        if (feeds.has(dir)) return feeds.get(dir) ?? null
        const url = `${updates}/${name}/${dir}/${feed}`
        try {
          const parsed = parseFeed(await load(url))
          if (!parsed) throw new Error(`${url} is not an update feed`)
          versions.add(parsed.version)
          feeds.set(dir, parsed.files)
          return parsed.files
        } catch (error) {
          if (optional && missing(error)) {
            feeds.set(dir, null)
            return null
          }
          throw error
        }
      }
      for (const [label, dir, feed, artifact] of targets) {
        const files = await loadFeed(dir, feed, false)
        const file = files?.find(item => artifact.test(item.url))
        if (!file) throw new Error(`${updates}/${name}/${dir}/${feed} names no ${artifact.source} file`)
        rows.push({ label, url: `${updates}/${name}/${dir}/${file.url}`, size: file.size })
      }
      const [label, dir, feed, artifact] = windowsTarget
      const windows = await loadFeed(dir, feed, true)
      const exe = windows?.find(item => artifact.test(item.url))
      if (windows && !exe) throw new Error(`${updates}/${name}/${dir}/${feed} names no ${artifact.source} file`)
      if (exe) rows.push({ label, url: `${updates}/${name}/${dir}/${exe.url}`, size: exe.size })
      return rows
    }
    const [full, client] = [await edition('full'), await edition('client')]
    // The macOS and Linux feeds, plus Windows when it is published. One version.
    if (versions.size !== 1) throw new Error(`Nightly feeds disagree: ${[...versions].join(', ')}`)
    return { version: [...versions][0], full, client }
  } catch (error) {
    console.warn(`Nightly downloads unavailable, linking GitHub instead: ${(error as Error).message}`)
    return null
  }
}
