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

/** Whether you are using the window: shown, not minimized, and in front of other apps. */
export function windowInFront(window: BrowserWindow | null): boolean {
  return Boolean(
    window &&
    !window.isDestroyed() &&
    window.isVisible() &&
    !window.isMinimized() &&
    window.isFocused()
  )
}

/**
 * macOS asks once whether Hexbot may notify, the first time the app touches
 * notifications. Until Allow is chosen it shows nothing the app sends, and
 * still reports each one as shown; a question that goes unanswered, or goes
 * away as the app quits, is never asked again. So ask as the window opens,
 * while you are looking, not with a first reply you then miss.
 */
export function askToNotify(platform: string = process.platform): void {
  if (platform === 'darwin') Notification.isSupported()
}

/**
 * The system's own page for Hexbot's notifications, or null where there is
 * none to open. macOS opens at Hexbot when it knows the app's bundle id.
 */
export function notificationSettingsUrl(platform: string, bundleId?: string): string | null {
  if (platform === 'darwin')
    return `x-apple.systempreferences:com.apple.Notifications-Settings.extension${bundleId ? `?id=${encodeURIComponent(bundleId)}` : ''}`
  return platform === 'win32' ? 'ms-settings:notifications' : null
}

/**
 * Notifications still on screen or in the system's list. Electron drops a
 * notification's click as soon as nothing refers to it, while the system
 * keeps showing it; the newest stay here until clicked or closed.
 */
const shown: Notification[] = []
const SHOWN_MAX = 50

/**
 * Shows a native notification. `backgroundOnly` is for the chat on screen: it
 * stays silent only while the window is in front. A window left open behind
 * another app still notifies. Checked at delivery time, so a switch racing a
 * reply goes the right way. `failed` hears what the system refused to take;
 * one that macOS takes and then hides, because Hexbot is not allowed to
 * notify, is not reported by anyone (`askToNotify`).
 */
export function notify(
  options: NotificationOptions,
  getWindow: () => BrowserWindow | null,
  failed: (error: string) => void = () => undefined
): void {
  const window = getWindow()
  if (options.backgroundOnly && windowInFront(window)) return
  const notification = new Notification({ title: options.title, body: options.body })
  const forget = () => {
    const index = shown.indexOf(notification)
    if (index >= 0) shown.splice(index, 1)
  }
  notification.on('click', () => {
    forget()
    const window = getWindow()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    sendShown(window)
    if (options.sectionId) window.webContents.send('hexbot:navigate', options.sectionId)
  })
  notification.on('close', forget)
  notification.on('failed', (_event, error) => {
    forget()
    failed(error)
  })
  shown.push(notification)
  if (shown.length > SHOWN_MAX) shown.shift()
  notification.show()
}
