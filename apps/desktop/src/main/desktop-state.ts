import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hexbotHome } from './backend/paths'

export type UpdateChannel = 'stable' | 'beta'
export interface DesktopState {
  crashReports?: boolean
  height?: number
  updateChannel?: UpdateChannel
  width?: number
  x?: number
  y?: number
}

export const desktopStateFile = (): string => join(hexbotHome(), 'desktop-state.json')

export async function readDesktopState(file = desktopStateFile()): Promise<DesktopState> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    return value && typeof value === 'object' ? (value as DesktopState) : {}
  } catch {
    return {}
  }
}

export async function updateDesktopState(
  patch: Partial<DesktopState>,
  file = desktopStateFile()
): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ ...(await readDesktopState(file)), ...patch })}\n`)
}

export async function readUpdateChannel(file = desktopStateFile()): Promise<UpdateChannel> {
  const channel = (await readDesktopState(file)).updateChannel
  return channel === 'beta' ? 'beta' : 'stable'
}
