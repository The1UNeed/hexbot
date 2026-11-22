/**
 * The bots' computer, one Cua sandbox per daemon: what the daemon reports.
 * Loaded when something shows it; `hexbot.computer.changed` keeps it current
 * as it starts, a bot acts, or the user pauses the bots.
 */

import { create } from 'zustand'

import {
  computerConfigure,
  computerControl,
  computerStatus,
  computerStep,
  computerView
} from '../lib/api'
import type { ComputerQuality, ComputerSize, ComputerStatus } from '../lib/types'

import { type ConnectionState, useConnection } from './connection'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function currentConnection({ connects, target }: ConnectionState): boolean {
  const current = useConnection.getState()

  return current.target === target && current.connects === connects
}

export interface ComputerStoreState {
  apply: (status: Partial<ComputerStatus>) => void
  configure: (size: ComputerSize) => Promise<void>
  /** Pause the bots (`user`), so the user has the computer alone, or resume them (`bot`). */
  control: (holder: 'bot' | 'user') => Promise<void>
  /** The last failed request; the daemon's own errors live in the status. */
  error: null | string
  /** The connection (`connects`) the status was last read on. */
  read: null | number
  refresh: () => Promise<void>
  status: ComputerStatus | null
  step: (step: 'reset' | 'restart' | 'start' | 'stop') => Promise<void>
  view: (control: boolean, quality?: ComputerQuality) => Promise<null | string>
}

export const useComputer = create<ComputerStoreState>(set => {
  let latestRead = 0

  const run = async (request: () => Promise<ComputerStatus>, reading = false) => {
    const connection = useConnection.getState()
    const read = reading ? ++latestRead : null

    const current = () => currentConnection(connection) && (read === null || read === latestRead)

    try {
      set({ error: null })
      const result = await request()

      // An answer from a daemon the app has since left describes another computer.
      if (!current()) {
        return
      }

      set(state => ({
        status: { ...state.status, ...result },
        ...(reading && { read: connection.connects })
      }))
    } catch (error) {
      if (current()) {
        set({ error: message(error) })
      }
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
      await run(() => computerControl(holder))
    },
    error: null,
    read: null,
    async refresh() {
      await run(computerStatus, true)
    },
    status: null,
    async step(step) {
      await run(() => computerStep(step))
    },
    async view(control, quality) {
      const connection = useConnection.getState()

      try {
        const { path } = await computerView(control, quality)

        return currentConnection(connection) ? path : null
      } catch (error) {
        if (currentConnection(connection)) {
          set({ error: message(error) })
        }

        return null
      }
    }
  }
})
