/**
 * Client-only preferences, persisted to localStorage: theme, right panel,
 * sidebar width and the last opened section (used by `/` to restore the app
 * where the user left it).
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemePreference = 'dark' | 'light' | 'system'

export interface LastSection {
  bot: string
  section: string
}

export interface UiState {
  lastSection: LastSection | null
  rightPanelOpen: boolean
  setLastSection: (value: LastSection | null) => void
  setSidebarWidth: (width: number) => void
  setTheme: (theme: ThemePreference) => void
  sidebarWidth: number
  theme: ThemePreference
  toggleRightPanel: (open?: boolean) => void
}

export const SIDEBAR_MIN_WIDTH = 240
export const SIDEBAR_MAX_WIDTH = 480

export const useUi = create<UiState>()(
  persist(
    set => ({
      lastSection: null,
      rightPanelOpen: true,
      sidebarWidth: 280,
      theme: 'system',

      setTheme(theme) {
        set({ theme })
        applyTheme(theme)
      },

      toggleRightPanel(open) {
        set(state => ({ rightPanelOpen: open ?? !state.rightPanelOpen }))
      },

      setSidebarWidth(width) {
        set({
          sidebarWidth: Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
        })
      },

      setLastSection(value) {
        set({ lastSection: value })
      }
    }),
    { name: 'hexbot.ui', version: 1 }
  )
)

/**
 * Themes follow the system unless the user pinned one; `tokens.css` reads
 * `data-theme` off the document element.
 */
export function applyTheme(theme: ThemePreference): void {
  if (typeof document === 'undefined') {
    return
  }

  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme')

    return
  }

  document.documentElement.setAttribute('data-theme', theme)
}

export function uiActions(): UiState {
  return useUi.getState()
}
