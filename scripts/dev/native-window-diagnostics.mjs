// Smoke harness only. Loaded by stock Electron with -r before application main.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { formatStartupDiagnostic, startupRedactor } from '../desktop/installed-app-startup.mjs'

export function instrumentNativeWindow({ app, BrowserWindow, ipcMain }, write) {
  const key = Symbol.for('hexbot.smoke.native-window-diagnostics')
  if (app[key]) return app[key]
  const undo = []
  const events = []
  let active = true
  let invocation
  let nextInvocation = 0
  let observedWindows = 0
  let registration
  let notificationsObserved = false
  const phases = new Set()
  const record = (event, details = {}) => {
    if (!active) return
    try {
      write({ event, time: Date.now(), ...details })
    } catch {
      /* Diagnostics cannot change application errors. */
    }
  }
  const prototype = BrowserWindow.prototype
  const predicates = Object.fromEntries(
    ['isDestroyed', 'isVisible', 'isMinimized', 'isFocused'].map(name => [name, prototype[name]])
  )
  const state = win => {
    try {
      const destroyed = Reflect.apply(predicates.isDestroyed, win, [])
      return {
        id: win.id,
        destroyed,
        ...(!destroyed
          ? {
              visible: Reflect.apply(predicates.isVisible, win, []),
              minimized: Reflect.apply(predicates.isMinimized, win, []),
              focused: Reflect.apply(predicates.isFocused, win, [])
            }
          : {})
      }
    } catch {
      return { snapshotUnavailable: true }
    }
  }
  const listen = (emitter, event, callback) => {
    emitter.on(event, callback)
    undo.push(() => emitter.off(event, callback))
  }
  const replace = (object, name, make) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, name)
    const original = object[name]
    const wrapped = make(original)
    Object.defineProperty(object, name, { configurable: true, writable: true, value: wrapped })
    undo.push(() => {
      // Leave any later owner replacement intact.
      if (object[name] !== wrapped) return
      if (descriptor) Object.defineProperty(object, name, descriptor)
      else delete object[name]
    })
  }
  for (const name of ['show', 'showInactive', 'restore', 'focus', 'close', 'minimize']) {
    replace(
      prototype,
      name,
      original =>
        function (...args) {
          record('call-enter', {
            method: name,
            ...state(this),
            stack: new Error().stack?.split('\n').slice(1, 9).join('\n')
          })
          try {
            const result = Reflect.apply(original, this, args)
            record('call-return', { method: name, ...state(this) })
            return result
          } catch (error) {
            record('call-throw', { method: name, ...state(this) })
            throw error
          }
        }
    )
  }
  for (const name of ['isVisible', 'isMinimized']) {
    replace(
      prototype,
      name,
      original =>
        function (...args) {
          const value = Reflect.apply(original, this, args)
          if (invocation)
            record('notify-predicate', {
              invocation: invocation.id,
              method: name,
              id: this.id,
              value
            })
          return value
        }
    )
  }
  listen(app, 'browser-window-created', (_event, win) => {
    if (++observedWindows > 16) return
    const observe = (event, native) => {
      const entry = { event, time: Date.now(), ...state(win), prevented: native?.defaultPrevented }
      events.push(entry)
      if (events.length > 100) events.shift()
      record('window-event', { ...entry, event: 'window-event', name: event })
      // Observe the final close decision without moving any application listener.
      if (event === 'close')
        queueMicrotask(() =>
          record('close-after-listeners', { ...state(win), prevented: native?.defaultPrevented })
        )
    }
    for (const event of [
      'ready-to-show',
      'close',
      'closed',
      'show',
      'hide',
      'minimize',
      'restore',
      'focus',
      'blur'
    ])
      listen(win, event, native => observe(event, native))
    observe('created')
  })
  // An activate observer would satisfy the smoke's production-listener-count
  // readiness check early. Observe emission without adding a listener.
  replace(
    app,
    'emit',
    original =>
      function (event, ...args) {
        if (event === 'activate' || event === 'second-instance')
          record('app-event', { name: event })
        return Reflect.apply(original, this, [event, ...args])
      }
  )
  const originalHandle = ipcMain.handle
  const originalRemove = ipcMain.removeHandler
  replace(
    ipcMain,
    'handle',
    original =>
      function (channel, handler) {
        if (channel !== 'hexbot:notify') return Reflect.apply(original, this, arguments)
        const wrapped = function (...args) {
          const previous = invocation
          const current = { id: ++nextInvocation, nativeShowCalls: 0, matchingShowCalls: 0 }
          invocation = current
          let metadata = {}
          try {
            const payload = args[1]
            const fields =
              payload && typeof payload === 'object'
                ? Object.getOwnPropertyDescriptors(payload)
                : {}
            metadata = {
              backgroundOnly: fields.backgroundOnly?.value === true,
              matching:
                fields.title?.value === 'Owl' && fields.body?.value === 'Native browser reply.'
            }
          } catch {
            /* Do not replace the handler's validation error. */
          }
          record('notify-enter', {
            invocation: current.id,
            notificationObserver: notificationsObserved,
            ...metadata
          })
          try {
            const result = Reflect.apply(handler, this, args)
            record('notify-return', {
              invocation: current.id,
              nativeShowCalls: notificationsObserved ? current.nativeShowCalls : null,
              matchingShowCalls: notificationsObserved ? current.matchingShowCalls : null
            })
            return result
          } catch (error) {
            record('notify-throw', {
              invocation: current.id,
              nativeShowCalls: current.nativeShowCalls
            })
            throw error
          } finally {
            invocation = previous
          }
        }
        const result = Reflect.apply(original, this, [channel, wrapped])
        registration = { handler, wrapped }
        return result
      }
  )
  replace(
    ipcMain,
    'removeHandler',
    original =>
      function (channel) {
        const result = Reflect.apply(original, this, arguments)
        if (channel === 'hexbot:notify') registration = undefined
        return result
      }
  )
  const api = {
    events,
    observeNotifications() {
      notificationsObserved = true
    },
    mark(phase, transition) {
      if (
        ['before-action', 'background-observed', 'reply-release', 'reply-complete'].includes(
          phase
        ) &&
        ['closed', 'minimized', 'foreground'].includes(transition) &&
        !phases.has(`${phase}:${transition}`)
      ) {
        phases.add(`${phase}:${transition}`)
        record('phase', { phase, transition })
      }
    },
    notification(matching) {
      if (invocation) {
        invocation.nativeShowCalls++
        if (matching) invocation.matchingShowCalls++
      }
      record('notification-show', { invocation: invocation?.id, matching: matching === true })
    },
    dispose() {
      if (!active) return
      record('disposed')
      active = false
      // Only the registration still owned by this wrapper is restored.
      if (
        registration &&
        ipcMain.handle === installedHandle &&
        ipcMain.removeHandler === installedRemove
      ) {
        Reflect.apply(originalRemove, ipcMain, ['hexbot:notify'])
        Reflect.apply(originalHandle, ipcMain, ['hexbot:notify', registration.handler])
      }
      for (const remove of undo.reverse()) remove()
      undo.length = 0
      registration = undefined
      invocation = undefined
      delete app[key]
    }
  }
  const installedHandle = ipcMain.handle
  const installedRemove = ipcMain.removeHandler
  app[key] = api
  listen(app, 'will-quit', () => api.dispose())
  record('installed', {
    ready: app.isReady(),
    pid: process.pid,
    ppid: process.ppid,
    electron: process.versions.electron,
    node: process.versions.node
  })
  return api
}

export async function writeNativeWindowPreload(directory, traceFile) {
  const preload = join(directory, 'native-window-preload.cjs')
  await writeFile(
    preload,
    `const fs = require('node:fs');
const redact = (${startupRedactor.toString()})(process.env);
const format = ${formatStartupDiagnostic.toString()};
let count = 0, bytes = 0, writable = true;
const file = ${JSON.stringify(traceFile)};
try { fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 }); }
catch { writable = false; globalThis.hexbotNativeWindowTraceUnavailable = true; }
globalThis.hexbotNativeWindowDiagnostics = (${instrumentNativeWindow.toString()})(require('electron'), entry => {
  if (!writable) return;
  let line = format(entry, text => redact(text).slice(0, 2048)) + '\\n';
  let size = Buffer.byteLength(line);
  if (count >= 255 || size > 8192 || bytes + size > 65280) {
    line = JSON.stringify({ event: 'trace-limit', time: Date.now() }) + '\\n';
    size = Buffer.byteLength(line);
    writable = false;
  }
  try { fs.appendFileSync(file, line); count++; bytes += size; }
  catch { writable = false; globalThis.hexbotNativeWindowTraceUnavailable = true; }
});
globalThis.smokeWindowEvents = globalThis.hexbotNativeWindowDiagnostics.events;
`,
    { flag: 'wx' }
  )
  return preload
}
