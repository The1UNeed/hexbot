import { EventEmitter } from 'node:events'
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import {
  changeDesktopState,
  defaultUpdateChannel,
  readUpdateChannel,
  updateDesktopState,
  type UpdateChannel
} from './desktop-state'
import { appId, edition } from './edition'
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
  afterRelaunch,
  remoteReady,
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
  // A prepared update waits for its commit; a background check would clear it.
  if ((reason === 'startup' || reason === 'poll') && remoteHolds()) return current
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

// Update everything (docs/channels.md): another client asks this app,
// through the daemon, to prepare an update, then to install it. T3 Code's
// DesktopRemoteUpdates.ts. The renderer relays requests and reports.

export type RemoteState =
  'preparing' | 'ready' | 'countdown' | 'installing' | 'postponed' | 'failed' | 'not_applied'
export interface RemoteRequest {
  requestId: string
  state: RemoteState
  /** The version downloaded, or the one that didn't apply. */
  version: string | null
  error: string | null
  /** When the countdown installs, while counting down. */
  installsAt: number | null
}

/** A prepared update outlives the daemon's own restart in the same run. */
export const PREPARED_MS = 30 * 60_000
export const REMOTE_COUNTDOWN_MS = 10_000

let remote: RemoteRequest | null = null
let remoteChannel: { previous: UpdateChannel; daemon: string | null } | null = null
let expiry: NodeJS.Timeout | undefined
let countdown: NodeJS.Timeout | undefined

const remoteHolds = (): boolean =>
  !!remote && ['preparing', 'ready', 'countdown', 'installing'].includes(remote.state)

function setRemote(next: RemoteRequest | null): RemoteRequest | null {
  remote = next
  updaterEvents.emit('remote', next)
  return next
}

export function getRemoteRequest(): RemoteRequest | null {
  return remote
}

/** At launch: an update this app was installing for a run that didn't apply. */
export async function readNotApplied(): Promise<void> {
  let found: RemoteRequest | null = null
  await changeDesktopState(saved => {
    const { notApplied, keep } = afterRelaunch(
      saved.pendingInstall,
      appId,
      edition,
      app.getVersion(),
      Date.now()
    )
    if (notApplied)
      found = {
        requestId: notApplied.requestId,
        state: 'not_applied',
        version: notApplied.version,
        error: `${notApplied.version} didn't apply.`,
        installsAt: null
      }
    return { pendingInstall: keep }
  })
  if (found) setRemote(found)
}

function switchInMemory(channel: UpdateChannel): void {
  const current = state!
  if (channel === current.channel) return
  setState(initialUpdateState(current.currentVersion, channel, null))
  applyChannel(channel)
}

function restoreChannel(): void {
  const previous = remoteChannel?.previous
  remoteChannel = null
  if (previous && previous !== state!.channel) {
    switchInMemory(previous)
    void checkForUpdates('track')
  }
}

/**
 * Check and download, ending with the update ready to install. A track for
 * the run switches only in memory until the commit, so a run that rolls back
 * never leaves this app on the other track.
 */
export async function prepareRemote(
  requestId: string,
  track: UpdateChannel | null,
  daemon: string | null
): Promise<RemoteRequest | null> {
  await configure()
  if (remote?.requestId === requestId && remote.state !== 'failed') return remote
  if (state!.status === 'disabled')
    return setRemote({
      requestId,
      state: 'failed',
      version: null,
      error: state!.message,
      installsAt: null
    })
  clearTimeout(expiry)
  setRemote({ requestId, state: 'preparing', version: null, error: null, installsAt: null })
  while (pending) await pending
  remoteChannel = { previous: state!.channel, daemon }
  if (track) switchInMemory(track)
  let current = await checkForUpdates('run')
  if (current.status === 'available') current = await downloadUpdate()
  if (remote?.requestId !== requestId) return remote
  const result = remoteReady(current)
  if (!result.ready) {
    restoreChannel()
    return setRemote({
      requestId,
      state: 'failed',
      version: null,
      error: result.error,
      installsAt: null
    })
  }
  expiry = setTimeout(() => void cancelRemote(requestId, false), PREPARED_MS)
  expiry.unref()
  return setRemote({
    requestId,
    state: 'ready',
    version: result.version,
    error: null,
    installsAt: null
  })
}

/**
 * Install the prepared update. `delayMs` is the countdown: 10 seconds on an
 * app the run reached through the daemon, none on the app that drives it,
 * which counted down already. The deadline runs here, so a hidden window
 * still installs on time.
 */
export async function commitRemote(
  requestId: string,
  delayMs: number
): Promise<RemoteRequest | null> {
  await configure()
  if (remote?.requestId !== requestId || remote.state !== 'ready') return remote
  // Only the version prepared, whatever a later check said.
  if (state!.downloadedVersion !== remote.version)
    return setRemote({ ...remote, state: 'failed', error: 'The prepared update is gone. Retry.' })
  clearTimeout(expiry)
  const install = async (): Promise<void> => {
    const prepared = remote
    if (prepared?.requestId !== requestId || !prepared.version) return
    const version = prepared.version
    const channel = state!.channel
    const switched = !!remoteChannel && remoteChannel.previous !== channel
    const daemon = remoteChannel?.daemon ?? null
    await changeDesktopState(saved => ({
      updateChannel: switched ? channel : saved.updateChannel,
      pendingInstall: {
        ...saved.pendingInstall,
        [appId]: { version, requestId, daemon, edition, expiresAt: Date.now() + PREPARED_MS }
      }
    }))
    remoteChannel = null
    setRemote({ ...prepared, state: 'installing', installsAt: null })
    const result = await installUpdate()
    if (result.status === 'error')
      setRemote({
        ...prepared,
        state: 'failed',
        error: result.message ?? 'The app could not install the update.'
      })
  }
  if (delayMs <= 0) {
    await install()
    return remote
  }
  countdown = setTimeout(() => void install(), delayMs)
  return setRemote({ ...remote, state: 'countdown', installsAt: Date.now() + delayMs })
}

/** "Later", or the run gave up: keep this version and the earlier track. */
export function cancelRemote(requestId: string, later: boolean): RemoteRequest | null {
  if (remote?.requestId !== requestId || remote.state === 'installing') return remote
  clearTimeout(expiry)
  clearTimeout(countdown)
  restoreChannel()
  return setRemote(later ? { ...remote, state: 'postponed', installsAt: null } : null)
}
