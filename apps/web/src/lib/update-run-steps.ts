/**
 * The steps of Update everything that only talk to the daemon, for the web
 * app and the phone alike (lib/update-everything.ts, `RunSteps`). Each step
 * asks, then follows what the daemon and the apps report until they settle.
 */
import type { DaemonUpdateOutcome, DaemonUpdateStatus } from './types'
import type { AppsList, PrepareResult, ReportedApp, RunRow, RunSteps } from './update-everything'

export type Rpc = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Ask `read` until it answers, ignoring errors (the daemon may be restarting). */
async function until<T>(
  read: () => Promise<null | T>,
  timeoutMs: number,
  everyMs = 1_500
): Promise<null | T> {
  const end = Date.now() + timeoutMs

  while (Date.now() < end) {
    try {
      const value = await read()

      if (value !== null) {
        return value
      }
    } catch {
      // Not connected yet.
    }

    await sleep(everyMs)
  }

  return null
}

const PREPARE_MS = 20 * 60_000
const RESTART_MS = 15 * 60_000
const RECONNECT_MS = 2 * 60_000

export type DaemonSteps = Pick<
  RunSteps,
  | 'cancelApp'
  | 'claim'
  | 'commitApp'
  | 'release'
  | 'requestDaemon'
  | 'restartDaemon'
  | 'stageDaemon'
  | 'waitReady'
> & { prepareRemoteApp(row: RunRow, requestId: string): Promise<PrepareResult> }

export function daemonSteps(rpc: Rpc): DaemonSteps {
  const app = async (row: RunRow): Promise<ReportedApp | null> =>
    (await rpc<AppsList>('hexbot.apps.list')).apps.find(
      entry => entry.device === row.device && entry.app_id === row.appId
    ) ?? null

  const request = (row: RunRow, requestId: string, action: 'cancel' | 'commit' | 'prepare') =>
    rpc('hexbot.apps.update', {
      action,
      app_id: row.appId,
      device: row.device,
      request_id: requestId,
      track: row.track,
      version: row.to === 'newest' ? null : row.to
    })

  return {
    claim: async runId => {
      await rpc('hexbot.update.run', { action: 'begin', run_id: runId })
    },
    release: async runId => {
      await rpc('hexbot.update.run', { action: 'end', run_id: runId })
    },
    stageDaemon: async (updateId, version) => {
      try {
        await rpc('hexbot.update.request', { stage_only: true, update_id: updateId, version })
      } catch (error) {
        return { error: message(error), ok: false }
      }

      const status = await until(async () => {
        const current = await rpc<DaemonUpdateStatus>('hexbot.update.status')

        return current.status === 'staged' || current.status === 'failed' ? current : null
      }, PREPARE_MS)

      if (status?.status === 'staged') {
        return { ok: true, version }
      }

      return { error: status?.message ?? 'The daemon could not download its update.', ok: false }
    },
    restartDaemon: async (updateId, version) => {
      await rpc('hexbot.update.request', { update_id: updateId, version })

      // The connection drops and comes back on whichever build kept running.
      const outcome = await until(async () => {
        const status = await rpc<DaemonUpdateStatus>('hexbot.update.status')

        return status.outcome?.id === updateId ? status.outcome : null
      }, RESTART_MS)

      if (!outcome) {
        throw new Error("The daemon didn't come back in time")
      }

      return outcome as DaemonUpdateOutcome
    },
    requestDaemon: async version => {
      await rpc('hexbot.update.request', { version })
    },
    prepareRemoteApp: async (row, requestId) => {
      try {
        await request(row, requestId, 'prepare')
      } catch (error) {
        return { error: message(error), ok: false }
      }

      const settled = await until(async () => {
        const current = (await app(row))?.request

        return current?.id === requestId &&
          (current.state === 'ready' || current.state === 'failed')
          ? current
          : null
      }, PREPARE_MS)

      if (settled?.state === 'ready') {
        return { ok: true, version: settled.downloaded_version }
      }

      return { error: settled?.error ?? `${row.label} didn't download its update`, ok: false }
    },
    waitReady: async (row, requestId) =>
      (await until(async () => {
        const current = (await app(row))?.request

        return current?.id === requestId && current.state === 'ready' ? true : null
      }, RECONNECT_MS)) === true,
    commitApp: async (row, requestId) => {
      try {
        await request(row, requestId, 'commit')
      } catch {
        return 'failed'
      }

      // The countdown runs there, so give it time. An app that left after its
      // countdown or install began is restarting; one that just dropped isn't.
      let committing = false

      const settled = await until(async () => {
        const entry = await app(row)

        if (!entry) {
          return committing ? ('installing' as const) : null
        }

        const state = entry.request?.id === requestId ? entry.request.state : null

        committing ||= state === 'countdown' || state === 'installing'

        return state === 'installing' || state === 'postponed' || state === 'failed' ? state : null
      }, 60_000)

      return settled ?? 'failed'
    },
    cancelApp: async (row, requestId) => {
      // After the daemon restarted the app may not be back yet: keep asking.
      await until(async () => {
        await request(row, requestId, 'cancel')

        return true
      }, RECONNECT_MS)
    }
  }
}

/** A run id or update id: letters and digits, as the daemon takes them. */
export function newId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`

  return random.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)
}
