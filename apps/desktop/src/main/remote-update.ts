import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import semver from 'semver'
import { bootstrap, selectedNativeVersion } from './backend/bootstrap'
import type { DaemonManager } from './backend/manager'
import { hexbotHome, runtimeDir } from './backend/paths'
import { errorMessage, log } from './log'
import { runRemoteUpdate, type UpdateState } from './updater'

// A client newer than the daemon on this machine can ask the daemon to
// update. When the app runs the daemon, the daemon prints
// HEXBOT_UPDATE_REQUESTED (backend/manager.ts) and the app does the work
// here. Progress goes to <home>/runtime/update-status.json, which the daemon
// reads back for `hexbot.update.status` (backend/hexbot-core/src/services.rs),
// because the app has no channel to the daemon of its own. On success the app
// relaunches and the client sees the daemon come back on the new version.
// When the app already has that version and only its daemon is behind, the
// daemon restarts on the app's runtime instead.
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
    case 'installing':
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

// Whether a daemon on `version` is current for a client on `requested`, by the
// client's own rule (daemonBehind in apps/web/src/lib/version-skew.ts): two
// nightlies compare in full, any other pair by major.minor.patch.
function satisfies(version: string, requested: string): boolean {
  const nightly = (value: string) => semver.prerelease(value)?.[0] === 'nightly'
  if (nightly(version) && nightly(requested)) return semver.gte(version, requested)
  const release = (value: string) => `${semver.major(value)}.${semver.minor(value)}.${semver.patch(value)}`
  return semver.gte(release(version), release(requested))
}

// Prepares the runtime this app ships, which keeps a newer one already in use,
// and restarts the daemon when that runtime satisfies the request. Returns
// whether it reported an outcome: false when there is nothing to restart on,
// so the request ends with the app updater's result.
async function restartOnAppRuntime(
  requested: string,
  daemon: Pick<DaemonManager, 'start' | 'stop'>
): Promise<boolean> {
  try {
    await bootstrap(() => undefined)
  } catch (error) {
    log.warn(`remote update could not prepare the runtime: ${errorMessage(error)}`)
    await writeStatus('failed', { message: errorMessage(error) })
    return true
  }
  const selected = await selectedNativeVersion()
  if (!semver.valid(selected) || !semver.valid(requested) || !satisfies(selected!, requested)) return false
  log.info(`restarting the daemon on ${selected}`)
  await writeStatus('installing', { version: selected })
  await daemon.stop()
  await daemon.start()
  return true
}

export async function handleDaemonUpdateRequest(
  requested: string,
  daemon: Pick<DaemonManager, 'start' | 'stop'>
): Promise<void> {
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
    // Also when this app cannot update itself, as on Linux outside the AppImage.
    if (result.outcome !== 'installing' && (await restartOnAppRuntime(requested, daemon))) return
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
