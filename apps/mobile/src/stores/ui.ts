/**
 * Phone preferences, persisted to AsyncStorage: theme and the last opened
 * section. `threadChanged` is bumped when the daemon reports that a bot's
 * private thread with another bot changed, so an open thread view refetches.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { persistStorage } from '../lib/storage'

export type ThemePreference = 'dark' | 'light' | 'system'

export interface LastSection {
  bot: string
  /** `install_id` of the daemon the section belongs to. */
  daemon?: null | string
  section: string
}

export interface UiState {
  lastSection: LastSection | null
  setLastSection: (value: LastSection | null) => void
  setTheme: (theme: ThemePreference) => void
  theme: ThemePreference
  threadChanged: number
  touchThread: (sectionId?: string) => void
}

export const useUi = create<UiState>()(
  persist(
    set => ({
      lastSection: null,
      theme: 'system',
      threadChanged: 0,

      setLastSection(lastSection) {
        set({ lastSection })
      },

      setTheme(theme) {
        set({ theme })
      },

      touchThread() {
        set(state => ({ threadChanged: state.threadChanged + 1 }))
      }
    }),
    {
      name: 'hexbot.ui',
      partialize: ({ lastSection, theme }) => ({ lastSection, theme }),
      storage: persistStorage,
      version: 1
    }
  )
)

export function uiActions(): UiState {
  return useUi.getState()
}
