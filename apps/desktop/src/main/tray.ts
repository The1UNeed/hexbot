import { join } from 'node:path'
import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions } from 'electron'

import type { DaemonManager, DaemonStatus } from './backend/manager'
import { hasRuntime as runtimeAvailable } from './edition'

export interface TrayMenuActions {
  openWindow(): void
  startDaemon(): void
  stopDaemon(): void
  quit(): void
}

export function trayMenuTemplate(
  status: DaemonStatus,
  actions: TrayMenuActions,
  { appName = 'Hexbot', hasRuntime = runtimeAvailable } = {}
): MenuItemConstructorOptions[] {
  const daemon = (): MenuItemConstructorOptions[] => {
    if (!hasRuntime) return [{ label: 'Client-only app', enabled: false }]
    // A service or another copy of the app owns the daemon; this app cannot stop it.
    if (status.state === 'external') return [{ label: 'Daemon: running outside this app', enabled: false }]
    return [
      { label: `Daemon: ${status.state}`, enabled: false },
      status.state === 'running' || status.state === 'starting'
        ? { label: 'Stop daemon', click: actions.stopDaemon }
        : { label: 'Start daemon', click: actions.startDaemon }
    ]
  }
  return [
    { label: `Open ${appName}`, click: actions.openWindow },
    ...daemon(),
    { type: 'separator' },
    { label: 'Quit', click: actions.quit }
  ]
}

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
  const actions: TrayMenuActions = {
    openWindow,
    startDaemon: () => void manager.start(),
    stopDaemon: () => void manager.stop(),
    quit: () => app.quit()
  }
  const rebuild = (status: DaemonStatus): void =>
    tray?.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(status, actions, { appName: app.name })))
  rebuild(manager.status())
  manager.on('status', rebuild)
  tray.on('double-click', openWindow)
  return tray
}
