/**
 * Update everything from this client (docs/channels.md, "Updating everything
 * at once"): the fleet as the daemon sees it, the plan, and the run this
 * client drives. T3 Code's useUpdateEverything.ts. The run is saved before
 * this app relaunches into its own update; the relaunched app follows what
 * is still restarting and shows one result.
 */

import { create } from 'zustand'

import { appsList, daemonInfo, updateCheck } from '../lib/api'
import { getBridge } from '../lib/bridge'
import { rpcCall } from '../lib/rpc'
import {
  type AppsList,
  collectTargets,
  type DaemonCheck,
  describeResult,
  type Fleet,
  type Plan,
  type RunState,
  type RunSteps,
  runUpdateEverything,
  type Track,
  trackOf
} from '../lib/update-everything'
import { daemonSteps, newId } from '../lib/update-run-steps'

import { useConnection } from './connection'
import { useUpdates } from './updates'

const SAVED = 'hexbot:update-run'
const SAVED_MS = 30 * 60_000
export const COUNTDOWN_SECONDS = 5

export interface UpdateRunStore {
  check: DaemonCheck | null
  apps: AppsList | null
  plan: Plan | null
  run: RunState | null
  /** Seconds left on this app's countdown, while it counts. */
  countdown: null | number
  /** The daemon has Update everything (`app_updates` in hexbot.info). */
  supported: boolean
  refresh: () => Promise<void>
  start: () => Promise<void>
  later: () => void
  dismiss: () => void
  /** Switch the daemon, and with it every app, to a track; resolves with the new plan. */
  setTrack: (track: Track) => Promise<Plan | null>
}

let skipCountdown: (() => void) | null = null

function thisApp(): Fleet['thisApp'] {
  const bridge = getBridge()
  const updater = useUpdates.getState().app

  if (!bridge?.appId || !bridge.updater.prepare) {
    return null
  }

  return {
    appId: bridge.appId,
    // Its own report says whether it runs the daemon; the daemon has it.
    hostsDaemon: false,
    platform: bridge.platform,
    track: updater?.channel ?? trackOf(bridge.version),
    updater: updater
      ? {
          availableVersion: updater.availableVersion,
          downloadedVersion: updater.downloadedVersion,
          status: updater.status
        }
      : null,
    version: bridge.version
  }
}

function plan(
  check: DaemonCheck | null,
  apps: AppsList | null,
  runId?: null | string
): Plan | null {
  const daemon = useConnection.getState().daemon

  if (!daemon || !apps) {
    return null
  }

  const self = thisApp()
  const own = apps.apps.find(app => app.current)

  return collectTargets({
    apps,
    check,
    daemon: { capability: daemon.update_capability ?? null, version: daemon.version },
    runId,
    thisApp: self ? { ...self, hostsDaemon: own?.hosts_daemon ?? false } : null
  })
}

function steps(): RunSteps {
  const daemon = daemonSteps(<T>(method: string, params?: Record<string, unknown>) =>
    rpcCall<T>(method, params ?? {})
  )

  const updater = () => getBridge()?.updater

  return {
    ...daemon,
    prepareApp: async (row, requestId) => {
      if (row.kind !== 'this-app') {
        return daemon.prepareRemoteApp(row, requestId)
      }

      const result = await updater()?.prepare?.(
        requestId,
        row.track,
        useConnection.getState().daemon?.install_id ?? null
      )

      return result?.state === 'ready'
        ? { ok: true, version: result.version }
        : { error: result?.error ?? 'This app could not download the update.', ok: false }
    },
    countdown: () =>
      new Promise<boolean>(resolve => {
        let left = COUNTDOWN_SECONDS

        useUpdateRun.setState({ countdown: left })

        const timer = setInterval(() => {
          left -= 1
          useUpdateRun.setState({ countdown: left })

          if (left <= 0) {
            done(true)
          }
        }, 1_000)

        const done = (go: boolean) => {
          clearInterval(timer)
          skipCountdown = null
          useUpdateRun.setState({ countdown: null })
          resolve(go)
        }

        skipCountdown = () => done(false)
      }),
    save: state => {
      localStorage.setItem(SAVED, JSON.stringify({ savedAt: Date.now(), state }))
    },
    commitThisApp: async requestId => {
      const result = await updater()?.commit?.(requestId, false)

      if (result?.state === 'installing') {
        // The app quits and relaunches; nothing after this runs.
        await new Promise(() => undefined)
      }
    },
    cancelThisApp: async requestId => {
      await updater()?.cancel?.(requestId, false)
    },
    id: newId
  }
}

export const useUpdateRun = create<UpdateRunStore>((set, get) => ({
  apps: null,
  check: null,
  countdown: null,
  plan: null,
  run: null,
  supported: false,
  refresh: async () => {
    const daemon = useConnection.getState().daemon

    if (!daemon?.app_updates) {
      set({ apps: null, check: null, plan: null, supported: false })

      return
    }

    const [apps, check] = await Promise.all([
      appsList().catch(() => null),
      updateCheck().catch(() => null)
    ])

    set({ apps, check, plan: plan(check, apps, get().run?.runId), supported: true })
  },
  start: async () => {
    const current = get().plan

    if (!current?.actionable || (get().run && !get().run?.result)) {
      return
    }

    await runUpdateEverything(current, steps(), state => set({ run: state }))
    localStorage.removeItem(SAVED)
    void get().refresh()
  },
  later: () => skipCountdown?.(),
  setTrack: async track => {
    const check = await rpcCall<DaemonCheck>('hexbot.update.set_track', { track })
    const apps = await appsList().catch(() => get().apps)
    const next = plan(check, apps, get().run?.runId)

    set({ apps, check, plan: next })

    return next
  },
  dismiss: () => {
    set({ run: null })
    // The tab that drove the run reloads now, onto the daemon's new bundle.
    const version = useConnection.getState().daemon?.version

    if (
      !getBridge() &&
      !import.meta.env.DEV &&
      servedVersion &&
      version &&
      version !== servedVersion
    ) {
      window.location.reload()
    }
  }
}))

/** The daemon version that served this page, in a browser. */
let servedVersion: null | string = null

/** Replan whenever an app reports or this app's updater changes. */
export function replan(): void {
  const { apps, check, run } = useUpdateRun.getState()

  useUpdateRun.setState({ plan: plan(check, apps, run?.runId) })
}

useUpdates.subscribe((state, previous) => {
  if (state.app !== previous.app) {
    replan()
  }
})

/**
 * After this app relaunched into its update: follow what was still
 * restarting, then end the run with one result.
 */
export async function resumeSavedRun(): Promise<void> {
  const raw = localStorage.getItem(SAVED)

  if (!raw) {
    return
  }

  localStorage.removeItem(SAVED)
  let saved: { savedAt: number; state: RunState }

  try {
    saved = JSON.parse(raw) as { savedAt: number; state: RunState }
  } catch {
    return
  }

  if (Date.now() - saved.savedAt > SAVED_MS) {
    return
  }

  const state = saved.state
  const bridge = getBridge()

  // This app's restart may have restarted the daemon too: wait for it.
  await connected(2 * 60_000)
  const remote = await bridge?.updater.remote?.().catch(() => null)

  for (const row of state.rows) {
    if (row.status !== 'updating') {
      continue
    }

    if (row.kind === 'this-app') {
      const applied = bridge && bridge.version !== row.from && remote?.state !== 'not_applied'

      row.status = applied ? 'done' : 'failed'
      row.message = applied
        ? `Updated to ${bridge.version}`
        : `${remote?.version ?? 'The update'} didn't apply`
    } else if (row.kind === 'daemon') {
      const info = await daemonInfo().catch(() => null)

      row.status = info && info.version !== row.from ? 'done' : 'failed'
      row.message = info ? `Runs ${info.version}` : 'Not connected'
    }
  }

  const [ok, message] = describeResult(state)

  useUpdateRun.setState({ run: { ...state, phase: 'done', result: { message, ok } } })

  // Every client waits on this run until it ends.
  for (let tries = 0; tries < 24; tries += 1) {
    try {
      await rpcCall('hexbot.update.run', { action: 'end', run_id: state.runId })

      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5_000))
    }
  }
}

/** Resolves once connected, or after `timeoutMs`. */
function connected(timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    if (useConnection.getState().status === 'connected') {
      resolve()

      return
    }

    const timer = setTimeout(done, timeoutMs)

    const off = useConnection.subscribe(state => {
      if (state.status === 'connected') {
        done()
      }
    })

    function done() {
      clearTimeout(timer)
      off()
      resolve()
    }
  })
}

/**
 * A browser tab the daemon served reloads onto the daemon's new bundle when
 * it comes back on another version, unless it drives a run, which reloads
 * once the run is over.
 */
export function watchDaemonVersion(): () => void {
  let version = useConnection.getState().daemon?.version ?? null

  servedVersion ??= version

  return useConnection.subscribe(state => {
    const next = state.daemon?.version ?? null

    if (!next || next === version) {
      return
    }

    const was = version

    version = next
    servedVersion ??= next
    const run = useUpdateRun.getState().run

    if (was && !getBridge() && !import.meta.env.DEV && (!run || run.result)) {
      window.location.reload()
    }
  })
}

export type { Track }
