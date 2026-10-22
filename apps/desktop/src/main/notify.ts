import { BrowserWindow, Notification } from 'electron'

export interface NotificationOptions {
  backgroundOnly?: boolean
  title: string
  body: string
  sectionId: string
}
export function notify(options: NotificationOptions, getWindow: () => BrowserWindow | null): void {
  const window = getWindow()
  // Chromium visibility can stay "visible" after native hide/minimize. Check
  // at delivery time, so a reopen racing a reply also stays silent.
  if (options.backgroundOnly && window?.isVisible() && !window.isMinimized()) return
  const notification = new Notification({ title: options.title, body: options.body })
  notification.on('click', () => {
    const window = getWindow()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    window.webContents.send('hexbot:navigate', options.sectionId)
  })
  notification.show()
}
