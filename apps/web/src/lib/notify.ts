/**
 * The one way the web bundle shows a notification. The app shows its own,
 * native ones (apps/desktop, `hexbot:notify`), even with its window closed; a
 * browser tab shows the browser's. Either one notifies unless you are looking
 * at the chat it is about: Hexbot in front, that chat on screen. A window
 * behind another app, or another chat, is not looking. Clicking one opens the
 * chat it is about.
 */

import { useCallback, useState } from 'react'

import { getBridge } from './bridge'
import { pageFocused, sectionShown } from './page-visible'

/** A browser notification asks the app shell to open a section (routes/__root.tsx). */
export const OPEN_SECTION_EVENT = 'hexbot:open-section'
/** A notification shows a few lines; the whole message is in the chat. Under the app's limit. */
export const NOTIFY_BODY = 1_000

export interface NotifyInput {
  body: string
  sectionId?: string
  title: string
}

export function notifyUser(input: NotifyInput): void {
  const body =
    input.body.length > NOTIFY_BODY ? `${input.body.slice(0, NOTIFY_BODY - 1)}…` : input.body

  // The chat on screen; you see it land if Hexbot is in front.
  const shown = sectionShown(input.sectionId)
  const bridge = getBridge()

  if (bridge) {
    // The app checks its window's focus again as it shows it, so a switch
    // away in between still notifies. It refuses what it cannot show; nothing waits on it.
    void Promise.resolve(bridge.notify({ ...input, backgroundOnly: shown, body })).catch(
      () => undefined
    )

    return
  }

  if ((shown && pageFocused()) || browserPermission() !== 'granted') {
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
    app,
    ask,
    /** Asking would show the browser's prompt. */
    askable: !app && permission === 'default' && window.isSecureContext,
    /** This page cannot notify: a LAN address over plain HTTP. */
    insecure: !app && permission !== 'unsupported' && !window.isSecureContext,
    permission
  }
}

/** One notification now, to show they work here. */
export function sendTestNotification(): void {
  notifyUser({
    body: 'You will see one like this when a bot replies or needs you.',
    title: 'Notifications are on'
  })
}

/** The banner's answer, kept on this device: turned on here, or not to ask again. */
const PROMPT_KEY = 'hexbot.notifications.prompt'
/** Closed with its ✕: back the next time Hexbot opens. */
const CLOSED_KEY = 'hexbot.notifications.prompt.closed'

function stored(storage: () => Storage, key: string): null | string {
  try {
    return storage().getItem(key)
  } catch {
    return null
  }
}

function store(storage: () => Storage, key: string, value: string): void {
  try {
    storage().setItem(key, value)
  } catch {
    // Private windows may refuse; the banner then only hides for now.
  }
}

/**
 * The "Turn on notifications" banner. A browser shows it while it can still
 * ask for permission. The app cannot read the system's permission, so it shows
 * it until Enable sends a first notification, which is when macOS asks.
 */
export function useNotificationsPrompt() {
  const browser = useBrowserNotifications()
  const [answer, setAnswer] = useState(() => stored(() => localStorage, PROMPT_KEY))
  const [closed, setClosed] = useState(() => stored(() => sessionStorage, CLOSED_KEY) === '1')

  const remember = (value: 'enabled' | 'never') => {
    store(() => localStorage, PROMPT_KEY, value)
    setAnswer(value)
  }

  const visible = !closed && !answer && (browser.app || Boolean(browser.askable))

  return {
    close() {
      store(() => sessionStorage, CLOSED_KEY, '1')
      setClosed(true)
    },
    async enable() {
      if (!browser.app) {
        await browser.ask()
      }

      if (browser.app || browserPermission() === 'granted') {
        remember('enabled')
        sendTestNotification()
      }
    },
    never() {
      remember('never')
    },
    visible
  }
}
