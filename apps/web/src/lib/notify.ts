/**
 * The one way the web bundle shows a notification. The app shows its own,
 * native ones (apps/desktop, `hexbot:notify`), even with its window closed; a
 * browser tab shows one only while it is in the background. Clicking either
 * opens the chat it is about.
 */

import { useCallback, useState } from 'react'

import { getBridge } from './bridge'

/** A browser notification asks the app shell to open a section (routes/__root.tsx). */
export const OPEN_SECTION_EVENT = 'hexbot:open-section'
/** A notification shows a few lines; the whole message is in the chat. Under the app's limit. */
export const NOTIFY_BODY = 1_000

export interface NotifyInput {
  /** Only when the app's window is hidden or minimized; a browser tab is always background-only. */
  backgroundOnly?: boolean
  body: string
  sectionId?: string
  title: string
}

export function notifyUser(input: NotifyInput): void {
  const body =
    input.body.length > NOTIFY_BODY ? `${input.body.slice(0, NOTIFY_BODY - 1)}…` : input.body

  const bridge = getBridge()

  if (bridge) {
    // The app refuses what it cannot show; nothing waits on it.
    void Promise.resolve(bridge.notify({ ...input, body })).catch(() => undefined)

    return
  }

  if (!document.hidden || browserPermission() !== 'granted') {
    return
  }

  const notification = new Notification(input.title, { body })

  notification.onclick = () => {
    window.focus()

    if (input.sectionId) {
      window.dispatchEvent(new CustomEvent(OPEN_SECTION_EVENT, { detail: input.sectionId }))
    }
  }
}

export type BrowserPermission = 'unsupported' | NotificationPermission

export function browserPermission(): BrowserPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

/**
 * Whether this browser can be asked to show notifications, and a way to ask.
 * The app needs no permission; a browser gives one only to HTTPS or this
 * computer, and only from a click.
 */
export function useBrowserNotifications() {
  const [permission, setPermission] = useState(browserPermission)

  const app = Boolean(getBridge())

  const ask = useCallback(async () => {
    if (app || browserPermission() !== 'default' || !window.isSecureContext) {
      return
    }

    setPermission(await Notification.requestPermission())
  }, [app])

  return {
    ask,
    /** Asking would show the browser's prompt. */
    askable: !app && permission === 'default' && window.isSecureContext,
    /** This page cannot notify: a LAN address over plain HTTP. */
    insecure: !app && permission !== 'unsupported' && !window.isSecureContext,
    permission
  }
}
