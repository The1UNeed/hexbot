/**
 * Client-only preferences, persisted to localStorage: theme, right panel,
 * sidebar width and the last opened section (used by `/` to restore the app
 * where the user left it). The open thread panel is session state and is not
 * persisted.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemePreference = 'dark' | 'light' | 'system'

export interface LastSection {
  bot: string
  /** install_id of the daemon the section belongs to, when known. */
  daemon?: string
  section: string
}

/** The private conversation the side panel shows: `peer` asking `bot` for help. */
export interface ThreadRef {
  /** The bot that was asked; the thread is a section of its. */
  bot: string
  /** The bot that asked. */
  peer: string
  /** Known once the ask completed; otherwise the panel looks the thread up. */
  sectionId?: string
}

/** The side panel's tabs: the bot at a glance, the files shared in the section, its tool calls. */
export type PanelTab = 'computer' | 'details' | 'library'

export interface UiState {
  closeThread: () => void
  lastSection: LastSection | null
  openThread: (thread: ThreadRef) => void
  /** A finished ask learned the thread's id: fill it in if that thread is open. */
  resolveThread: (bot: string, peer: string, sectionId: string) => void
  /** Opens the side panel on a tab, as the chat's step line does for Computer. */
  openPanel: (tab: PanelTab) => void
  panelTab: PanelTab
  rightPanelOpen: boolean
  setPanelTab: (tab: PanelTab) => void
  setLastSection: (value: LastSection | null) => void
  setSidebarWidth: (width: number) => void
  setTheme: (theme: ThemePreference) => void
  sidebarWidth: number
  theme: ThemePreference
  thread: null | ThreadRef
  /** Bumped when the daemon reports a section changed while a thread is open: read it again. */
  threadChanged: number
  toggleRightPanel: (open?: boolean) => void
  touchThread: (sectionId?: string) => void
}

export const SIDEBAR_MIN_WIDTH = 240
export const SIDEBAR_MAX_WIDTH = 480

export const useUi = create<UiState>()(
  persist(
    set => ({
      lastSection: null,
      panelTab: 'details',
      rightPanelOpen: true,
      sidebarWidth: 280,
      theme: 'system',
      thread: null,
      threadChanged: 0,

      setTheme(theme) {
        set({ theme })
        applyTheme(theme)
      },

      openPanel(tab) {
        set({ panelTab: tab, rightPanelOpen: true })
      },

      setPanelTab(tab) {
        set({ panelTab: tab })
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
      },

      openThread(thread) {
        set({ thread })
      },

      closeThread() {
        set({ thread: null })
      },

      // Only the open thread's changes matter, or any change while its id is still unknown.
      touchThread(sectionId) {
        set(state =>
          state.thread &&
          (!state.thread.sectionId || !sectionId || sectionId === state.thread.sectionId)
            ? { threadChanged: state.threadChanged + 1 }
            : state
        )
      },

      resolveThread(bot, peer, sectionId) {
        set(state =>
          state.thread && state.thread.bot === bot && state.thread.peer === peer
            ? { thread: { ...state.thread, sectionId: state.thread.sectionId ?? sectionId } }
            : state
        )
      }
    }),
    {
      name: 'hexbot.ui',
      partialize: ({ lastSection, rightPanelOpen, sidebarWidth, theme }) => ({
        lastSection,
        rightPanelOpen,
        sidebarWidth,
        theme
      }),
      version: 1
    }
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
