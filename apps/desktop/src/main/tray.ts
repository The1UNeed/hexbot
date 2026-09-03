import { join } from 'node:path'
import { BrowserWindow, Menu, Tray, app, nativeImage } from 'electron'

import type { DaemonManager, DaemonStatus } from './backend/manager'

let tray: Tray | undefined
export function createTray(manager: DaemonManager, openWindow: () => BrowserWindow): Tray {
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources', process.platform === 'darwin' ? 'tray-16.png' : 'tray-32.png'))
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  tray = new Tray(icon)
  const rebuild = (status: DaemonStatus): void => tray?.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Hexbot', click: () => { const window = openWindow(); window.show(); window.focus() } },
    { label: `Daemon: ${status.state}`, enabled: false },
    status.state === 'running' || status.state === 'starting'
      ? { label: 'Stop daemon', click: () => void manager.stop() }
      : { label: 'Start daemon', click: () => void manager.start() },
    { type: 'separator' }, { label: 'Quit', click: () => app.quit() }
  ]))
  rebuild(manager.status()); manager.on('status', rebuild)
  tray.on('double-click', () => openWindow().show())
  return tray
}

export function destroyTray(): void { tray?.destroy(); tray = undefined }
