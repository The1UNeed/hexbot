/**
 * Whether the page is on screen. A browser says so with `document.hidden`; the
 * app's page can stay "visible" after its window is closed or minimized, so
 * the app tells it (apps/desktop, `hexbot:window-shown`).
 */

import { useSyncExternalStore } from 'react'

import { getBridge } from './bridge'

let windowShown = true
let listening = false
const listeners = new Set<() => void>()

function subscribe(update: () => void): () => void {
  if (!listening) {
    listening = true
    getBridge()?.onWindowShown?.(shown => {
      windowShown = shown
      listeners.forEach(listener => listener())
    })
  }

  listeners.add(update)
  document.addEventListener('visibilitychange', update)

  return () => {
    listeners.delete(update)
    document.removeEventListener('visibilitychange', update)
  }
}

export function pageVisible(): boolean {
  return windowShown && !document.hidden
}

export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, pageVisible)
}
