import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hexbotHome, runtimeDir } from './backend/paths'
import { errorMessage, log } from './log'
import { runRemoteUpdate, type UpdateState } from './updater'

// A client newer than the daemon on this machine can ask the daemon to
// update. When the app runs the daemon, the daemon prints
// HEXBOT_UPDATE_REQUESTED (backend/manager.ts) and the app does the work
// here. Progress goes to <home>/runtime/update-status.json, which the daemon
// reads back for `hexbot.update.status` (hexbot/update.py), because the app
// has no channel to the daemon of its own. On success the app relaunches
// and the client sees the daemon come back on the new version.
export const updateStatusFile = (): string => join(runtimeDir(), 'update-status.json')

export type RemoteStatus =
  'checking' | 'downloading' | 'installing' | 'failed' | 'up-to-date' | 'ignored'

export function remoteStatus(state: UpdateState): RemoteStatus | null {
  switch (state.status) {
    case 'checking':
      return 'checking'
    case 'available':
    case 'downloading':
      return 'downloading'
    case 'downloaded':
      return 'installing'
    case 'error':
      return 'failed'
    case 'up-to-date':
      return 'up-to-date'
    default:
      return null
  }
}

async function writeStatus(
  status: RemoteStatus,
  extra: { percent?: number | null; message?: string | null; version?: string | null } = {}
): Promise<void> {
  try {
    await mkdir(runtimeDir(), { recursive: true })
    await writeFile(
      updateStatusFile(),
      `${JSON.stringify({ status, percent: null, message: null, version: null, ...extra, at: new Date().toISOString() })}\n`
    )
  } catch (error) {
    log.warn(`could not write ${updateStatusFile()}: ${errorMessage(error)}`)
  }
}

let running = false

export async function handleDaemonUpdateRequest(requested: string): Promise<void> {
  if (running) return
  running = true
  log.info(`daemon asked for an app update to ${requested} (home ${hexbotHome()})`)
  await rm(updateStatusFile(), { force: true })
  try {
    const result = await runRemoteUpdate(state => {
      const status = remoteStatus(state)
      if (status)
        void writeStatus(status, {
          percent: state.percent,
          message: state.message,
          version: state.downloadedVersion ?? state.availableVersion
        })
    })
    if (result.outcome !== 'installing') {
      log.warn(`remote update ended: ${result.outcome} ${result.message ?? ''}`)
      await writeStatus(result.outcome === 'up-to-date' ? 'up-to-date' : 'failed', {
        message: result.message
      })
    }
  } finally {
    running = false
  }
}
