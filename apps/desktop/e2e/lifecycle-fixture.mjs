// Native Electron fixture for close paths that must not log off the CI host
// or install an update. It uses the production lifecycle and tray modules.
import { EventEmitter } from 'node:events'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Menu } from 'electron'
import { WindowLifecycle } from '../src/main/window-lifecycle'
import { createTray } from '../src/main/tray'

if (!process.env.HEXBOT_HOME) throw new Error('Lifecycle fixture needs a disposable home')
if (!process.env.HEXBOT_LIFECYCLE_TRACE) throw new Error('Lifecycle fixture needs an event trace')
app.setPath('userData', join(process.env.HEXBOT_HOME, 'desktop-data'))
let sequence = 0
const trace = (event, details = {}) =>
  appendFileSync(
    process.env.HEXBOT_LIFECYCLE_TRACE,
    JSON.stringify({ sequence: ++sequence, event, ...details }) + '\n'
  )
trace('fixture-start', {
  platform: process.platform,
  electron: process.versions.electron,
  node: process.versions.node
})
// Match the app's explicit policy. Electron's default handler otherwise quits
// on every platform when the last window closes, including macOS.
app.on('window-all-closed', () => {
  trace('window-all-closed')
  if (process.platform !== 'darwin') app.quit()
})
for (const event of ['before-quit', 'will-quit', 'quit']) app.on(event, () => trace(event))
process.on('exit', code => trace('process-exit', { code }))

void app.whenReady().then(async () => {
  const lifecycle = new WindowLifecycle()
  app.on('before-quit', () => lifecycle.beginQuit())
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  const calls = { starts: 0, stops: 0, opens: 0, quits: 0 }
  const manager = Object.assign(new EventEmitter(), {
    status: () => ({ state: 'running', port: 9119 }),
    start: async () => {
      calls.starts++
    },
    stop: async () => {
      calls.stops++
    }
  })
  let trayMenu
  const buildMenu = Menu.buildFromTemplate
  Menu.buildFromTemplate = template => {
    trayMenu = buildMenu(template)
    return trayMenu
  }
  const tray = createTray(manager, () => {
    calls.opens++
    if (window.isMinimized()) window.restore()
    window.show()
  })
  Menu.buildFromTemplate = buildMenu
  lifecycle.attach(
    window,
    () => !tray.isDestroyed(),
    () => {}
  )
  for (const event of ['show', 'hide', 'minimize', 'restore', 'session-end', 'closed'])
    window.on(event, () => trace(event))
  window.on('close', event =>
    trace('close', { prevented: event.defaultPrevented, exiting: lifecycle.exiting })
  )
  window.webContents.on('destroyed', () => trace('web-contents-destroyed'))
  window.webContents.on('render-process-gone', (_event, details) =>
    trace('render-process-gone', details)
  )
  await window.loadURL('data:text/html,<title>Lifecycle fixture</title>')
  // Capture Quit before testing it, so the harness can inspect native close.
  app.on('before-quit', () => {
    calls.quits++
  })
  globalThis.lifecycleFixture = { lifecycle, window, tray, trayMenu, calls, trace }
  trace('fixture-ready')
})
