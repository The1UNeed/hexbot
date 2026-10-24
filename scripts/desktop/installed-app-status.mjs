// Serialized into the disposable installed app's main process by Playwright.
// The opt-in main hook gives this observer the existing manager, never controls it.
import { randomUUID } from 'node:crypto'

export function installedStatusAction({ app }, { action, id, ready }) {
  const key = Symbol.for('hexbot.installed-smoke.status-observer')
  if (action === 'begin') {
    if (globalThis[key]) throw new Error('An installed-app status observer is already active')
    let manager
    app.emit('hexbot:installed-smoke:manager', value => { manager = value })
    if (!manager) throw new Error('Installed-app manager observation is not enabled')
    let resolve
    const failure = new Promise(done => { resolve = done })
    const observation = { id, manager, failure, resolve, error: null }
    const changed = status => {
      if (observation.error) return
      if (status.state === 'crashed' || /^Daemon exited \(.+\); restarting$/.test(status.lastError ?? '')) {
        observation.error = `Owned daemon crashed before readiness: ${status.lastError ?? status.state}`.slice(0, 1024)
        resolve(observation.error)
      }
    }
    observation.changed = changed
    globalThis[key] = observation
    manager.on('status', changed)
    // Subscription and initial sample are synchronous in the same main turn.
    changed(manager.status())
    return
  }
  const observation = globalThis[key]
  if (!observation || observation.id !== id) return null
  if (action === 'wait') return observation.failure
  if (action !== 'finish') throw new Error('Unknown installed-app status observation action')
  try {
    const status = observation.manager.status()
    observation.changed(status)
    if (ready && !observation.error && (status.state !== 'running' || status.pid !== ready.pid || status.port !== ready.port))
      observation.error = 'Manager changed before the installed-start completion fence'
    return observation.error
  } finally {
    // The last sample, latched error read and unsubscribe cannot interleave
    // with an exit/retry event. A late RPC reply cannot erase the main latch.
    observation.manager.off('status', observation.changed)
    delete globalThis[key]
    observation.resolve(observation.error)
  }
}

export async function observeInstalledStatus(evaluate) {
  const id = randomUUID()
  let finishing
  const finish = ready => finishing ??= Promise.resolve().then(() => evaluate(installedStatusAction, { action: 'finish', id, ready }))
  try {
    await evaluate(installedStatusAction, { action: 'begin', id })
    const failure = Promise.resolve().then(() => evaluate(installedStatusAction, { action: 'wait', id }))
    void failure.catch(() => undefined)
    return { failure, finish }
  } catch (error) {
    await finish().catch(() => undefined)
    throw error
  }
}
