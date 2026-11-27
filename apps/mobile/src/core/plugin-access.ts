import { useSyncExternalStore } from 'react'
import type { Flip, Staged } from '../../../web/src/lib/plugin-access'
import type { Plugin } from './types'

/**
 * What the plugins table holds between visits: the changes that wait for
 * review, the last ones applied (for Undo), and the grants rows are grouped
 * by. Kept outside the page, so opening a plugin or a bot and coming back
 * loses nothing. Another daemon starts empty.
 */
export interface AccessState {
  /** The daemon these belong to. */
  daemon: string
  last: { flips: Flip[]; text: string } | null
  /** The grants before the last apply: rows stay grouped by them, so none moves. */
  pinned: Plugin[] | null
  staged: Staged
}

const fresh = (daemon: string): AccessState => ({ daemon, last: null, pinned: null, staged: {} })

let state = fresh('')
const listeners = new Set<() => void>()

export function setAccess(change: (current: AccessState) => Partial<AccessState>): void {
  state = { ...state, ...change(state) }
  for (const listener of listeners) listener()
}

/** The table's state for `daemon`; a different daemon than last time starts empty. */
export function useAccess(daemon: string): AccessState {
  if (state.daemon !== daemon) state = fresh(daemon)
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
    () => state
  )
}
