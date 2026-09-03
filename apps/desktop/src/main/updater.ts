import { EventEmitter } from 'node:events'
import { app } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

export interface UpdateStatus { state: string; percent?: number; message?: string }
export const updaterEvents = new EventEmitter()

for (const event of ['checking-for-update', 'update-available', 'update-not-available', 'update-downloaded', 'error'] as const) {
  autoUpdater.on(event, (value: unknown) => updaterEvents.emit('status', { state: event, message: value instanceof Error ? value.message : undefined } satisfies UpdateStatus))
}
autoUpdater.on('download-progress', progress => updaterEvents.emit('status', { state: 'downloading', percent: progress.percent } satisfies UpdateStatus))

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    return
  }
  await autoUpdater.checkForUpdatesAndNotify()
}

export function installUpdate(): void { autoUpdater.quitAndInstall() }
