import { targets, type Downloads } from './downloads'
import type { Installers } from './installers'

export type DownloadChoice = {
  key: string
  name: string
  url: string
  kind: 'installer' | 'full'
}

// The primary button has its own choices, even when the package list is unavailable.
export function downloadChoices(downloads: Downloads | null, installers: Installers | null): DownloadChoice[] {
  return [
    ...(installers?.builds ?? []).map(build => ({ ...build, kind: 'installer' as const })),
    ...(downloads?.full ?? []).flatMap(build => {
      const target = targets.find(target => target.key === build.key)
      return target ? [{ ...target, url: build.url, kind: 'full' as const }] : []
    }),
  ]
}
