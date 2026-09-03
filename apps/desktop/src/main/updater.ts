import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

export function checkForUpdates(): void {
  if (!app.isPackaged) {
    return
  }

  void autoUpdater.checkForUpdatesAndNotify().catch(error => {
    console.error('Update check failed', error)
  })
}
