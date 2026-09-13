// Recent nightlies, from the index the release workflow keeps on the update
// server (scripts/desktop/update-nightly-index.mjs). Until that file exists
// the list is just the build the feed currently points at.
import { updates, type Downloads } from './nightly'
import { nightlyDate } from './nightly'

export type NightlyEntry = {
  version: string
  date: string
  commit: string
  files: { full: Record<string, string>; client: Record<string, string> }
}
export type NightlyRow = { version: string; day: string; latest: boolean; files: { key: string; label: string; url: string }[] }

const kinds = [
  ['mac-arm64', 'Mac, Apple Silicon', 'mac/arm64'],
  ['mac-x64', 'Mac, Intel', 'mac/x64'],
  ['linux', 'Linux AppImage', 'linux/x64'],
  ['linux-deb', 'Linux deb', 'linux/x64'],
] as const

export function nightlyRows(entries: NightlyEntry[], current?: Pick<Downloads, 'version'> | null): NightlyRow[] {
  const list = entries.filter(e => e.files?.full).slice()
  if (current && !list.some(e => e.version === current.version)) {
    // The feed moved before the index did (or the index is not there yet).
    const files = Object.fromEntries(kinds.map(([key]) => [key, '']))
    list.unshift({ version: current.version, date: '', commit: '', files: { full: files, client: files } })
  }
  return list.map((entry, i) => ({
    version: entry.version,
    day: nightlyDate(entry.version) ?? entry.version,
    latest: i === 0,
    files: kinds
      .filter(([key]) => entry.files.full[key])
      .map(([key, label, dir]) => ({ key, label, url: `${updates}/full/${dir}/${entry.files.full[key]}` })),
  }))
}

export async function loadNightlies(load = fetchJson): Promise<NightlyEntry[]> {
  try {
    const index = (await load(`${updates}/nightlies.json`)) as { nightlies?: NightlyEntry[] }
    return Array.isArray(index?.nightlies) ? index.nightlies : []
  } catch (error) {
    console.warn(`Nightly index unavailable, listing the current build only: ${(error as Error).message}`)
    return []
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return response.json()
}
