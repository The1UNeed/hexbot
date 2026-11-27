/**
 * Whether the page is on screen, and whether you are using it. A browser says
 * so with `document.hidden` and `document.hasFocus()`; the app's page can stay
 * "visible" after its window is closed or minimized, so the app tells it
 * (apps/desktop, `hexbot:window-shown`).
 */

import { useSyncExternalStore } from 'react'

import { getBridge } from './bridge'

let windowShown = true
let listening = false
/** The chat on screen, set by the roster; null on settings and other pages. */
let shownSection: null | string = null
const listeners = new Set<() => void>()

const changed = () => listeners.forEach(listener => listener())

function subscribe(update: () => void): () => void {
  if (!listening) {
    listening = true
    getBridge()?.onWindowShown?.(shown => {
      windowShown = shown
      changed()
    })
  }

  listeners.add(update)
  document.addEventListener('visibilitychange', update)
  window.addEventListener('focus', update)
  window.addEventListener('blur', update)

  return () => {
    listeners.delete(update)
    document.removeEventListener('visibilitychange', update)
    window.removeEventListener('focus', update)
    window.removeEventListener('blur', update)
  }
}

export function pageVisible(): boolean {
  return windowShown && !document.hidden
}

/** On screen and in front: a window behind another app is visible, not focused. */
export function pageFocused(): boolean {
  return pageVisible() && document.hasFocus()
}

export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, pageVisible)
}

export function usePageFocused(): boolean {
  return useSyncExternalStore(subscribe, pageFocused)
}

export function setShownSection(section: null | string): void {
  shownSection = section
}

/**
 * The chat or room this page shows, whether or not you are looking at it. A
 * room's conversations are `room:<room>:<section>`; the room is `room:<room>`.
 */
export function sectionShown(section?: null | string): boolean {
  if (!section || !shownSection) {
    return false
  }

  return section === shownSection || section.startsWith(`${shownSection}:`)
}
