import { EventEmitter } from 'node:events'
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import {
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
}
export const updaterEvents = new EventEmitter()

let configured = false
let downloaded = false

function emit(status: UpdateStatus): void {
  updaterEvents.emit('status', status)
}

async function configureUpdater(): Promise<boolean> {
  if (!app.isPackaged) return false
  if (configured) return true
  configured = true
  autoUpdater.channel = (await readUpdateChannel()) === 'beta' ? 'beta' : 'latest'
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }))
  autoUpdater.on('update-available', () => emit({ state: 'available' }))
  autoUpdater.on('update-not-available', () => emit({ state: 'none' }))
  autoUpdater.on('download-progress', progress =>
    emit({ state: 'downloading', percent: progress.percent })
  )
  autoUpdater.on('update-downloaded', () => {
    downloaded = true
    emit({ state: 'downloaded' })
  })
  autoUpdater.on('error', error => emit({ state: 'error', message: error.message }))
  emit({ state: 'idle' })
  return true
}

export async function checkForUpdates(): Promise<void> {
  if (!(await configureUpdater())) return
  await autoUpdater.checkForUpdates()
}

export async function installUpdate(): Promise<void> {
  if (!(await configureUpdater())) return
  if (downloaded) autoUpdater.quitAndInstall()
  else await autoUpdater.downloadUpdate()
}

export async function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  if (channel !== 'stable' && channel !== 'beta') throw new TypeError('Invalid update channel')
  await updateDesktopState({ updateChannel: channel })
  if (configured) autoUpdater.channel = channel === 'beta' ? 'beta' : 'latest'
}
