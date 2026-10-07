/**
 * Unsent composer text per section, persisted to AsyncStorage so a draft
 * survives switching sections and reloads. The roster lists a section with
 * a draft as if it had been sent in, marked with a pencil.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { persistStorage } from '../lib/storage'

export interface DraftsState {
  byId: Record<string, string>
  clear: (sectionId: string) => void
  set: (sectionId: string, text: string) => void
}

export const useDrafts = create<DraftsState>()(
  persist(
    set => ({
      byId: {},

      set(sectionId, text) {
        set(state => {
          const byId = { ...state.byId }

          if (text.trim()) {
            byId[sectionId] = text
          } else {
            delete byId[sectionId]
          }

          return { byId }
        })
      },

      clear(sectionId) {
        set(state => {
          if (!(sectionId in state.byId)) {
            return state
          }

          const byId = { ...state.byId }
          delete byId[sectionId]

          return { byId }
        })
      }
    }),
    { name: 'hexbot.drafts', storage: persistStorage, version: 1 }
  )
)

export function draftsActions(): DraftsState {
  return useDrafts.getState()
}
