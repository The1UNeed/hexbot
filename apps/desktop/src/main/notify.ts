import { BrowserWindow, Notification } from 'electron'

export interface NotificationOptions { title: string; body: string; sectionId: string }
export function notify(options: NotificationOptions, getWindow: () => BrowserWindow | null): void {
  const notification = new Notification({ title: options.title, body: options.body })
  notification.on('click', () => {
    const window = getWindow(); if (!window) return
    if (window.isMinimized()) window.restore()
    window.show(); window.focus(); window.webContents.send('hexbot:navigate', options.sectionId)
  })
  notification.show()
}
