import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, toNamespacedPath } from 'node:path'
import test from 'node:test'
import { quitInstalledApp, startInstalledOwned, verifyInstalledDaemon } from './installed-app-lifecycle.mjs'
import { waitForRuntimeJson } from './runtime-file.mjs'

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'hexbot installed lifecycle '))
  t.after(() => rm(home, { recursive: true, force: true }))
  for (const name of ['runtime', 'logs']) await mkdir(join(home, name))
  const selected = join(home, 'hexbot.exe')
  await writeFile(selected, '')
  const ready = { pid: 42, port: 9119, executable: toNamespacedPath(await realpath(selected)) }
  const watchers = [], calls = []
  let status = { state: 'starting', port: ready.port }
  const options = {
    home, selected, previousPid: 41,
    start: () => { calls.push('start') },
    status: async () => { calls.push('status'); return status },
    probe: async (_home, signal) => { calls.push('probe'); signal?.throwIfAborted(); return ready },
    watchDirectory: (path, notify) => {
      calls.push('watch')
      const watcher = Object.assign(new EventEmitter(), { path, notify, closed: false, close() { this.closed = true } })
      watchers.push(watcher)
      return watcher
    }
  }
  return { home, ready, options, watchers, calls,
    setStatus(value) { status = value }, running() { status = { state: 'running', pid: ready.pid, port: ready.port } },
    notify() { for (const watcher of watchers) if (!watcher.closed) watcher.notify() }
  }
}

test('old record gate accepts a stopped PID; ordinary gate waits through fresh metadata and delayed READY', async t => {
  const f = await fixture(t)
  const record = join(f.home, 'runtime/native-running.json')
  await writeFile(record, JSON.stringify({ pid: 41 }))
  assert.equal((await waitForRuntimeJson(record, value => value.pid)).pid, 41)
  assert.throws(() => assert.equal('starting', 'running'), { code: 'ERR_ASSERTION' })
  const starting = startInstalledOwned(f.options)
  let accepted = false
  starting.then(() => { accepted = true }, () => undefined)
  await flush()
  assert.deepEqual(f.calls, ['start', 'watch', 'watch', 'watch', 'status'])
  await writeFile(record, JSON.stringify({ pid: 42 }))
  f.notify(); await flush()
  assert.equal(accepted, false)
  assert(!f.calls.includes('probe'), 'setup/file/PID publication cannot authorize a probe yet')
  f.running(); f.notify()
  assert.equal((await starting).pid, 42)
  assert.equal(f.calls.filter(x => x === 'start').length, 1)
  assert(f.watchers.every(x => x.closed))
})

test('immediate readiness is checked after every observer is registered', async t => {
  const f = await fixture(t)
  f.running()
  assert.equal((await startInstalledOwned(f.options)).pid, 42)
  assert.deepEqual(f.calls, ['start', 'watch', 'watch', 'watch', 'status', 'probe', 'status'])
})

test('events during a pending check are coalesced without losing delayed READY', async t => {
  const f = await fixture(t), first = Promise.withResolvers()
  let reads = 0
  f.options.status = () => ++reads === 1 ? first.promise : { state: 'running', pid: 42, port: 9119 }
  const starting = startInstalledOwned(f.options)
  await flush()
  f.notify(); f.notify()
  first.resolve({ state: 'starting' })
  assert.equal((await starting).pid, 42)
  assert.equal(reads, 3, 'one coalesced check and one final manager snapshot')
})

test('crashed/stopped/wrong owner/PID/port/image and stale running PID fail without another start', async t => {
  for (const state of ['crashed', 'stopped', 'external']) {
    const f = await fixture(t)
    f.setStatus({ state })
    await assert.rejects(startInstalledOwned(f.options), /stopped or crashed/)
    assert(!f.calls.includes('probe'))
    assert(f.watchers.every(x => x.closed))
  }
  for (const change of [{ pid: 41 }, { pid: 43 }, { port: 9120 }, { executable: '/another/image' }, new Error('wrong authenticated home')]) {
    const f = await fixture(t)
    f.running()
    f.options.probe = async () => { if (change instanceof Error) throw change; return { ...f.ready, ...change } }
    await assert.rejects(startInstalledOwned(f.options))
    assert.equal(f.calls.filter(x => x === 'start').length, 1)
    assert(f.watchers.every(x => x.closed))
  }
})

test('manager changes during authenticated proof fail immediately', async t => {
  const f = await fixture(t)
  f.running()
  f.options.probe = async () => { f.setStatus({ state: 'crashed' }); return f.ready }
  await assert.rejects(startInstalledOwned(f.options), /Manager changed/)
})

test('one remaining budget aborts and drains its probe before settling, observing late failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t), start = Promise.withResolvers(), closed = Promise.withResolvers()
  let probeSignal, aborted = false, settled = false
  f.running()
  f.options.start = () => start.promise
  f.options.timeout = 1000
  f.options.probe = async (_home, signal) => {
    probeSignal = signal
    signal.addEventListener('abort', () => { aborted = true }, { once: true })
    await closed.promise
    throw new Error('late owned probe failure after process close')
  }
  const operation = startInstalledOwned(f.options)
  operation.then(() => { settled = true }, () => { settled = true })
  await flush(); t.mock.timers.tick(900)
  start.resolve(); await flush()
  assert.equal(probeSignal.aborted, false)
  t.mock.timers.tick(100); await flush()
  assert.equal(aborted, true)
  assert.equal(settled, false, 'cleanup must not race a still-owned read-only process')
  assert(f.watchers.every(x => x.closed))
  closed.resolve()
  await assert.rejects(operation, /within 1000 ms/)
})

test('late start/status failures and observer setup/error paths are disposed and observed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t), status = Promise.withResolvers()
  f.options.timeout = 100
  let signal
  f.options.status = () => status.promise
  f.options.probe = async (_home, value) => { signal = value; assert.fail('late status must not start a probe') }
  const operation = startInstalledOwned(f.options)
  await flush(); t.mock.timers.tick(100)
  await assert.rejects(operation, /within 100 ms/)
  status.reject(new Error('late status failure')); await flush()
  assert.equal(signal, undefined)
  assert(f.watchers.every(x => x.closed))
  for (const setup of [false, true]) {
    const g = await fixture(t)
    if (setup) {
      const watch = g.options.watchDirectory
      g.options.watchDirectory = (...args) => { if (g.watchers.length) throw new Error('watch setup'); return watch(...args) }
    }
    const pending = startInstalledOwned(g.options)
    await flush()
    if (!setup) g.watchers[0].emit('error', new Error('watch error'))
    await assert.rejects(pending, /watch/)
    assert(g.watchers.every(x => x.closed))
  }
})

test('a ready-contract service operation returning starting is never rescued by the ordinary waiter', async t => {
  const f = await fixture(t)
  await assert.rejects(verifyInstalledDaemon({ ...f.options, status: { state: 'starting' } }), /readiness contract/)
  assert.deepEqual(f.calls, [])
})

test('Quit retains owned completion before task authentication; no-task and pre-readiness cleanup require a stopped home', async () => {
  for (const taskInstalled of [false, true]) {
    const calls = []
    const ready = await quitInstalledApp({ ownedPid: 42, taskInstalled,
      retain: async pid => { assert.equal(pid, 42); calls.push('retain'); return async () => { calls.push('completed') } },
      quit: async () => { calls.push('quit') },
      verifyTask: async () => { calls.push('authenticated task'); return { pid: 43 } },
      uninstallTask: async () => { calls.push('uninstall task') },
      assertStopped: async pid => { assert.equal(pid, taskInstalled ? 43 : 42); calls.push('stopped home') }
    })
    assert.deepEqual(calls, taskInstalled ? ['retain', 'quit', 'completed', 'authenticated task', 'uninstall task', 'stopped home'] : ['retain', 'quit', 'completed', 'stopped home'])
    assert.equal(ready?.pid, taskInstalled ? 43 : undefined)
  }
  let stopped = false
  await quitInstalledApp({ taskInstalled: false, quit: async () => {}, assertHomeStopped: async () => { stopped = true } })
  assert(stopped)
})

test('retention/quit/completion failures still request Quit and cannot authorize task-uninstall fallback', async () => {
  for (const phase of ['retain', 'quit', 'completed']) {
    const calls = [], failure = new Error(phase)
    await assert.rejects(quitInstalledApp({ ownedPid: 42, taskInstalled: true,
      retain: async () => { calls.push('retain'); if (phase === 'retain') throw failure; return async () => { calls.push('completed'); if (phase === 'completed') throw failure } },
      quit: async () => { calls.push('quit'); if (phase === 'quit') throw failure },
      verifyTask: async () => assert.fail('unverified task must not authorize fallback')
    }), error => error === failure)
    assert(calls.includes('quit'))
    if (phase !== 'retain') assert(calls.includes('completed'))
  }
})

test('watcher failure aborts and drains an active probe; late start cannot install observers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t), closed = Promise.withResolvers()
  f.running()
  let signal, settled = false
  f.options.probe = async (_home, value) => { signal = value; await closed.promise; value.throwIfAborted() }
  const operation = startInstalledOwned(f.options)
  operation.catch(() => { settled = true })
  await flush()
  f.watchers[0].emit('error', new Error('observer failed'))
  await flush()
  assert.equal(signal.aborted, true)
  assert.equal(settled, false)
  closed.resolve()
  await assert.rejects(operation, /observer failed/)
  const g = await fixture(t), start = Promise.withResolvers()
  g.options.start = () => start.promise
  g.options.timeout = 100
  const late = startInstalledOwned(g.options)
  await flush(); t.mock.timers.tick(100)
  await assert.rejects(late, /within 100 ms/)
  start.reject(new Error('late bridge start failure')); await flush()
  assert.equal(g.watchers.length, 0)
})

test('failed task authentication after Quit never uninstalls; retained completion is still checked', async () => {
  const calls = [], failure = new Error('task has another home or image')
  await assert.rejects(quitInstalledApp({ ownedPid: 42, taskInstalled: true,
    retain: async () => { calls.push('retain'); return async () => { calls.push('completed') } },
    quit: async () => { calls.push('quit') },
    verifyTask: async () => { calls.push('verify'); throw failure },
    uninstallTask: async () => assert.fail('unverified task must not be uninstalled')
  }), error => error === failure)
  assert.deepEqual(calls, ['retain', 'quit', 'completed', 'verify'])
})
