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
export function sendShown(window: BrowserWindow): void {
  if (!window.isDestroyed())
    window.webContents.send('hexbot:window-shown', window.isVisible() && !window.isMinimized())
}

/**
 * Reports each change of the window's state. macOS sends no hide or show
 * event when the app itself hides the window on close or shows it again, so
 * close is reported once its handler has run (window-lifecycle.ts) and the
 * app reports its own shows (`showWindow`, a notification's click).
 */
export function reportShown(window: BrowserWindow): void {
  const send = () => sendShown(window)
  window.on('show', send)
  window.on('hide', send)
  window.on('minimize', send)
  window.on('restore', send)
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
    sendShown(window)
    if (options.sectionId) window.webContents.send('hexbot:navigate', options.sectionId)
  })
  notification.show()
}
