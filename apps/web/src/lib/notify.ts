/**
 * The one way the web bundle shows a notification. The app shows its own,
 * native ones (apps/desktop, `hexbot:notify`), even with its window closed; a
 * browser tab shows the browser's. Either one notifies unless you are looking
 * at the chat it is about: Hexbot in front, that chat on screen. A window
 * behind another app, or another chat, is not looking. Clicking one opens the
 * chat it is about.
 *
 * The app cannot tell whether its system shows them. macOS hides every one
 * until you allow Hexbot, and reports each as shown; so the app sends a test
 * and asks you (`useNotificationsPrompt`).
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

/**
 * The system's page that allows or blocks the app's notifications, and its
 * name there; null in a browser, on a system without one, and in an app from
 * before it could open it.
 */
export function systemNotificationSettings(): null | { name: string; open(): void } {
  const bridge = getBridge()

  const name =
    bridge?.platform === 'darwin'
      ? 'System Settings'
      : bridge?.platform === 'win32'
        ? 'Windows Settings'
        : null

  if (!bridge?.openNotificationSettings || !name) {
    return null
  }

  return {
    name,
    open: () => void Promise.resolve(bridge.openNotificationSettings?.()).catch(() => undefined)
  }
}

/**
 * The banner's answer, kept on this device. A browser: `enabled` once it gave
 * permission. The app: `confirmed` once you saw its test; an `enabled` from
 * before it asked proves nothing, so it asks again. Both: `never`.
 */
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
 * Where the app's banner is: `ask` offers to turn notifications on, `check`
 * has sent a test and asks whether it appeared, `blocked` is your answer that
 * it did not.
 */
export type NotificationsPromptStep = 'ask' | 'blocked' | 'check'

/**
 * The "Turn on notifications" banner. A browser shows it while it can still
 * ask for permission. The app cannot read the system's permission, so Enable
 * sends a test and the banner stays until you say you saw it: one you did not
 * see leads to the system's settings, where Hexbot is allowed.
 */
export function useNotificationsPrompt() {
  const browser = useBrowserNotifications()
  const [answer, setAnswer] = useState(() => stored(() => localStorage, PROMPT_KEY))
  const [closed, setClosed] = useState(() => stored(() => sessionStorage, CLOSED_KEY) === '1')
  const [step, setStep] = useState<NotificationsPromptStep>('ask')

  const remember = (value: 'confirmed' | 'enabled' | 'never') => {
    store(() => localStorage, PROMPT_KEY, value)
    setAnswer(value)
  }

  const visible =
    !closed &&
    (browser.app ? answer !== 'confirmed' && answer !== 'never' : !answer && Boolean(browser.askable))

  return {
    close() {
      store(() => sessionStorage, CLOSED_KEY, '1')
      setClosed(true)
    },
    /** The test appeared: notifications work on this computer. */
    confirm() {
      remember('confirmed')
    },
    /** Turns them on, or sends the app's test again. */
    async enable() {
      if (browser.app) {
        sendTestNotification()
        setStep('check')

        return
      }

      await browser.ask()

      if (browserPermission() === 'granted') {
        remember('enabled')
        sendTestNotification()
      }
    },
    /** The test did not appear. */
    missing() {
      setStep('blocked')
    },
    never() {
      remember('never')
    },
    step,
    visible
  }
}
