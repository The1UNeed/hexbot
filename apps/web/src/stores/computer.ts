/**
 * The bots' computer, one Cua sandbox per daemon: what the daemon reports.
 * Loaded when something shows it; `hexbot.computer.changed` keeps it current
 * as it starts, a bot acts, or someone takes over.
 */

import { create } from 'zustand'

import {
  computerConfigure,
  computerControl,
  computerStatus,
  computerStep,
  computerView
} from '../lib/api'
import type { ComputerSize, ComputerStatus } from '../lib/types'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface ComputerStoreState {
  apply: (status: Partial<ComputerStatus>) => void
  configure: (size: ComputerSize) => Promise<void>
  /** Hand the computer to the user, or back to the bots. */
  control: (holder: 'bot' | 'user') => Promise<void>
  /** The last failed request; the daemon's own errors live in the status. */
  error: null | string
  refresh: () => Promise<void>
  status: ComputerStatus | null
  step: (step: 'reset' | 'restart' | 'start' | 'stop') => Promise<void>
  view: (control: boolean) => Promise<null | string>
}

export const useComputer = create<ComputerStoreState>(set => {
  const run = async (request: () => Promise<ComputerStatus>) => {
    try {
      set({ error: null })
      const result = await request()
      set(state => ({ status: { ...state.status, ...result } }))
    } catch (error) {
      set({ error: message(error) })
    }
  }

  return {
    // An event before the first load has no availability or size yet.
    apply: status =>
      set(state => (state.status ? { status: { ...state.status, ...status } } : state)),
    configure: size => run(() => computerConfigure(size)),
    control: holder => run(() => computerControl(holder)),
    error: null,
    refresh: () => run(computerStatus),
    status: null,
    step: step => run(() => computerStep(step)),
    async view(control) {
      try {
        return (await computerView(control)).path
      } catch (error) {
        set({ error: message(error) })

        return null
      }
    }
  }
})
