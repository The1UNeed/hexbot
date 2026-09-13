import { EventEmitter } from 'node:events'
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import {
  defaultUpdateChannel,
  readUpdateChannel,
  updateDesktopState,
  type UpdateChannel
} from './desktop-state'

const { autoUpdater } = electronUpdater

export type UpdateState =
  'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'none' | 'error'
export interface UpdateStatus {
  state: UpdateState
  percent?: number
  message?: string
  version?: string
}
export const updaterEvents = new EventEmitter()

// Feed file names on updates.hexbot.app: latest-<os>.yml for stable and
// nightly-<os>.yml for nightly (scripts/desktop/update-feed-utils.mjs).
const feedChannel: Record<UpdateChannel, string> = { stable: 'latest', nightly: 'nightly' }

let configured = false
let downloaded = false

function emit(status: UpdateStatus): void {
  updaterEvents.emit('status', status)
}

function applyChannel(channel: UpdateChannel): void {
  autoUpdater.channel = feedChannel[channel]
  // A stable version sorts below the nightlies built after it, and vice
  // versa; moving between tracks is a deliberate choice, so let it through.
  autoUpdater.allowDowngrade = channel !== defaultUpdateChannel(app.getVersion())
}

async function configureUpdater(): Promise<boolean> {
  if (!app.isPackaged || __HEXBOT_CHANNEL__ === 'dev') return false
  if (configured) return true
  configured = true
  applyChannel(await getUpdateChannel())
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }))
  autoUpdater.on('update-available', info => emit({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => emit({ state: 'none' }))
  autoUpdater.on('download-progress', progress =>
    emit({ state: 'downloading', percent: progress.percent })
  )
  autoUpdater.on('update-downloaded', info => {
    downloaded = true
    emit({ state: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', error => emit({ state: 'error', message: error.message }))
  emit({ state: 'idle' })
  return true
}

// Resolves with the outcome so Settings can show it; the same outcome also
// arrives through updaterEvents for every window.
export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!(await configureUpdater()))
    return { state: 'idle', message: 'Dev builds do not check for updates.' }
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result?.isUpdateAvailable) return { state: 'none' }
    return { state: 'available', version: result.updateInfo.version }
  } catch (error) {
    return { state: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

export async function installUpdate(): Promise<void> {
  if (!(await configureUpdater())) return
  if (downloaded) autoUpdater.quitAndInstall()
  else await autoUpdater.downloadUpdate()
}

export function getUpdateChannel(): Promise<UpdateChannel> {
  return readUpdateChannel(defaultUpdateChannel(app.getVersion()))
}

export async function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  if (channel !== 'stable' && channel !== 'nightly') throw new TypeError('Invalid update channel')
  await updateDesktopState({ updateChannel: channel })
  if (configured) applyChannel(channel)
}
