/**
 * Unsent composer text per section, persisted to localStorage so a draft
 * survives switching sections and reloads. The roster lists a section with
 * a draft as if it had been sent in, marked with a pencil.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

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
    { name: 'hexbot.drafts', version: 1 }
  )
)

export function draftsActions(): DraftsState {
  return useDrafts.getState()
}
