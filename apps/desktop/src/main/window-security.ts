import type { BrowserWindow, Event, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { APP_ORIGIN } from './app-protocol'

export function isRendererUrl(value: string, devUrl?: string): boolean {
  try {
    const url = new URL(value)
    return (
      !url.username &&
      !url.password &&
      ((url.protocol === 'hexbot-app:' && url.host === new URL(APP_ORIGIN).host) ||
        (!!devUrl &&
          ['http:', 'https:'].includes(url.protocol) &&
          url.origin === new URL(devUrl).origin))
    )
  } catch {
    return false
  }
}

export function isTrustedSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  window: BrowserWindow | null,
  devUrl?: string
): boolean {
  return (
    !!window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    isRendererUrl(event.senderFrame.url, devUrl)
  )
}

export function guardWindow(
  contents: WebContents,
  openExternal: (url: string) => Promise<void>,
  devUrl?: string
): void {
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url)
      if (['http:', 'https:'].includes(target.protocol))
        void openExternal(target.href).catch(() => {})
    } catch {
      /* Invalid links stay closed. */
    }
    return { action: 'deny' }
  })
  const blockNavigation = (event: Event, url: string): void => {
    if (!isRendererUrl(url, devUrl)) event.preventDefault()
  }
  contents.on('will-navigate', blockNavigation)
  contents.on('will-redirect', blockNavigation)
  contents.on('will-attach-webview', event => event.preventDefault())
}
