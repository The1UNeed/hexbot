import { join } from 'node:path'
import { Menu, Tray, app, nativeImage } from 'electron'

import type { DaemonManager, DaemonStatus } from './backend/manager'
import { hasRuntime } from './edition'

let tray: Tray | undefined
export function createTray(manager: DaemonManager, openWindow: () => void): Tray {
  const icon = nativeImage.createFromPath(
    join(
      app.getAppPath(),
      'resources',
      process.platform === 'darwin' ? 'tray-16.png' : 'tray-32.png'
    )
  )
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  tray = new Tray(icon)
  const rebuild = (status: DaemonStatus): void =>
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: `Open ${app.name}`,
          click: openWindow
        },
        ...(hasRuntime
          ? [
              { label: `Daemon: ${status.state}`, enabled: false },
              status.state === 'running' || status.state === 'starting'
                ? { label: 'Stop daemon', click: () => void manager.stop() }
                : { label: 'Start daemon', click: () => void manager.start() }
            ]
          : [{ label: 'Client-only app', enabled: false }]),
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
      ])
    )
  rebuild(manager.status())
  manager.on('status', rebuild)
  tray.on('double-click', openWindow)
  return tray
}
