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

import { useConnection } from './connection'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface ComputerStoreState {
  apply: (status: Partial<ComputerStatus>) => void
  configure: (size: ComputerSize) => Promise<void>
  /** Hand the computer to the user, or back to the bots. */
  control: (holder: 'bot' | 'user') => Promise<void>
  /** The last failed request; the daemon's own errors live in the status. */
  error: null | string
  /** The daemon run (`replay_epoch`) the status was last read from. */
  read: null | string
  refresh: () => Promise<void>
  status: ComputerStatus | null
  step: (step: 'reset' | 'restart' | 'start' | 'stop') => Promise<void>
  /** The last request to take control, answered or not. */
  taking: Promise<void>
  view: (control: boolean) => Promise<null | string>
}

export const useComputer = create<ComputerStoreState>(set => {
  const run = async (request: () => Promise<ComputerStatus>) => {
    try {
      set({ error: null })
      const result = await request()
      set(state => ({ status: { ...state.status, ...result } }))

      return true
    } catch (error) {
      set({ error: message(error) })

      return false
    }
  }

  return {
    // An event before the first load has no availability or size yet.
    apply: status =>
      set(state => (state.status ? { status: { ...state.status, ...status } } : state)),
    async configure(size) {
      await run(() => computerConfigure(size))
    },
    async control(holder) {
      const request = run(() => computerControl(holder)).then(() => undefined)

      if (holder === 'user') {
        set({ taking: request })
      }

      await request
    },
    error: null,
    read: null,
    async refresh() {
      const epoch = useConnection.getState().epoch

      if (await run(computerStatus)) {
        set({ read: epoch })
      }
    },
    status: null,
    taking: Promise.resolve(),
    async step(step) {
      await run(() => computerStep(step))
    },
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
