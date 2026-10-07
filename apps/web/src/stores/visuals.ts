/**
 * The visuals open beside the chat, as tabs in the side panel. They belong to
 * the chat they were opened from: leaving it closes them all. Not persisted.
 */

import { create } from 'zustand'

import type { Visual } from '../app/conversation/visual'

export interface VisualsState {
  /** The tab shown, by the call that drew it. */
  active: null | string
  activate: (toolId: string) => void
  /** Closes one tab; the panel closes with the last one. */
  close: (toolId: string) => void
  closeAll: () => void
  /** Opens a visual in a new tab, or shows its tab if it is open already. */
  open: (visual: Visual) => void
  tabs: Visual[]
}

export const useVisuals = create<VisualsState>()(set => ({
  active: null,
  tabs: [],

  activate(toolId) {
    set(state => (state.tabs.some(tab => tab.toolId === toolId) ? { active: toolId } : state))
  },

  close(toolId) {
    set(state => {
      const index = state.tabs.findIndex(tab => tab.toolId === toolId)

      if (index < 0) {
        return state
      }

      const tabs = state.tabs.filter(tab => tab.toolId !== toolId)
      // Closing the shown tab shows its neighbour, as a browser does.
      const neighbour = tabs[Math.min(index, tabs.length - 1)]

      return {
        active: state.active === toolId ? (neighbour?.toolId ?? null) : state.active,
        tabs
      }
    })
  },

  closeAll() {
    set({ active: null, tabs: [] })
  },

  open(visual) {
    set(state => ({
      active: visual.toolId,
      tabs: state.tabs.some(tab => tab.toolId === visual.toolId)
        ? state.tabs
        : [...state.tabs, visual]
    }))
  }
}))

export const visualsActions = () => useVisuals.getState()
