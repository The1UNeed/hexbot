/**
 * Update everything: the daemon and every Hexbot app connected to it, in one
 * run (docs/channels.md, "Updating everything at once"). T3 Code's
 * updateEverything.logic.ts, turned around: there one client updates many
 * servers, here one daemon has many apps. The client you click in plans and
 * drives the run; the daemon passes requests on to the other apps. Pure, so
 * the phone runs the same planner (apps/mobile).
 */
import type { DaemonUpdateOutcome } from './types'
import { compareVersions, parseVersion } from './version-skew'

export type Track = 'stable' | 'nightly'

/** One app as it reports itself to the daemon (`hexbot.apps.list`). */
export interface ReportedApp {
  device: string
  app_id: string
  label: string
  version: string
  edition: 'full' | 'client'
  platform: string
  track: Track
  hosts_daemon: boolean
  current: boolean
  updater: {
    status: null | string
    available: null | string
    downloaded: null | string
    percent: null | number
    message: null | string
  }
  request: null | {
    id: string
    state: 'failed' | 'installing' | 'not_applied' | 'postponed' | 'preparing' | 'ready'
    downloaded_version: null | string
    error: null | string
  }
}

export interface AppsList {
  apps: ReportedApp[]
  older: { device: string; label: string }[]
  run: null | { run_id: string; device: string; expires_at: number }
}

/** `hexbot.update.check`. */
export interface DaemonCheck {
  track: Track
  current: string
  latest: string
  newer: boolean
}

/** This app, when the client is the desktop app. */
export interface ThisApp {
  appId: string
  version: string
  track: Track
  /** Its daemon manager runs the daemon this client is connected to. */
  hostsDaemon: boolean
  /** The updater state, `status` and versions only. */
  updater: {
    status: string
    availableVersion: null | string
    downloadedVersion: null | string
  } | null
  platform: string
}

export interface Fleet {
  daemon: { version: string; capability: 'desktop' | 'service' | null }
  check: DaemonCheck | null
  apps: AppsList
  thisApp: null | ThisApp
  /** The run this client drives, if any, so its own claim doesn't block it. */
  runId?: null | string
}

export type RowKind = 'app' | 'daemon' | 'this-app'

export interface PlanRow {
  key: string
  kind: RowKind
  label: string
  from: string
  /** The version it moves to, "newest" when the app's own feed decides. */
  to: null | string
  /** Why it isn't part of this run. */
  skip: null | string
  /** Passed in prepare when the app follows another track. */
  track: null | Track
  device?: string
  appId?: string
  /** The app whose restart restarts the daemon. */
  hostsDaemon?: boolean
}

export type DaemonRoute =
  /** A service runs it: stage, then restart on trial. */
  | 'service'
  /** The app that runs it updates, and the daemon with it. */
  | 'host-app'
  | 'this-app'
  /** Run by an app that isn't connected: ask it last. */
  | 'request-last'
  | 'none'

export interface Plan {
  rows: PlanRow[]
  daemon: DaemonRoute
  /** Another client's run holds the daemon. */
  blocked: null | string
  /** What the run updates, for the button and the dialog. */
  summary: string
  actionable: boolean
}

export const trackOf = (version: string): Track =>
  parseVersion(version)?.prerelease[0] === 'nightly' ? 'nightly' : 'stable'
const trackName = (track: Track) => (track === 'nightly' ? 'Nightly' : 'Stable')

function behind(version: string, latest: null | string): boolean {
  if (!latest || trackOf(version) !== trackOf(latest)) {
    return false
  }

  const a = parseVersion(version)
  const b = parseVersion(latest)

  return !!a && !!b && compareVersions(a, b) < 0
}

/** What an app's own updater offers, if anything. */
function offered(updater: ReportedApp['updater'] | null): null | string {
  if (!updater) {
    return null
  }

  if (
    updater.status === 'downloaded' ||
    updater.status === 'downloading' ||
    updater.status === 'available'
  ) {
    return updater.downloaded ?? updater.available ?? 'newest'
  }

  return null
}

const UP_TO_DATE = 'Up to date'
const MOVES_WITH_DAEMON = 'Moves with the daemon'
const ON_THAT_COMPUTER = 'Update on that computer'

/**
 * The run's rows. `track` is the fleet's track, the daemon's. An app on
 * another track moves onto it only in a run where the daemon itself moves,
 * so a run started for another reason never leaves an app on an older build
 * than its daemon.
 */
export function collectTargets(
  fleet: Fleet,
  track: Track = fleet.check?.track ?? trackOf(fleet.daemon.version)
): Plan {
  const { check, apps, thisApp } = fleet
  const rows: PlanRow[] = []
  const latest = check?.latest ?? null
  const remote = apps.apps.filter(app => !app.current)
  const hostApp = remote.find(app => app.hosts_daemon) ?? null

  // The daemon.
  let route: DaemonRoute = 'none'
  let daemonSkip: null | string = null

  const daemonRow: PlanRow = {
    key: 'daemon',
    kind: 'daemon',
    label: 'Daemon',
    from: fleet.daemon.version,
    to: null,
    skip: null,
    track: null
  }

  if (fleet.daemon.capability === 'service') {
    route = 'service'
  } else if (fleet.daemon.capability === 'desktop') {
    route = thisApp?.hostsDaemon ? 'this-app' : hostApp ? 'host-app' : 'request-last'
  }

  if (route === 'none') {
    daemonSkip = ON_THAT_COMPUTER
  } else if (!check) {
    daemonSkip = "Couldn't check for updates"
  } else if (!check.newer) {
    daemonSkip =
      trackOf(fleet.daemon.version) !== track
        ? `Moves to ${trackName(track)} with the next ${trackName(track)} release`
        : UP_TO_DATE
  }

  if (route === 'host-app' && hostApp) {
    daemonRow.label = `Daemon, with ${hostApp.label}`
  } else if (route === 'this-app') {
    daemonRow.label = 'Daemon, with this app'
  }

  daemonRow.to = daemonSkip ? null : (latest ?? null)
  daemonRow.skip = daemonSkip
  const daemonMoves = daemonSkip === null
  rows.push(daemonRow)

  // Apps follow the fleet's track only when the daemon moves with them.
  const appRow = (input: {
    key: string
    kind: RowKind
    label: string
    version: string
    appTrack: Track
    offer: null | string
    disabled: boolean
    mac: boolean
    remoteApp: boolean
    hostsDaemon: boolean
    device?: string
    appId?: string
  }): PlanRow => {
    const row: PlanRow = {
      key: input.key,
      kind: input.kind,
      label: input.label,
      from: input.version,
      to: null,
      skip: null,
      track: null,
      device: input.device,
      appId: input.appId,
      hostsDaemon: input.hostsDaemon
    }

    // The app that runs the daemon carries it: it moves when the daemon does.
    if (input.hostsDaemon && route !== 'service') {
      if (daemonSkip) {
        row.skip = daemonSkip
      } else if (input.disabled) {
        row.skip = 'Updates are off on this build'
      } else {
        row.to = latest ?? 'newest'

        if (input.appTrack !== track) {
          row.track = track
        }
      }

      return row
    }

    if (input.disabled) {
      row.skip = 'Updates are off on this build'
    } else if (input.appTrack !== track) {
      if (!daemonMoves) {
        row.skip = MOVES_WITH_DAEMON
      }
      // Squirrel.Mac can't relaunch a bundle the switch renamed (T3 Code's rule).
      else if (input.mac && input.remoteApp) {
        row.skip = `Switch tracks on that Mac`
      } else {
        row.to = latest ?? 'newest'
        row.track = track
      }
    } else if (input.offer || behind(input.version, latest)) {
      row.to = input.offer ?? latest
    } else {
      row.skip = UP_TO_DATE
    }

    return row
  }

  if (thisApp) {
    rows.push(
      appRow({
        key: 'this-app',
        kind: 'this-app',
        label: 'This app',
        version: thisApp.version,
        appTrack: thisApp.track,
        offer: thisApp.updater
          ? offered({
              status: thisApp.updater.status,
              available: thisApp.updater.availableVersion,
              downloaded: thisApp.updater.downloadedVersion,
              percent: null,
              message: null
            })
          : null,
        disabled: !thisApp.updater || thisApp.updater.status === 'disabled',
        mac: thisApp.platform === 'darwin',
        remoteApp: false,
        hostsDaemon: thisApp.hostsDaemon
      })
    )
  }

  for (const app of remote) {
    rows.push(
      appRow({
        key: `${app.device}/${app.app_id}`,
        kind: 'app',
        label: app.label,
        version: app.version,
        appTrack: app.track,
        offer: offered(app.updater),
        disabled: app.updater.status === 'disabled',
        mac: app.platform === 'darwin',
        remoteApp: true,
        hostsDaemon: app.hosts_daemon,
        device: app.device,
        appId: app.app_id
      })
    )
  }

  for (const older of apps.older) {
    rows.push({
      key: `older/${older.device}`,
      kind: 'app',
      label: older.label,
      from: '',
      to: null,
      skip: ON_THAT_COMPUTER,
      track: null,
      device: older.device
    })
  }

  const blocked =
    apps.run && apps.run.run_id !== fleet.runId ? 'Another update is running on this daemon.' : null

  const moving = rows.filter(row => !row.skip)

  return {
    rows,
    daemon: route,
    blocked,
    summary: describeUpdateEverything(moving),
    actionable: !blocked && moving.length > 0
  }
}

/** "Update the daemon, this app and Laptop", or what is current. */
export function describeUpdateEverything(moving: PlanRow[]): string {
  if (!moving.length) {
    return 'Everything is up to date'
  }

  const names = moving.map(row =>
    row.kind === 'daemon' ? 'the daemon' : row.kind === 'this-app' ? 'this app' : row.label
  )

  const list =
    names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

  return `Update ${list}`
}

// The run (T3 Code's runUpdateEverything). Steps are injected so tests can
// drive it and the web app and the phone each supply their own.

export type RowStatus =
  'done' | 'failed' | 'later' | 'preparing' | 'ready' | 'skipped' | 'updating' | 'waiting'

export interface RunRow extends PlanRow {
  status: RowStatus
  message: null | string
  requestId: null | string
}

export interface RunState {
  runId: string
  rows: RunRow[]
  /** Where the run is, for the capsule. */
  phase:
    | 'committing'
    | 'counting-down'
    | 'done'
    | 'preparing'
    | 'restarting-daemon'
    | 'restarting-this-app'
  /** Set once the run ends. */
  result: null | { ok: boolean; message: string }
}

export interface PrepareResult {
  ok: boolean
  version?: null | string
  error?: null | string
}

export interface RunSteps {
  claim(runId: string): Promise<void>
  release(runId: string): Promise<void>
  /** Download and check the daemon's build without switching (`stage_only`). */
  stageDaemon(updateId: string, version: string): Promise<PrepareResult>
  /** Restart into the staged build and read its outcome by id once it is back. */
  restartDaemon(updateId: string, version: string): Promise<DaemonUpdateOutcome>
  /** A daemon run by an app that isn't connected: the old request, last. */
  requestDaemon(version: string): Promise<void>
  prepareApp(row: RunRow, requestId: string): Promise<PrepareResult>
  /** After the daemon came back: the prepared app is connected and still ready. */
  waitReady(row: RunRow, requestId: string): Promise<boolean>
  /** "Restart in 10s · Later" on that app; resolves with what it did. */
  commitApp(row: RunRow, requestId: string): Promise<'failed' | 'installing' | 'postponed'>
  cancelApp(row: RunRow, requestId: string): Promise<void>
  /** "Restart in 5s · Later" here; false for Later. */
  countdown(): Promise<boolean>
  /** Saved before this app relaunches; the relaunched app finishes the run. */
  save(state: RunState): void
  commitThisApp(requestId: string): Promise<void>
  cancelThisApp(requestId: string): Promise<void>
  id(): string
}

const clone = (state: RunState): RunState => ({
  ...state,
  rows: state.rows.map(row => ({ ...row }))
})

/**
 * Prepare everything in parallel, restart the daemon on trial, then install
 * the other apps (the one that runs the daemon last) and this app last of
 * all. A daemon that rolls back cancels every prepared app.
 */
export async function runUpdateEverything(
  plan: Plan,
  steps: RunSteps,
  progress: (state: RunState) => void
): Promise<RunState> {
  const runId = steps.id()

  const state: RunState = {
    runId,
    phase: 'preparing',
    result: null,
    rows: plan.rows.map(row => ({
      ...row,
      status: row.skip ? 'skipped' : 'waiting',
      message: row.skip,
      requestId: null
    }))
  }

  const emit = () => progress(clone(state))

  const set = (row: RunRow, status: RowStatus, message: null | string = null) => {
    row.status = status
    row.message = message
    emit()
  }

  const finish = async (ok: boolean, message: string) => {
    state.phase = 'done'
    state.result = { ok, message }
    emit()
    await steps.release(runId).catch(() => undefined)

    return clone(state)
  }

  const daemon = state.rows.find(row => row.kind === 'daemon' && row.status === 'waiting')
  const thisApp = state.rows.find(row => row.kind === 'this-app' && row.status === 'waiting')
  const apps = state.rows.filter(row => row.kind === 'app' && row.status === 'waiting')

  try {
    await steps.claim(runId)
  } catch (error) {
    return finish(false, error instanceof Error ? error.message : String(error))
  }

  emit()

  // 1. Prepare in parallel. A failure skips only that row.
  const updateId = steps.id()

  const prepare = async (row: RunRow, run: () => Promise<PrepareResult>) => {
    set(row, 'preparing')

    try {
      const result = await run()

      if (result.ok) {
        set(row, 'ready')
      } else {
        set(row, 'failed', result.error ?? 'Could not prepare the update.')
      }
    } catch (error) {
      set(row, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  const preparing: Promise<void>[] = []

  if (daemon && plan.daemon === 'service' && daemon.to) {
    preparing.push(prepare(daemon, () => steps.stageDaemon(updateId, daemon.to!)))
  }

  for (const row of apps) {
    row.requestId = steps.id()
    preparing.push(prepare(row, () => steps.prepareApp(row, row.requestId!)))
  }

  if (thisApp) {
    thisApp.requestId = steps.id()
    preparing.push(prepare(thisApp, () => steps.prepareApp(thisApp, thisApp.requestId!)))
  }

  await Promise.all(preparing)
  const ready = (row: RunRow | undefined): row is RunRow => !!row && row.status === 'ready'

  // 2. A service daemon restarts on trial; read its outcome by id.
  if (ready(daemon) && plan.daemon === 'service') {
    state.phase = 'restarting-daemon'
    set(daemon, 'updating')
    let outcome: DaemonUpdateOutcome | null = null

    try {
      outcome = await steps.restartDaemon(updateId, daemon.to!)
    } catch (error) {
      set(daemon, 'failed', error instanceof Error ? error.message : String(error))
    }

    if (outcome && outcome.status !== 'committed') {
      const message =
        outcome.status === 'rolled-back'
          ? `Rolled back to ${outcome.from}${outcome.reason ? `: it ${outcome.reason}` : ''}`
          : (outcome.reason ?? 'The update failed')

      set(daemon, 'failed', message)
    } else if (outcome) {
      set(daemon, 'done', `Updated to ${outcome.to}`)
    }

    if (daemon.status === 'failed') {
      // Never leave apps newer than a daemon that went back.
      for (const row of [...apps, ...(thisApp ? [thisApp] : [])].filter(ready)) {
        await (
          row.kind === 'this-app'
            ? steps.cancelThisApp(row.requestId!)
            : steps.cancelApp(row, row.requestId!)
        ).catch(() => undefined)
        set(row, 'skipped', 'Not updated: the daemon went back')
      }

      return finish(false, `Daemon: ${daemon.message}`)
    }

    // 3. Apps reconnect to the new daemon and say they are still ready.
    for (const row of apps.filter(ready)) {
      if (!(await steps.waitReady(row, row.requestId!).catch(() => false))) {
        set(row, 'failed', 'Not connected after the daemon restarted')
      }
    }
  }

  // 4. Other apps, the one that runs the daemon last.
  state.phase = 'committing'
  emit()
  const order = apps.filter(ready).sort((a, b) => Number(!!a.hostsDaemon) - Number(!!b.hostsDaemon))

  for (const row of order) {
    set(row, 'updating')
    const result = await steps.commitApp(row, row.requestId!).catch(() => 'failed' as const)

    if (result === 'installing') {
      set(row, 'done', 'Restarting')
    } else if (result === 'postponed') {
      set(row, 'later', `Later on ${row.label}`)
    } else {
      set(row, 'failed', `${row.label} failed`)
    }
  }

  if (daemon && plan.daemon === 'request-last' && daemon.status === 'waiting' && daemon.to) {
    set(daemon, 'updating')
    await steps
      .requestDaemon(daemon.to)
      .then(() => set(daemon, 'done', 'Updating with the app that runs it'))
      .catch(error => set(daemon, 'failed', error instanceof Error ? error.message : String(error)))
  }

  // 5. This app, last: a countdown, then save the run and install.
  if (ready(thisApp)) {
    state.phase = 'counting-down'
    emit()

    if (await steps.countdown()) {
      state.phase = 'restarting-this-app'
      set(thisApp, 'updating')

      if (
        daemon &&
        (plan.daemon === 'this-app' || plan.daemon === 'host-app') &&
        daemon.status === 'waiting'
      ) {
        set(daemon, 'updating')
      }

      steps.save(clone(state))
      await steps.commitThisApp(thisApp.requestId!)
      // Resolves only if the install failed; on success the app relaunches.
      set(thisApp, 'failed', 'This app could not restart into the update')
    } else {
      await steps.cancelThisApp(thisApp.requestId!).catch(() => undefined)
      set(thisApp, 'later', 'Later')
    }
  }

  // The app that runs the daemon carried it.
  if (daemon && plan.daemon === 'host-app' && daemon.status === 'waiting') {
    const host = apps.find(row => row.hostsDaemon)
    set(
      daemon,
      host?.status === 'done' ? 'done' : 'skipped',
      host?.status === 'done' ? 'Updating with its app' : (host?.message ?? null)
    )
  }

  return finish(...describeResult(state))
}

/** One line for the end of a run. */
export function describeResult(state: RunState): [boolean, string] {
  const failed = state.rows.filter(row => row.status === 'failed')
  const later = state.rows.filter(row => row.status === 'later')
  const done = state.rows.filter(row => row.status === 'done')

  if (failed.length) {
    return [false, `${failed.map(row => row.label).join(', ')} failed`]
  }

  if (!done.length && later.length) {
    return [true, 'Nothing updated; you chose Later']
  }

  if (later.length) {
    return [true, `Updated, except ${later.map(row => row.label).join(', ')} (Later)`]
  }

  return [true, done.length ? 'Everything is updated' : 'Everything is up to date']
}

/** The capsule's label while a run goes (T3 Code's describeUpdateCapsule). */
export function describeCapsule(state: RunState | null, countdown: null | number): null | string {
  if (!state || state.phase === 'done') {
    return null
  }

  if (state.phase === 'counting-down' && countdown !== null) {
    return `Restart in ${countdown}s · Later`
  }

  if (state.phase === 'restarting-this-app') {
    return 'Restarting…'
  }

  if (state.phase === 'restarting-daemon') {
    return 'Restarting the daemon…'
  }

  const moving = state.rows.filter(row => row.status !== 'skipped')
  const done = moving.filter(row => row.status === 'done' || row.status === 'later').length

  if (state.phase === 'preparing') {
    return 'Preparing updates…'
  }

  return `${done} of ${moving.length} updated`
}
