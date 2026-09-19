import { EventEmitter } from 'node:events'
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import {
  defaultUpdateChannel,
  readUpdateChannel,
  updateDesktopState,
  type UpdateChannel
} from './desktop-state'
import { errorMessage, log } from './log'
import {
  disabledReason,
  initialUpdateState,
  nextAction,
  onAvailable,
  onCheckError,
  onCheckStart,
  onDownloadError,
  onDownloadStart,
  onDownloaded,
  onInstallError,
  onInstallStart,
  onProgress,
  onUpToDate,
  versionChannel,
  type UpdateState
} from './update-state'

export type { UpdateState } from './update-state'

const { autoUpdater } = electronUpdater

// T3 Code's cadence: one check shortly after launch, then every few minutes,
// so an install never has to be told about a nightly by hand.
export const STARTUP_CHECK_DELAY_MS = 15_000
export const POLL_INTERVAL_MS = 4 * 60_000

// Feed file names on updates.hexbot.app: latest-<os>.yml for stable and
// nightly-<os>.yml for nightly (scripts/desktop/update-feed-utils.mjs).
const feedChannel: Record<UpdateChannel, string> = { stable: 'latest', nightly: 'nightly' }

/** Every state change, for the windows and for a daemon-requested update. */
export const updaterEvents = new EventEmitter()

let state: UpdateState | undefined
let configuring: Promise<void> | undefined
let active: 'check' | 'download' | 'install' | null = null
let pending: Promise<UpdateState> | undefined

const now = (): string => new Date().toISOString()

function setState(next: UpdateState): void {
  state = next
  updaterEvents.emit('state', next)
}

function applyChannel(channel: UpdateChannel): void {
  autoUpdater.channel = feedChannel[channel]
  // A stable version sorts below the nightlies built after it, and vice
  // versa; moving between tracks is a deliberate choice, so let it through.
  autoUpdater.allowDowngrade = channel !== defaultUpdateChannel(app.getVersion())
}

function getUpdateChannel(): Promise<UpdateChannel> {
  return readUpdateChannel(defaultUpdateChannel(app.getVersion()))
}

// Sets up electron-updater once; callers read `state` after awaiting it.
function configure(): Promise<void> {
  configuring ??= (async () => {
    const channel = await getUpdateChannel()
    const disabled = disabledReason({
      packaged: app.isPackaged,
      channel: __HEXBOT_CHANNEL__,
      platform: process.platform,
      appImage: process.env.APPIMAGE
    })
    setState(initialUpdateState(app.getVersion(), channel, disabled))
    if (disabled) {
      log.info(`updater off: ${disabled}`)
      return
    }
    autoUpdater.logger = log
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    applyChannel(channel)
    autoUpdater.on('update-available', info => {
      // Both tracks share one bucket; a version from the other track can only
      // show up after a switch, and then the next check on the new track
      // replaces it.
      if (versionChannel(info.version) !== state!.channel) {
        log.info(`ignoring ${info.version}: not on the ${state!.channel} track`)
        setState(onUpToDate(state!, now()))
        return
      }
      setState(onAvailable(state!, info.version, now()))
    })
    autoUpdater.on('update-not-available', () => setState(onUpToDate(state!, now())))
    autoUpdater.on('download-progress', progress => {
      const next = onProgress(state!, progress.percent)
      if (next.percent !== state!.percent) setState(next)
    })
    autoUpdater.on('update-downloaded', info => setState(onDownloaded(state!, info.version)))
    // Errors inside a check or download reject that call and are handled
    // there. An install fails after quitAndInstall returned, so it only
    // shows up here; anything else electron-updater reports lands here too.
    autoUpdater.on('error', error => {
      if (active === 'install') {
        active = null
        log.error(`update install failed: ${errorMessage(error)}`)
        setState(onInstallError(state!, errorMessage(error)))
      } else if (!active) setState(onCheckError(state!, errorMessage(error), now()))
    })
    setTimeout(() => void checkForUpdates('startup'), STARTUP_CHECK_DELAY_MS).unref()
    setInterval(() => void checkForUpdates('poll'), POLL_INTERVAL_MS).unref()
  })()
  return configuring
}

export async function getUpdateState(): Promise<UpdateState> {
  await configure()
  return state!
}

/** Resolves once the check has finished, with the resulting state. */
export async function checkForUpdates(reason: string): Promise<UpdateState> {
  await configure()
  const current = state!
  if (current.status === 'disabled') return current
  if (pending) return pending
  if (active) return current
  active = 'check'
  pending = (async () => {
    setState(onCheckStart(state!))
    log.info(`checking for updates (${reason}, ${state!.channel} track)`)
    try {
      const result = await autoUpdater.checkForUpdates()
      // The events above already moved the state; a null result means
      // electron-updater declined to look at all.
      if (!result) setState(onUpToDate(state!, now()))
    } catch (error) {
      log.error(`update check failed: ${errorMessage(error)}`)
      setState(onCheckError(state!, errorMessage(error), now()))
    } finally {
      active = null
      pending = undefined
    }
    return state!
  })()
  return pending
}

/** Resolves once the download has finished or failed. */
export async function downloadUpdate(): Promise<UpdateState> {
  await configure()
  const current = state!
  if (nextAction(current) !== 'download') return current
  if (pending) return pending
  if (active) return current
  active = 'download'
  pending = (async () => {
    setState(onDownloadStart(state!))
    log.info(`downloading ${state!.availableVersion}`)
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      log.error(`update download failed: ${errorMessage(error)}`)
      setState(onDownloadError(state!, errorMessage(error)))
    } finally {
      active = null
      pending = undefined
    }
    return state!
  })()
  return pending
}

/** Quits and relaunches on the downloaded version. Resolves only on failure. */
export async function installUpdate(): Promise<UpdateState> {
  await configure()
  const current = state!
  if (nextAction(current) !== 'install' || active) return current
  active = 'install'
  log.info(`installing ${current.downloadedVersion}`)
  // Tells the windows to show the restart notice, and the main process to let
  // them close: quitAndInstall closes every window before `before-quit` fires.
  setState(onInstallStart(current))
  try {
    autoUpdater.quitAndInstall(true, true)
  } catch (error) {
    active = null
    log.error(`update install failed: ${errorMessage(error)}`)
    setState(onInstallError(state!, errorMessage(error)))
  }
  return state!
}

export async function readUpdateChannelSetting(): Promise<UpdateChannel> {
  await configure()
  return state!.channel
}

/** Switch tracks and look at the new one right away. */
export async function setUpdateChannel(channel: UpdateChannel): Promise<UpdateState> {
  if (channel !== 'stable' && channel !== 'nightly') throw new TypeError('Invalid update channel')
  await configure()
  const current = state!
  await updateDesktopState({ updateChannel: channel })
  if (channel === current.channel) return current
  if (active) throw new Error('Wait for the current update to finish before switching tracks.')
  const disabled = current.status === 'disabled' ? current.message : null
  setState(initialUpdateState(current.currentVersion, channel, disabled))
  if (disabled) return state!
  applyChannel(channel)
  return checkForUpdates('track')
}

export type RemoteUpdateOutcome = 'installing' | 'up-to-date' | 'failed'

/**
 * A daemon on this machine asked, on behalf of a newer client, for the app
 * to update itself. Check, download, and install without anyone at the
 * keyboard; `report` sees every state along the way. On success the app
 * quits and comes back on the new version, so the promise resolves only when
 * there is nothing to install or something failed.
 */
export async function runRemoteUpdate(
  report: (state: UpdateState) => void
): Promise<{ outcome: RemoteUpdateOutcome; message: string | null }> {
  const relay = (next: UpdateState): void => report(next)
  updaterEvents.on('state', relay)
  try {
    let current = await checkForUpdates('daemon')
    if (current.status === 'checking') current = await (pending ?? Promise.resolve(current))
    if (current.status === 'available') current = await downloadUpdate()
    if (current.status === 'downloading') current = await (pending ?? Promise.resolve(current))
    if (nextAction(current) === 'install') {
      current = await installUpdate()
      if (current.status !== 'error') return { outcome: 'installing', message: null }
    }
    if (current.status === 'up-to-date')
      return {
        outcome: 'up-to-date',
        message: `The app is already up to date on ${current.currentVersion} (${current.channel} track).`
      }
    return { outcome: 'failed', message: current.message ?? 'The app could not update.' }
  } finally {
    updaterEvents.off('state', relay)
  }
}
