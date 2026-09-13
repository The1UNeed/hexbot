import type { MenuItemConstructorOptions } from 'electron'

export interface ApplicationMenuActions {
  checkForUpdates(): void
  openSettings(): void
  quit(): void
}

export function applicationMenuTemplate(
  actions: ApplicationMenuActions,
  appName = 'Hexbot'
): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CommandOrControl+,', click: actions.openSettings },
        { label: 'Check for Updates…', click: actions.checkForUpdates },
        { type: 'separator' },
        { role: 'quit', click: actions.quit }
      ]
    },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]
}
