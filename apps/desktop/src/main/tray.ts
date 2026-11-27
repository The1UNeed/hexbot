import { join } from 'node:path'
import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions } from 'electron'

import type { DaemonManager, DaemonStatus } from './backend/manager'
import { hasRuntime as runtimeAvailable } from './edition'

export interface TrayMenuActions {
  openWindow(): void
  startDaemon(): void
  stopDaemon(): void
  /** Stop bots using this computer (computer.ts); left out before computers. */
  stopComputer?(): void
  quit(): void
}

/** Whether bots may use this computer, and whether one is acting on it now. */
export interface ComputerActivity {
  active: boolean
  allowed: boolean
}

export function trayMenuTemplate(
  status: DaemonStatus,
  actions: TrayMenuActions,
  {
    appName = 'Hexbot',
    hasRuntime = runtimeAvailable,
    computer = { active: false, allowed: false }
  }: { appName?: string; hasRuntime?: boolean; computer?: ComputerActivity } = {}
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
  // While bots may use this computer, the menu says so and stops them.
  const bots = (): MenuItemConstructorOptions[] =>
    computer.allowed && actions.stopComputer
      ? [
          { type: 'separator' },
          { label: computer.active ? 'A bot is using this computer' : 'Bots can use this computer', enabled: false },
          { label: 'Stop bots on this computer', click: actions.stopComputer }
        ]
      : []
  return [
    { label: `Open ${appName}`, click: actions.openWindow },
    ...daemon(),
    ...bots(),
    { type: 'separator' },
    { label: 'Quit', click: actions.quit }
  ]
}

let tray: Tray | undefined
let rebuildMenu: (() => void) | undefined
const activity: ComputerActivity = { active: false, allowed: false }
/** The tray follows what bots may do on this computer and whether one acts now. */
export function setComputerActivity(change: Partial<ComputerActivity>): void {
  Object.assign(activity, change)
  if (!activity.allowed) activity.active = false
  tray?.setToolTip(activity.active ? `${app.name}: a bot is using this computer` : app.name)
  rebuildMenu?.()
}
export function createTray(manager: DaemonManager, openWindow: () => void, stopComputer?: () => void): Tray {
  const icon = nativeImage.createFromPath(
    join(
      app.getAppPath(),
      'resources',
      process.platform === 'darwin' ? 'tray-16.png' : 'tray-32.png'
    )
  )
  if (icon.isEmpty()) throw new Error('Tray icon is missing')
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  tray = new Tray(icon)
  const actions: TrayMenuActions = {
    openWindow,
    startDaemon: () => void manager.start(),
    stopDaemon: () => void manager.stop(),
    stopComputer,
    quit: () => app.quit()
  }
  const rebuild = (status: DaemonStatus): void =>
    tray?.setContextMenu(
      Menu.buildFromTemplate(trayMenuTemplate(status, actions, { appName: app.name, computer: { ...activity } }))
    )
  rebuildMenu = () => rebuild(manager.status())
  rebuild(manager.status())
  manager.on('status', rebuild)
  tray.on('double-click', openWindow)
  if (process.platform !== 'darwin') tray.on('click', openWindow)
  return tray
}
