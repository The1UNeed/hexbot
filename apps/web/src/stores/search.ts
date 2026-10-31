/**
 * Search in the side panel: whether it is open, what was typed, and the
 * message a result asked the conversation to show. It belongs to the
 * conversation it was opened in: leaving it resets everything. Not persisted.
 */

import { create } from 'zustand'

export interface SearchState {
  close: () => void
  /** A message to scroll to and flash: its id in a bot's chat, its seq in a room. */
  jump: null | { id: string; nonce: number }
  jumpTo: (id: string) => void
  open: boolean
  query: string
  reset: () => void
  setOpen: (open: boolean) => void
  setQuery: (query: string) => void
}

export const useSearch = create<SearchState>()(set => ({
  jump: null,
  open: false,
  query: '',

  close() {
    set({ open: false })
  },

  // A fresh nonce, so showing the same result twice scrolls to it again.
  jumpTo(id) {
    set(state => ({ jump: { id, nonce: (state.jump?.nonce ?? 0) + 1 } }))
  },

  reset() {
    set({ jump: null, open: false, query: '' })
  },

  setOpen(open) {
    set({ open })
  },

  setQuery(query) {
    set({ query })
  }
}))

export const searchActions = () => useSearch.getState()
