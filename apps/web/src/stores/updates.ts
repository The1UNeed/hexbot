/**
 * App and daemon updates (docs/channels.md, "Updating").
 *
 * `app` mirrors the desktop updater over the bridge, so every window and the
 * roster pill see the same state as Settings. `daemon` follows an update the
 * user asked the connected daemon to run on its own machine: the daemon
 * reports progress over `hexbot.update.status` until it restarts, and the
 * update is done once the connection comes back on the requested version.
 */

import { create } from 'zustand'

import { updateRequest, updateStatus } from '../lib/api'
import { getBridge, type UpdateState } from '../lib/bridge'
import type { DaemonUpdateStatus } from '../lib/types'
import { daemonBehind } from '../lib/version-skew'

import { useConnection } from './connection'

export const DAEMON_UPDATE_POLL_MS = 2_000
export const DAEMON_UPDATE_TIMEOUT_MS = 20 * 60_000

export interface DaemonUpdate {
  message: null | string
  percent: null | number
  status: DaemonUpdateStatus['status']
  /** The version the daemon was asked for. */
  target: string
}

export interface UpdatesState {
  app: null | UpdateState
  daemon: DaemonUpdate | null
  setApp: (app: null | UpdateState) => void
  setDaemon: (daemon: DaemonUpdate | null) => void
}

export const useUpdates = create<UpdatesState>(set => ({
  app: null,
  daemon: null,
  setApp: app => set({ app }),
  setDaemon: daemon => set({ daemon })
}))

/** Mirror the desktop updater into the store; no-op in a browser. */
export function bindAppUpdates(): () => void {
  const bridge = getBridge()

  if (!bridge) {
    return () => undefined
  }

  const off = bridge.updater.onStatus(state => useUpdates.getState().setApp(state))

  void bridge.updater
    .state()
    .then(state => useUpdates.getState().setApp(state))
    .catch(() => undefined)

  return off
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Ask the connected daemon to update to `version`, then follow it until it is back. */
export async function updateDaemon(version: string): Promise<void> {
  const store = useUpdates.getState()

  if (store.daemon && store.daemon.status !== 'failed') {
    return
  }

  store.setDaemon({ message: null, percent: null, status: 'requested', target: version })

  try {
    await updateRequest(version)
  } catch (error) {
    store.setDaemon({ message: errorText(error), percent: null, status: 'failed', target: version })

    return
  }

  followDaemonUpdate(version)
}

export function dismissDaemonUpdate(): void {
  useUpdates.getState().setDaemon(null)
}

function followDaemonUpdate(target: string, now: () => number = Date.now): void {
  const started = now()
  let polling = false

  const finish = (result: DaemonUpdate | null) => {
    clearInterval(timer)
    unsubscribe()
    useUpdates.getState().setDaemon(result)
  }

  const check = () => {
    const current = useUpdates.getState().daemon

    if (!current || current.target !== target) {
      clearInterval(timer)
      unsubscribe()

      return
    }

    const { daemon, status } = useConnection.getState()

    // Back on the requested version (or a newer one): done.
    if (status === 'connected' && daemon && !daemonBehind(target, daemon.version)) {
      finish(null)

      return
    }

    if (now() - started > DAEMON_UPDATE_TIMEOUT_MS) {
      finish({
        ...current,
        message: 'The daemon did not come back on the new version in time.',
        status: 'failed'
      })

      return
    }

    if (status !== 'connected' || polling) {
      return
    }

    polling = true
    updateStatus()
      .then(result => {
        if (result.status === 'failed' || result.status === 'up-to-date') {
          finish({
            ...current,
            message: result.message ?? 'The daemon could not update.',
            status: 'failed'
          })
        } else if (result.status !== 'idle') {
          useUpdates.getState().setDaemon({
            ...current,
            message: result.message,
            percent: result.percent,
            status: result.status
          })
        }
      })
      .catch(() => undefined)
      .finally(() => {
        polling = false
      })
  }

  const timer = setInterval(check, DAEMON_UPDATE_POLL_MS)
  const unsubscribe = useConnection.subscribe(check)
}
