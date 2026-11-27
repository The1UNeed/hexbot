// The desktop updater's state, mirrored to every window over IPC (the
// `updater` bridge). Transitions are pure so they can be tested without
// Electron; updater.ts wires them to electron-updater. Modelled on T3 Code's
// updateMachine.ts (docs/channels.md, "Borrowed from T3 Code").
import { isNightlyVersion, type PendingInstall, type UpdateChannel } from './desktop-state'

export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'up-to-date'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  channel: UpdateChannel
  currentVersion: string
  availableVersion: string | null
  downloadedVersion: string | null
  /** 0..100 while downloading. */
  percent: number | null
  /** Why updates are disabled, or the last error. */
  message: string | null
  /** When the last check finished. */
  checkedAt: string | null
  /** The step the last error came from, so the UI offers the right retry. */
  errorContext: 'check' | 'download' | 'install' | null
}

export type UpdateAction = 'check' | 'download' | 'install' | null

export function initialUpdateState(
  currentVersion: string,
  channel: UpdateChannel,
  disabled: string | null
): UpdateState {
  return {
    status: disabled ? 'disabled' : 'idle',
    channel,
    currentVersion,
    availableVersion: null,
    downloadedVersion: null,
    percent: null,
    message: disabled,
    checkedAt: null,
    errorContext: null
  }
}

export function disabledReason(input: {
  packaged: boolean
  channel: string
  platform: string
  appImage?: string
}): string | null {
  if (input.channel === 'dev') return 'Dev builds do not check for updates.'
  if (!input.packaged) return 'Only packaged builds check for updates.'
  if (input.platform === 'linux' && !input.appImage)
    return 'Updates on Linux need the AppImage package.'
  return null
}

/** Which track a version belongs to; a feed entry from the other track is ignored. */
export const versionChannel = (version: string): UpdateChannel =>
  isNightlyVersion(version) ? 'nightly' : 'stable'

export const onCheckStart = (state: UpdateState): UpdateState => ({
  ...state,
  status: 'checking',
  message: null,
  errorContext: null
})

export const onAvailable = (state: UpdateState, version: string, at: string): UpdateState => ({
  ...state,
  status: state.downloadedVersion === version ? 'downloaded' : 'available',
  availableVersion: version,
  percent: state.downloadedVersion === version ? 100 : null,
  message: null,
  checkedAt: at,
  errorContext: null
})

export const onUpToDate = (state: UpdateState, at: string): UpdateState => ({
  ...state,
  status: 'up-to-date',
  availableVersion: null,
  downloadedVersion: null,
  percent: null,
  message: null,
  checkedAt: at,
  errorContext: null
})

export const onCheckError = (state: UpdateState, message: string, at: string): UpdateState => ({
  ...state,
  status: 'error',
  message,
  percent: null,
  checkedAt: at,
  errorContext: 'check'
})

export const onDownloadStart = (state: UpdateState): UpdateState => ({
  ...state,
  status: 'downloading',
  percent: 0,
  message: null,
  errorContext: null
})

export const onProgress = (state: UpdateState, percent: number): UpdateState =>
  state.status === 'downloading' ? { ...state, percent: Math.floor(percent) } : state

export const onDownloaded = (state: UpdateState, version: string): UpdateState => ({
  ...state,
  status: 'downloaded',
  availableVersion: version,
  downloadedVersion: version,
  percent: 100,
  message: null,
  errorContext: null
})

export const onDownloadError = (state: UpdateState, message: string): UpdateState => ({
  ...state,
  status: 'error',
  message,
  percent: null,
  errorContext: 'download'
})

/** Install was asked for: the app is about to close and reopen on the new version. */
export const onInstallStart = (state: UpdateState): UpdateState => ({
  ...state,
  status: 'installing',
  message: null,
  errorContext: null
})

export const onInstallError = (state: UpdateState, message: string): UpdateState => ({
  ...state,
  status: 'error',
  message,
  errorContext: 'install'
})

/** The one action the UI offers for a state, or null while it must wait. */
export function nextAction(state: UpdateState): UpdateAction {
  if (
    state.downloadedVersion &&
    (state.status === 'downloaded' ||
      (state.status === 'error' && state.errorContext === 'install'))
  )
    return 'install'
  if (state.status === 'available') return 'download'
  if (state.status === 'error' && state.errorContext === 'download' && state.availableVersion)
    return 'download'
  if (state.status === 'idle' || state.status === 'up-to-date' || state.status === 'error')
    return 'check'
  return null
}

/**
 * Where a prepare for Update everything ended: a download ready to install,
 * or why not. T3 Code's remote update flow (DesktopRemoteUpdates.ts).
 */
export function remoteReady(
  state: UpdateState
): { ready: true; version: string } | { ready: false; error: string } {
  if (state.status === 'downloaded' && state.downloadedVersion)
    return { ready: true, version: state.downloadedVersion }
  if (state.status === 'up-to-date')
    return {
      ready: false,
      error: `Nothing newer on the ${state.channel === 'nightly' ? 'Nightly' : 'Stable'} track.`
    }
  return { ready: false, error: state.message ?? 'The app could not download the update.' }
}

/**
 * After a relaunch: the update this app was installing for a run, if it didn't
 * apply, and what stays saved. Entries for this app go, and so do entries of
 * the same edition the running version satisfies (a track switch changes the
 * app id).
 */
export function afterRelaunch(
  pending: Record<string, PendingInstall> | undefined,
  appId: string,
  edition: 'full' | 'client',
  version: string,
  now: number
): { notApplied: PendingInstall | null; keep: Record<string, PendingInstall> } {
  const keep: Record<string, PendingInstall> = {}
  let notApplied: PendingInstall | null = null
  for (const [id, entry] of Object.entries(pending ?? {})) {
    if (id === appId) {
      if (entry.version !== version && entry.expiresAt > now) notApplied = entry
    } else if (!(entry.edition === edition && entry.version === version) && entry.expiresAt > now) {
      keep[id] = entry
    }
  }
  return { notApplied, keep }
}
