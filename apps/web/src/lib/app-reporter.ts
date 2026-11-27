/**
 * This desktop app as one of the apps connected to the daemon, for Update
 * everything (docs/channels.md, "Updating everything at once"). It reports
 * its version and its updater on its own connection, and carries the
 * daemon's requests to the main process, which prepares and installs
 * (apps/desktop/src/main/updater.ts). Like computer-endpoint.ts, this module
 * only relays; the daemon can't make the app do more than update itself.
 */

import { useConnection } from '../stores/connection'

import { appsReport } from './api'
import { getBridge as bridge, type RemoteRequest } from './bridge'

/** The desktop app with Update everything; a browser or an older app can't report. */
export function canReport(): boolean {
  const app = bridge()

  return Boolean(app?.appId && app.updater.prepare)
}

/** What the daemon keeps of a request: a countdown is still a prepared update. */
function requestState(remote: RemoteRequest) {
  return {
    downloaded_version: remote.version,
    error: remote.error,
    id: remote.requestId,
    state: remote.state === 'countdown' ? 'ready' : remote.state
  }
}

let reporting: Promise<void> = Promise.resolve()
let lastSent = ''

/** Tell the daemon about this app now. One report at a time, and only a change. */
export function reportThisApp(force = false): Promise<void> {
  if (force) {
    lastSent = ''
  }

  reporting = reporting.catch(() => {}).then(reportNow)

  return reporting
}

async function reportNow(): Promise<void> {
  const app = bridge()
  const connection = useConnection.getState()

  if (!app?.appId || !app.updater.remote || !canReport() || connection.status !== 'connected') {
    return
  }

  const [updater, remote, status] = await Promise.all([
    app.updater.state(),
    app.updater.remote(),
    app.daemon.status().catch(() => null)
  ])

  const installId = connection.daemon?.install_id ?? null

  const report = {
    app_id: app.appId,
    edition: app.edition,
    // Its daemon manager runs the very daemon this connection reaches.
    hosts_daemon: status?.state === 'running' && !!installId && status.installId === installId,
    platform: app.platform,
    request: remote ? requestState(remote) : null,
    track: updater.channel,
    updater: {
      available: updater.availableVersion,
      downloaded: updater.downloadedVersion,
      message: updater.message,
      // Tens only: a report per percent would flood every client.
      percent: updater.percent === null ? null : Math.floor(updater.percent / 10) * 10,
      status: updater.status
    },
    version: app.version
  }

  const body = JSON.stringify(report)

  if (body === lastSent) {
    return
  }

  try {
    await appsReport(report)
    lastSent = body
  } catch {
    // An older daemon has no Update everything; this app updates on its own there.
  }
}

/** A new connection: report again from scratch. */
export function connectionOpened(): void {
  void reportThisApp(true)
}

let watching = false

/** Report again whenever the updater, a request, or the daemon this app runs changes. */
export function watchThisApp(): void {
  const app = bridge()

  if (watching || !app || !canReport()) {
    return
  }

  watching = true
  app.updater.onStatus(() => void reportThisApp())
  app.updater.onRemote?.(() => void reportThisApp())
  app.daemon.onStatus?.(() => void reportThisApp())
}

/** One request from the run's driver, passed on by the daemon on this connection. */
export async function handleAppUpdateRequest(payload: Record<string, unknown>): Promise<void> {
  const updater = bridge()?.updater
  const id = typeof payload.request_id === 'string' ? payload.request_id : null
  const track = payload.track === 'stable' || payload.track === 'nightly' ? payload.track : null

  if (!updater?.prepare || !id) {
    return
  }

  try {
    if (payload.action === 'prepare') {
      await updater.prepare(id, track, useConnection.getState().daemon?.install_id ?? null)
    } else if (payload.action === 'commit') {
      // "Restart in 10s · Later" here; the main process keeps the deadline.
      await updater.commit?.(id, true)
    } else if (payload.action === 'cancel') {
      await updater.cancel?.(id, false)
    }
  } finally {
    await reportThisApp()
  }
}
