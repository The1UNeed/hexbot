// Installed Windows app probe only. Production readiness stays in windowsDaemon.
import assert from 'node:assert/strict'
import { realpathSync, watch } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
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

async function verifyStartedTask(options, signal) {
  let record, state
  try {
    record = JSON.parse(await readFile(join(options.home, 'runtime/native-running.json'), 'utf8'))
  } catch (error) { if (error.code === 'ENOENT') return; throw error }
  signal.throwIfAborted()
  assert(Number.isSafeInteger(record.pid) && record.pid > 0, 'Invalid task daemon PID')
  if (record.pid === options.previousPid) return
  const selected = typeof options.selected === 'function' ? await options.selected() : options.selected
  assert.equal(toNamespacedPath(await realpath(record.executable)), toNamespacedPath(await realpath(selected)), 'Task record is not the selected executable')
  try { state = JSON.parse(await readFile(join(options.home, 'serve-state.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  assert(Number.isInteger(state.port) && state.port > 0 && state.port <= 65535, 'Invalid task daemon port')
  // The CLI only schedules the task. Early metadata can precede HTTP serving.
  // Only a refused loopback connection is ordinary startup here; malformed or
  // wrong identities and all strict windowsDaemon failures remain fatal.
  let response
  try {
    signal.throwIfAborted()
    response = await (options.fetch ?? fetch)(`http://127.0.0.1:${state.port}/api/daemon/identity`, { signal, redirect: 'error' })
  } catch (error) {
    signal.throwIfAborted()
    if (error.cause?.code === 'ECONNREFUSED') return
    throw error
  }
  assert.equal(response.status, 200, 'Task identity endpoint refused readiness')
  const identity = await response.json()
  const install = (await readFile(join(options.home, 'install_id'), 'utf8')).trim()
  assert(install, 'Installed home has no identity')
  assert.equal(identity.install_id, install, 'Task daemon belongs to another home')
  assert.equal(identity.pid, record.pid, 'Task HTTP and recorded PIDs differ')
  const ready = await verifyInstalledDaemon({ ...options, status: undefined, expectedPid: record.pid, signal })
  assert.equal(ready.port, state.port, 'Task port changed during authenticated readiness')
  return ready
}

function waitForInstalledReady(options, signal, taskStart) {
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
          if (taskStart) {
            probing = verifyStartedTask(options, probeSignal)
            const ready = await probing
            if (settled) return
            if (ready) finish(undefined, ready)
            continue
          }
          const status = await options.status()
          if (settled) return
          if (status.state === 'starting') {
            assert(!/^Daemon exited \(.+\); restarting$/.test(status.lastError ?? ''), `Owned daemon crashed before readiness: ${status.lastError}`)
            continue
          }
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
      // Owned READY consumption writes the log; task HTTP startup republishes
      // native-running.json. Both are wakeups, never readiness proof alone.
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
async function startInstalledDaemon({ start, timeout = 30_000, ...options }, taskStart) {
  let readiness, observing, observation, primaryFailure
  const failed = new AbortController()
  try {
    return await startInstalledRuntime('full', async signal => {
      if (taskStart) return start()
      observing = options.observeStatus()
      observation = await observing
      signal.throwIfAborted()
      const failure = observation.failure.then(message => {
        if (message) throw new Error(message)
      }).catch(error => {
        failed.abort(error)
        throw error
      })
      void failure.catch(() => undefined)
      const starting = Promise.resolve().then(async () => {
        const initial = await options.status()
        assert(initial.state !== 'crashed', 'Owned daemon stopped or crashed before readiness')
        assert(!/^Daemon exited \(.+\); restarting$/.test(initial.lastError ?? ''), `Owned daemon crashed before readiness: ${initial.lastError}`)
        signal.throwIfAborted()
        failed.signal.throwIfAborted()
        return start()
      })
      // A main-process crash can reject a still-pending start IPC. Its later
      // rejection remains observed; it cannot create a readiness probe.
      return Promise.race([starting, failure])
    }, signal => {
      const readySignal = taskStart ? signal : AbortSignal.any([signal, failed.signal])
      // Keep owned probe completion separate from the remote completion fence.
      readiness = waitForInstalledReady(options, readySignal, taskStart)
      return readiness.then(async ready => {
        if (!taskStart) {
          const error = await observation.finish({ pid: ready.pid, port: ready.port })
          if (error) throw new Error(error)
        }
        return ready
      })
    }, timeout)
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    let cleanupFailure, timer
    // One shared envelope, using the existing diagnostic bound, covers both
    // subscription ACK and disposal. Keep this continuation observed after a
    // timeout: a late ACK must still remove its own listener, never start a probe.
    const disposal = Promise.resolve(observing).then(active => active?.finish()).then(error => {
      if (error && !primaryFailure) throw new Error(error)
    })
    const boundedDisposal = !taskStart && observing
      ? Promise.race([disposal, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Installed manager observation disposal unconfirmed within 2000 ms')), 2000)
      })]).catch(error => { cleanupFailure = error })
      : Promise.resolve()
    try {
      // Unlike a remote evaluation, the owned read-only OS probe MUST be killed
      // and reaped. Its drain remains mandatory even if remote cleanup expires.
      await Promise.all([readiness?.catch(() => undefined), boundedDisposal])
    } finally { clearTimeout(timer) }
    if (cleanupFailure) {
      if (!primaryFailure) throw cleanupFailure
      // A rejected subscription is already the primary failure. Otherwise keep
      // the startup cause and the separate unconfirmed-disposal cause explicit.
      if (cleanupFailure !== primaryFailure)
        throw new AggregateError([primaryFailure, cleanupFailure], `${primaryFailure.message}; observation cleanup failed: ${cleanupFailure.message}`, { cause: primaryFailure })
    }
  }
}

export const startInstalledOwned = options => startInstalledDaemon(options, false)
export const startInstalledTask = options => startInstalledDaemon(options, true)

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
