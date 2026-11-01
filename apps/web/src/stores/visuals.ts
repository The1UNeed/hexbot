/**
 * Visuals and files open beside the chat, as tabs in the side panel. They
 * belong to the chat they were opened from: leaving it closes them all. Not
 * persisted.
 */

import { create } from 'zustand'

import type { Visual } from '../app/conversation/visual'

/** A file the user attached or the bot wrote, opened beside the chat. */
export interface FileTab {
  file: {
    mime: string
    /** Where the daemon keeps it; absent for a file only this page holds. */
    path?: string
    /** The chat takes the user's messages, so the quick tools may ask in it. */
    askable?: boolean
    /** The chat it was opened from. Its live session changes when the daemon restarts. */
    sectionId?: string
    /** The live session it was opened from, used until the chat's current one is known. */
    sessionId: string
    /** An object URL for a file this page still holds, such as a PDF just sent. */
    url?: string
  }
  title: string
  /** `file:` and the path or URL, so opening the same file again shows its tab. */
  toolId: string
}

export type SideTab = FileTab | Visual

export const isFileTab = (tab: SideTab): tab is FileTab => 'file' in tab

export function fileTab(title: string, file: FileTab['file']): FileTab {
  return { file, title, toolId: `file:${file.path ?? file.url ?? title}` }
}

export interface VisualsState {
  /** The tab shown, by the call that drew it or the file's id. */
  active: null | string
  activate: (toolId: string) => void
  /** Closes one tab; the panel closes with the last one. */
  close: (toolId: string) => void
  closeAll: () => void
  /** Opens a visual or a file in a new tab, or shows its tab if it is open already. */
  open: (tab: SideTab) => void
  tabs: SideTab[]
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

  open(tab) {
    set(state => ({
      active: tab.toolId,
      tabs: state.tabs.some(item => item.toolId === tab.toolId) ? state.tabs : [...state.tabs, tab]
    }))
  }
}))

export const visualsActions = () => useVisuals.getState()
