import { BrowserWindow, Notification } from 'electron'

export interface NotificationOptions {
  backgroundOnly?: boolean
  title: string
  body: string
  /** The chat a click opens; a room's card has none. */
  sectionId?: string
}
/**
 * Tells the page whether its window is open and not minimized: Chromium's own
 * visibility can stay "visible" after a native close or minimize, and the
 * page marks a chat read only while it is on screen.
 */
export function reportShown(window: BrowserWindow): void {
  const send = () => {
    if (!window.isDestroyed())
      window.webContents.send('hexbot:window-shown', window.isVisible() && !window.isMinimized())
  }
  window.on('show', send)
  window.on('hide', send)
  window.on('minimize', send)
  window.on('restore', send)
  window.on('focus', send)
  // A close hides the window (window-lifecycle.ts), and macOS sends no hide
  // event for it: report once that handler has run.
  window.on('close', () => setImmediate(send))
  window.webContents.on('did-finish-load', send)
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
    if (options.sectionId) window.webContents.send('hexbot:navigate', options.sectionId)
  })
  notification.show()
}
