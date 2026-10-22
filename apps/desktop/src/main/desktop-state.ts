import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hexbotHome } from './backend/paths'

// The update track the app follows (docs/channels.md). Stable installs default
// to stable, nightly installs to nightly; the user can switch in Settings.
export type UpdateChannel = 'stable' | 'nightly'
export interface DesktopState {
  crashReports?: boolean
  height?: number
  backgroundExplained?: boolean
  updateChannel?: UpdateChannel
  width?: number
  x?: number
  y?: number
}

export const desktopStateFile = (): string => join(hexbotHome(), 'desktop-state.json')

export const isNightlyVersion = (version: string): boolean => /-nightly\.\d{8}\.\d+$/.test(version)
export const defaultUpdateChannel = (version: string): UpdateChannel =>
  isNightlyVersion(version) ? 'nightly' : 'stable'

export async function readDesktopState(file = desktopStateFile()): Promise<DesktopState> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    return value && typeof value === 'object' ? (value as DesktopState) : {}
  } catch {
    return {}
  }
}

// Bounds, update track, and the background notice can change together.
const writes = new Map<string, Promise<void>>()

export function updateDesktopState(
  patch: Partial<DesktopState>,
  file = desktopStateFile()
): Promise<void> {
  const next = (writes.get(file) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${JSON.stringify({ ...(await readDesktopState(file)), ...patch })}\n`)
    })
  writes.set(file, next)
  return next.finally(() => {
    if (writes.get(file) === next) writes.delete(file)
  })
}

export async function readUpdateChannel(
  fallback: UpdateChannel = 'stable',
  file = desktopStateFile()
): Promise<UpdateChannel> {
  const channel = (await readDesktopState(file)).updateChannel
  return channel === 'stable' || channel === 'nightly' ? channel : fallback
}
