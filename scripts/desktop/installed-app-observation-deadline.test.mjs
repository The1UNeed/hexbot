import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, toNamespacedPath } from 'node:path'
import test from 'node:test'
import { startInstalledOwned } from './installed-app-lifecycle.mjs'
import { installedStatusAction, observeInstalledStatus } from './installed-app-status.mjs'

const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve() }
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'hexbot observation deadline '))
  t.after(() => rm(home, { recursive: true, force: true }))
  for (const directory of ['runtime', 'logs']) await mkdir(join(home, directory))
  const selected = join(home, 'hexbot.exe')
  await writeFile(selected, '')
  const ready = { pid: 42, port: 9119, executable: toNamespacedPath(await realpath(selected)) }
  const manager = Object.assign(new EventEmitter(), { status: () => ({ state: 'running', pid: ready.pid, port: ready.port }) })
  const app = new EventEmitter()
  app.on('hexbot:installed-smoke:manager', read => read(manager))
  let starts = 0, probes = 0
  const startError = new Error('start IPC failed')
  const evaluate = (fn, value) => Promise.resolve(fn({ app }, value))
  const options = {
    home, selected, previousPid: 41, timeout: 100,
    start: () => { starts++; throw startError },
    status: async () => manager.status(),
    probe: async () => { probes++; return ready },
    watchDirectory: () => Object.assign(new EventEmitter(), { close() {} }),
    observeStatus: () => observeInstalledStatus(evaluate)
  }
  return { options, ready, app, manager, evaluate, startError, starts: () => starts, probes: () => probes }
}
function track(options) {
  let settled = false, outerCleanup = false
  const operation = startInstalledOwned(options).finally(() => { outerCleanup = true })
  // Observe immediately, including a failure that occurs during fake-clock advancement.
  const result = operation.then(value => { settled = true; return { value } }, error => { settled = true; return { error } })
  return { result, settled: () => settled, outerCleanup: () => outerCleanup }
}
function assertUnconfirmed(error, primary) {
  assert(error instanceof AggregateError)
  assert.equal(error.cause, error.errors[0])
  if (primary instanceof Error) assert.equal(error.cause, primary)
  else assert.match(error.cause.message, primary)
  assert.match(error.errors[1].message, /observation disposal unconfirmed within 2000 ms/)
}

for (const boundary of ['begin', 'finish']) test(`blocked ${boundary} returns to outer cleanup, then a late reply disposes its listener`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t), gate = Promise.withResolvers()
  f.options.observeStatus = () => observeInstalledStatus(async (fn, value) => {
    if (boundary === 'finish' && value.action === 'finish') await gate.promise
    const result = await f.evaluate(fn, value)
    if (boundary === 'begin' && value.action === 'begin') await gate.promise
    return result
  })
  const operation = track(f.options)
  try {
    await flush()
    assert.equal(f.manager.listenerCount('status'), 1)
    if (boundary === 'begin') { t.mock.timers.tick(100); await flush() }
    t.mock.timers.tick(1999); await flush()
    assert.equal(operation.settled(), false)
    t.mock.timers.tick(1); await flush()
    assert.equal(operation.settled(), true, 'remote IPC must not prevent outer app cleanup')
    assert.equal(operation.outerCleanup(), true)
    assertUnconfirmed((await operation.result).error, boundary === 'begin' ? /within 100 ms/ : f.startError)
    assert.equal(f.probes(), 0)
    assert.equal(f.starts(), boundary === 'begin' ? 0 : 1)
    // A timed-out operation cannot reuse a listener whose disposal is unconfirmed.
    await assert.rejects(observeInstalledStatus(f.evaluate), /already active/)
    gate.resolve(); await flush()
    assert.equal(f.manager.listenerCount('status'), 0)
    const next = await observeInstalledStatus(f.evaluate)
    await next.finish()
    assert.equal(f.manager.listenerCount('status'), 0)
    assert.equal(f.probes(), 0, 'late ACK cannot create a probe')
  } finally { gate.resolve(); await flush() }
})

test('ACK and finish share one cleanup envelope without resetting its remaining time', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t), ack = Promise.withResolvers(), finish = Promise.withResolvers()
  f.options.observeStatus = () => observeInstalledStatus(async (fn, value) => {
    if (value.action === 'finish') await finish.promise
    const result = await f.evaluate(fn, value)
    if (value.action === 'begin') await ack.promise
    return result
  })
  const operation = track(f.options)
  try {
    await flush(); t.mock.timers.tick(100); await flush()
    t.mock.timers.tick(1500); await flush()
    ack.resolve(); await flush()
    t.mock.timers.tick(499); await flush()
    assert.equal(operation.settled(), false)
    t.mock.timers.tick(1); await flush()
    assert.equal(operation.settled(), true)
    assertUnconfirmed((await operation.result).error, /within 100 ms/)
    assert.equal(f.starts(), 0)
  } finally { ack.resolve(); finish.resolve(); await flush() }
  assert.equal(f.manager.listenerCount('status'), 0)
})

test('blocked success fence cannot succeed or hold outer cleanup beyond the shared bounds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t), finish = Promise.withResolvers(), entered = Promise.withResolvers()
  f.options.start = () => undefined
  f.options.observeStatus = () => observeInstalledStatus(async (fn, value) => {
    if (value.action === 'finish') { entered.resolve(); await finish.promise }
    return f.evaluate(fn, value)
  })
  const operation = track(f.options)
  try {
    await entered.promise
    assert.equal(f.probes(), 1)
    t.mock.timers.tick(100); await flush()
    t.mock.timers.tick(2000); await flush()
    assert.equal(operation.settled(), true)
    assertUnconfirmed((await operation.result).error, /within 100 ms/)
    assert.equal(operation.outerCleanup(), true)
  } finally { finish.resolve(); await flush() }
  assert.equal(f.manager.listenerCount('status'), 0)
})

test('remote cleanup expiry still waits for the aborted owned probe to close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t), finish = Promise.withResolvers(), entered = Promise.withResolvers(), closed = Promise.withResolvers()
  let signal
  f.options.start = () => undefined
  f.options.probe = async (_home, value) => { signal = value; entered.resolve(); await closed.promise; value.throwIfAborted() }
  f.options.observeStatus = () => observeInstalledStatus(async (fn, value) => {
    if (value.action === 'finish') await finish.promise
    return f.evaluate(fn, value)
  })
  const operation = track(f.options)
  try {
    await entered.promise
    t.mock.timers.tick(100); await flush()
    assert.equal(signal.aborted, true)
    t.mock.timers.tick(2000); await flush()
    assert.equal(operation.settled(), false, 'owned OS process cannot be raced away')
    closed.resolve(); await flush()
    assert.equal(operation.settled(), true)
    assertUnconfirmed((await operation.result).error, /within 100 ms/)
  } finally { closed.resolve(); finish.resolve(); await flush() }
  assert.equal(f.manager.listenerCount('status'), 0)
})

for (const boundary of ['begin', 'finish']) test(`never-released ${boundary} permits outer cleanup; late RPC failure stays observed`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t), gate = Promise.withResolvers()
  let id
  f.options.observeStatus = () => observeInstalledStatus(async (fn, value) => {
    id = value.id
    const result = await f.evaluate(fn, value)
    if (value.action === boundary) await gate.promise
    return result
  })
  const operation = track(f.options)
  await flush()
  if (boundary === 'begin') { t.mock.timers.tick(100); await flush() }
  t.mock.timers.tick(2000); await flush()
  assert.equal(operation.settled(), true, 'no bridge reply is required to reach outer cleanup')
  assert.equal(operation.outerCleanup(), true)
  assertUnconfirmed((await operation.result).error, boundary === 'begin' ? /within 100 ms/ : f.startError)
  // Simulate outer app teardown of the still-live main context. No ACK was needed.
  installedStatusAction({ app: f.app }, { action: 'finish', id })
  assert.equal(f.manager.listenerCount('status'), 0)
  gate.reject(new Error('late remote transport rejection'))
  await flush()
  assert.equal(f.probes(), 0)
})

test('a known remote disposal error preserves the original startup error separately', async t => {
  const f = await fixture(t), cleanupError = new Error('finish transport failed')
  f.options.observeStatus = () => observeInstalledStatus(async (fn, value) => {
    const result = await f.evaluate(fn, value)
    if (value.action === 'finish') throw cleanupError
    return result
  })
  const { error } = await track(f.options).result
  assert(error instanceof AggregateError)
  assert.equal(error.cause, f.startError)
  assert.deepEqual(error.errors, [f.startError, cleanupError])
  assert.equal(f.manager.listenerCount('status'), 0)
})
