/**
 * Connection target and status. The supervisor in `src/lib/connection.ts`
 * writes here; components only read.
 */

import { create } from 'zustand'

import type { ConnectionStatus, ConnectionTarget, DaemonInfo } from '../lib/types'

const TARGET_KEY = 'hexbot.target'

export interface ConnectionState {
  attempt: number
  clearTarget: () => void
  daemon: DaemonInfo | null
  error: null | string
  /** `replay_epoch` from the last `gateway.ready`. */
  epoch: null | string
  setDaemon: (daemon: DaemonInfo | null) => void
  setEpoch: (epoch: null | string) => void
  setStatus: (
    status: ConnectionStatus,
    options?: { attempt?: number; error?: null | string }
  ) => void
  setTarget: (target: ConnectionTarget | null) => void
  status: ConnectionStatus
  target: ConnectionTarget | null
}

function isTarget(value: unknown): value is ConnectionTarget {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Record<string, unknown>

  if (candidate.kind === 'local') {
    return candidate.origin === undefined || typeof candidate.origin === 'string'
  }

  return (
    candidate.kind === 'remote' &&
    typeof candidate.host === 'string' &&
    typeof candidate.port === 'number' &&
    typeof candidate.deviceToken === 'string' &&
    typeof candidate.tls === 'boolean'
  )
}

/** The stored target, including the device token for remote daemons. */
export function readStoredTarget(): ConnectionTarget | null {
  if (typeof localStorage === 'undefined') {
    return null
  }

  try {
    const raw = localStorage.getItem(TARGET_KEY)

    if (!raw) {
      return resolveOriginTarget()
    }

    const parsed: unknown = JSON.parse(raw)

    return isTarget(parsed) ? parsed : null
  } catch {
    return resolveOriginTarget()
  }
}

/** Adopt a daemon-served web bundle without persisting its origin-bound target. */
function resolveOriginTarget(): ConnectionTarget | null {
  const e2eTarget = typeof window !== 'undefined' ? window.hexbot?.e2eTarget : undefined

  if (e2eTarget) {
    return { kind: 'local', origin: e2eTarget }
  }

  if (
    typeof window !== 'undefined' &&
    !window.hexbot &&
    window.location.protocol.startsWith('http') &&
    typeof window.__HERMES_AUTH_REQUIRED__ !== 'undefined'
  ) {
    return { kind: 'local' }
  }

  return null
}

export function writeStoredTarget(target: ConnectionTarget | null): void {
  if (typeof localStorage === 'undefined') {
    return
  }

  try {
    if (target) {
      localStorage.setItem(TARGET_KEY, JSON.stringify(target))
    } else {
      localStorage.removeItem(TARGET_KEY)
    }
  } catch {
    // A blocked storage (private mode) only costs us the saved target.
  }
}

export const useConnection = create<ConnectionState>(set => ({
  attempt: 0,
  daemon: null,
  epoch: null,
  error: null,
  status: 'idle',
  target: readStoredTarget(),

  setStatus(status, options = {}) {
    set(state => ({
      attempt: options.attempt ?? state.attempt,
      error:
        options.error === undefined ? (status === 'connected' ? null : state.error) : options.error,
      status
    }))
  },

  setTarget(target) {
    writeStoredTarget(target)
    set({ target })
  },

  clearTarget() {
    writeStoredTarget(null)
    set({ daemon: null, target: null })
  },

  setDaemon(daemon) {
    set({ daemon })
  },

  setEpoch(epoch) {
    set({ epoch })
  }
}))

export function connectionActions(): ConnectionState {
  return useConnection.getState()
}

export function useIsConnected(): boolean {
  return useConnection(state => state.status === 'connected')
}
