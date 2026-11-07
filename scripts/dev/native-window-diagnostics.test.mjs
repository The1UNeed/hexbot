import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { instrumentNativeWindow, writeNativeWindowPreload } from './native-window-diagnostics.mjs'

function fixture(write) {
  const app = new EventEmitter()
  app.ready = false
  app.isReady = () => app.ready
  const handlers = new Map()
  const ipcMain = {
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error('Already registered')
      handlers.set(channel, handler)
    },
    removeHandler(channel) {
      handlers.delete(channel)
    }
  }
  const calls = []
  class BrowserWindow extends EventEmitter {
    constructor() {
      super()
      this.id = 1
      this.visible = false
      this.minimized = false
      this.focused = false
    }
    isDestroyed() {
      return false
    }
    isVisible() {
      calls.push('isVisible')
      return this.visible
    }
    isMinimized() {
      calls.push('isMinimized')
      return this.minimized
    }
    isFocused() {
      return this.focused
    }
    show(...args) {
      calls.push({ receiver: this, args })
      this.visible = true
      return this.result
    }
    showInactive() {
      return this.show()
    }
    restore() {
      this.minimized = false
    }
    focus() {
      this.focused = true
    }
    close(event) {
      this.emit('close', event)
    }
    minimize() {
      this.minimized = true
    }
  }
  const electron = { app, BrowserWindow, ipcMain }
  const trace = []
  const api =
    write === false
      ? undefined
      : instrumentNativeWindow(electron, write || (entry => trace.push(entry)))
  return { ...electron, electron, calls, handlers, trace, api }
}

test('pre-main observation attributes initial show, delegates exact calls, and restores only owned listeners/methods', async () => {
  const f = fixture()
  const win = new f.BrowserWindow()
  const originalApplicationListener = event => {
    event.defaultPrevented = true
  }
  f.app.emit('browser-window-created', {}, win)
  win.on('close', originalApplicationListener)
  function initialReadyShow() {
    win.show('unchanged', win)
  }
  win.once('ready-to-show', initialReadyShow)
  assert.equal(
    instrumentNativeWindow(f.electron, () => assert.fail('double install')),
    f.api
  )
  win.emit('ready-to-show')
  assert.deepEqual(
    f.calls.find(value => typeof value === 'object'),
    { receiver: win, args: ['unchanged', win] }
  )
  const enter = f.trace.find(entry => entry.event === 'call-enter')
  assert.match(enter.stack, /initialReadyShow/)
  assert(f.trace.findIndex(entry => entry.name === 'ready-to-show') < f.trace.indexOf(enter))
  assert.equal(f.trace.filter(entry => entry.event === 'installed').length, 1)
  assert.equal(f.trace[0].ready, false)
  assert.equal(
    f.app.listenerCount('activate'),
    0,
    'diagnostics cannot satisfy the product readiness check'
  )
  const result = Promise.resolve('same return identity')
  win.result = result
  assert.equal(win.show(), result)
  win.close({ defaultPrevented: false })
  await Promise.resolve()
  assert.equal(f.trace.find(entry => entry.event === 'close-after-listeners').prevented, true)
  assert.equal(f.app.emit('activate'), false, 'preserve native emitter return semantics')
  assert.equal(f.app.emit('second-instance', {}, ['secret arguments never recorded']), false)
  assert.deepEqual(
    f.trace.filter(entry => entry.event === 'app-event').map(entry => entry.name),
    ['activate', 'second-instance']
  )
  f.api.dispose()
  f.api.dispose()
  assert.deepEqual(win.listeners('close'), [originalApplicationListener])
  for (const event of ['ready-to-show', 'show', 'minimize', 'restore', 'focus', 'blur'])
    assert.equal(win.listenerCount(event), 0)
  assert.equal(f.app.eventNames().length, 0)
  assert.equal(win.show.name, 'show')
  const count = f.trace.length
  win.show()
  assert.equal(f.trace.length, count)
})

test('actual production notify predicates and native-show decisions are observed without another guard evaluation', async () => {
  const source = await readFile(
    new URL('../../apps/desktop/src/main/notify.ts', import.meta.url),
    'utf8'
  )
  const f = fixture()
  const win = new f.BrowserWindow()
  let shown = 0
  class Notification extends EventEmitter {
    show() {
      shown++
      f.api.notification(true)
    }
  }
  // Execute the production guard itself, with native API stand-ins. No copied guard.
  const executable = stripTypeScriptTypes(source)
    .replace(/^import .* from 'electron'\s*$/m, '')
    .replace('export function notify', 'function notify')
  const notify = vm.runInNewContext(`${executable}\nnotify`, { Notification })
  f.api.observeNotifications()
  const payload = {
    backgroundOnly: true,
    title: 'Owl',
    body: 'Native browser reply.',
    sectionId: 'fixture'
  }
  const handler = (_event, value) => notify(value, () => win)
  f.ipcMain.handle('hexbot:notify', handler)
  for (const [visible, minimized, expectedGetters, expectedShows] of [
    [false, false, ['isVisible'], 1],
    [true, true, ['isVisible', 'isMinimized'], 1],
    [true, false, ['isVisible', 'isMinimized'], 0]
  ]) {
    win.visible = visible
    win.minimized = minimized
    f.calls.length = 0
    const before = f.trace.length,
      shownBefore = shown
    f.handlers.get('hexbot:notify')({}, payload)
    const records = f.trace.slice(before)
    assert.deepEqual(
      f.calls,
      expectedGetters,
      'diagnostics must not add native predicate queries to notification delivery'
    )
    assert.deepEqual(
      records.filter(entry => entry.event === 'notify-predicate').map(entry => entry.value),
      expectedGetters.map(name => (name === 'isVisible' ? visible : minimized))
    )
    assert.equal(shown - shownBefore, expectedShows)
    assert.equal(records.at(-1).nativeShowCalls, expectedShows)
    assert.equal(records.at(-1).matchingShowCalls, expectedShows)
    assert.equal(records[0].matching, true)
  }
  f.api.dispose()
  assert.equal(f.handlers.get('hexbot:notify'), handler)
})

test('handler receiver, arguments, return/rejection identity and original errors survive failing diagnostics', async () => {
  const f = fixture(() => {
    throw new Error('diagnostic sink failed')
  })
  const receiver = {}
  const event = {},
    payload = {}
  const error = new Error('original handler failure')
  const result = Promise.reject(error)
  // Attach a rejection observer immediately; the wrapper must return this exact promise.
  const rejected = assert.rejects(result, value => value === error)
  let observed
  function handler(...args) {
    observed = { receiver: this, args }
    return result
  }
  f.ipcMain.handle('hexbot:notify', handler)
  assert.equal(f.handlers.get('hexbot:notify').call(receiver, event, payload), result)
  assert.deepEqual(observed, { receiver, args: [event, payload] })
  await rejected
  f.ipcMain.removeHandler('hexbot:notify')
  f.ipcMain.handle('hexbot:notify', () => {
    throw error
  })
  assert.throws(
    () => f.handlers.get('hexbot:notify')({}, payload),
    value => value === error
  )
  const untouched = () => result
  f.ipcMain.handle('unrelated', untouched)
  assert.equal(f.handlers.get('unrelated'), untouched)
  const laterOwner = () => {}
  f.BrowserWindow.prototype.show = laterOwner
  f.api.dispose()
  assert.equal(f.BrowserWindow.prototype.show, laterOwner)
})

test('emitted CJS preload runs before main and bounds/redacts actual file output, including quoted secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hexbot-native-window-diagnostic-'))
  const file = join(dir, 'trace.jsonl')
  const f = fixture(false)
  const require = createRequire(import.meta.url)
  const secret = 'synthetic-quoted-"device-value'
  const context = vm.createContext({
    require: name => (name === 'electron' ? f.electron : require(name)),
    process: {
      env: { DEVICE_TOKEN: secret },
      versions: process.versions,
      pid: process.pid,
      ppid: process.ppid
    },
    Buffer,
    URL,
    queueMicrotask
  })
  try {
    const preload = await writeNativeWindowPreload(dir, file)
    vm.runInContext(await readFile(preload, 'utf8'), context)
    f.app.ready = true
    const win = new f.BrowserWindow()
    f.app.emit('browser-window-created', {}, win)
    // Function sourceURL becomes a real captured stack, through the same formatter
    // used for all emitted events. Redact before truncation and JSON serialization.
    vm.runInContext(
      `globalThis.invoke = () => win.show()\n//# sourceURL=https://user:password@example.test/fixture?code=private-query`,
      vm.createContext({ win })
    )()
    // Use a long window ID only in this control to send hostile diagnostic strings
    // through the actual preload writer, rather than testing the redactor alone.
    win.id = `{"deviceToken":"synthetic-device-value"} ${secret} https://user:private-password@example.test/?code=private-code`
    for (let index = 0; index < 400; index++) win.show()
    const emitted = await readFile(file, 'utf8')
    for (const value of [
      secret,
      'synthetic-device-value',
      'private-password',
      'private-code',
      'private-query'
    ])
      assert(!emitted.includes(value), value)
    assert(emitted.includes('[redacted]'))
    const entries = emitted
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    assert.equal(entries[0].ready, false)
    assert(entries.some(entry => entry.name === 'created'))
    assert(entries.some(entry => entry.method === 'show'))
    assert(entries.length <= 256)
    assert(Buffer.byteLength(emitted) <= 65536)
    context.hexbotNativeWindowDiagnostics.dispose()
    assert.equal(f.app.eventNames().length, 0)
    // An unavailable diagnostic destination cannot prevent main from running.
    const failing = fixture(false)
    const failingContext = vm.createContext({
      ...context,
      require: name => (name === 'electron' ? failing.electron : require(name))
    })
    await writeFile(file, 'retain original trace')
    vm.runInContext(await readFile(preload, 'utf8'), failingContext)
    assert.equal(failingContext.hexbotNativeWindowTraceUnavailable, true)
    assert.equal(await readFile(file, 'utf8'), 'retain original trace')
    failingContext.hexbotNativeWindowDiagnostics.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
