/**
 * Connection target and status. The supervisor in `src/lib/connection.ts`
 * writes here; components only read. The target (with its device token) is
 * kept in the Keychain and loaded once at startup (`loaded`).
 */

import { create } from 'zustand'

import { readSecure, writeSecure } from '../lib/storage'
import type { ConnectionStatus, ConnectionTarget, DaemonInfo } from '../lib/types'

const TARGET_KEY = 'hexbot.target'

export type RemoteTarget = Extract<ConnectionTarget, { kind: 'remote' }>

export interface ConnectionState {
  attempt: number
  clearTarget: () => void
  daemon: DaemonInfo | null
  /** `replay_epoch` from the last `gateway.ready`. */
  epoch: null | string
  error: null | string
  /** False until the saved target has been read from the Keychain. */
  loaded: boolean
  setDaemon: (daemon: DaemonInfo | null) => void
  setEpoch: (epoch: null | string) => void
  setStatus: (status: ConnectionStatus, options?: { attempt?: number; error?: null | string }) => void
  setTarget: (target: RemoteTarget | null) => void
  status: ConnectionStatus
  target: null | RemoteTarget
}

function isTarget(value: unknown): value is RemoteTarget {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Record<string, unknown>

  return (
    candidate.kind === 'remote' &&
    typeof candidate.host === 'string' &&
    typeof candidate.port === 'number' &&
    typeof candidate.deviceToken === 'string' &&
    typeof candidate.tls === 'boolean'
  )
}

export const useConnection = create<ConnectionState>(set => ({
  attempt: 0,
  daemon: null,
  epoch: null,
  error: null,
  loaded: false,
  status: 'idle',
  target: null,

  setStatus(status, options = {}) {
    set(state => ({
      attempt: options.attempt ?? state.attempt,
      error: options.error === undefined ? (status === 'connected' ? null : state.error) : options.error,
      status
    }))
  },

  setTarget(target) {
    void writeSecure(TARGET_KEY, target)
    set({ target })
  },

  clearTarget() {
    void writeSecure(TARGET_KEY, null)
    set({ daemon: null, epoch: null, target: null })
  },

  setDaemon(daemon) {
    set({ daemon })
  },

  setEpoch(epoch) {
    set({ epoch })
  }
}))

/** Read the saved target once at startup. */
export async function loadStoredTarget(): Promise<null | RemoteTarget> {
  const stored = await readSecure<unknown>(TARGET_KEY)
  const target = isTarget(stored) ? stored : null

  useConnection.setState({ loaded: true, target })

  return target
}

export function connectionActions(): ConnectionState {
  return useConnection.getState()
}
