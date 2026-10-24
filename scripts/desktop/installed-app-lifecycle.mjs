// Installed Windows app probe only. Production readiness stays in windowsDaemon.
import assert from 'node:assert/strict'
import { realpathSync, watch } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join, toNamespacedPath } from 'node:path'
import { windowsDaemon } from '../../apps/desktop/src/main/backend/windows-readiness.ts'
import { nodePath } from '../../apps/desktop/src/main/backend/node-path.ts'
import { startInstalledRuntime } from './installed-app-startup.mjs'

export async function verifyInstalledDaemon({ home, selected, status, expectedState = 'running', previousPid, expectedPid, signal, probe = windowsDaemon }) {
  signal?.throwIfAborted()
  if (status) assert.equal(status.state, expectedState, 'Daemon operation returned before its readiness contract')
  const ready = await probe(home, signal)
  signal?.throwIfAborted()
  assert(ready, 'No authenticated daemon holds the installed home')
  assert.notEqual(ready.pid, previousPid, 'Readiness retained the stopped daemon PID')
  if (expectedPid !== undefined) assert.equal(ready.pid, expectedPid, 'Daemon instance changed')
  const executable = typeof selected === 'function' ? await selected() : selected
  assert.equal(ready.executable, toNamespacedPath(await realpath(executable)), 'Daemon is not the selected executable')
  if (status) {
    assert.equal(status.port, ready.port, 'Manager and authenticated daemon ports differ')
    if (expectedState === 'running') assert.equal(status.pid, ready.pid, 'Manager and authenticated daemon PIDs differ')
  }
  signal?.throwIfAborted()
  return ready
}

function waitForOwnedReady(options, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const watchers = []
    const probeController = new AbortController()
    const probeSignal = AbortSignal.any([signal, probeController.signal])
    let settled = false, checking = false, changed = false, probing
    const finish = (error, value) => {
      if (settled) return
      settled = true
      for (const watcher of watchers) watcher.close()
      signal.removeEventListener('abort', aborted)
      probeController.abort(error)
      // The optional signal makes windowsDaemon kill AND reap its own probe.
      // Observe every late failure, including a bridge status read after abort.
      void Promise.resolve(probing).catch(() => undefined).then(() => {
        if (error) reject(error)
        else resolve(value)
      })
    }
    const aborted = () => finish(signal.reason)
    const check = async () => {
      changed = true
      if (checking || settled) return
      checking = true
      try {
        do {
          changed = false
          const status = await options.status()
          if (settled) return
          if (status.state === 'starting') continue
          assert.equal(status.state, 'running', 'Owned daemon stopped or crashed before readiness')
          probing = verifyInstalledDaemon({ ...options, status, signal: probeSignal })
          const ready = await probing
          if (settled) return
          const current = await options.status()
          if (settled) return
          assert.deepEqual(current, status, 'Manager changed during authenticated readiness')
          finish(undefined, ready)
        } while (changed && !settled)
      } catch (error) { finish(error) }
      finally { checking = false }
    }
    const notify = () => { void check() }
    try {
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) return aborted()
      // Daemon log writes wake a check after the manager consumes READY. Log
      // contents, runtime progress and metadata presence are never proof.
      for (const directory of [options.home, join(options.home, 'runtime'), join(options.home, 'logs')]) {
        const canonical = nodePath(realpathSync.native(directory))
        const watcher = (options.watchDirectory ?? watch)(canonical, notify)
        watchers.push(watcher)
        watcher.once('error', error => finish(error))
      }
      notify()
    } catch (error) { finish(error) }
  })
}

// Ordinary start alone is asynchronous in a17. Never use this for service
// recovery, handoff, Quit or activation replacement: verify those immediately.
export async function startInstalledOwned({ start, timeout = 30_000, ...options }) {
  let readiness
  try {
    return await startInstalledRuntime('full', start,
      signal => (readiness = waitForOwnedReady(options, signal)), timeout)
  } finally {
    // The shared deadline aborts before rejecting. Drain its owned probe before
    // returning to lifecycle cleanup; a late bridge call cannot start a probe.
    await readiness?.catch(() => undefined)
  }
}

export async function quitInstalledApp({ ownedPid, taskInstalled, retain, quit, verifyTask, uninstallTask, assertStopped, assertHomeStopped }) {
  const errors = []
  let completed
  try { if (ownedPid) completed = await retain(ownedPid) }
  catch (error) { errors.push(error) }
  // Even failure to retain a known process must still request normal app Quit.
  try { await quit() } catch (error) { errors.push(error) }
  try { await completed?.() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'App Quit and owned-process completion failed')
  if (taskInstalled) {
    const task = await verifyTask()
    await uninstallTask()
    await assertStopped(task.pid)
    return task
  }
  if (ownedPid) await assertStopped(ownedPid)
  else await assertHomeStopped()
}
