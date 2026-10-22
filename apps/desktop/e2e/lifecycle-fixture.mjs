// Native Electron fixture for close paths that must not log off the CI host
// or install an update. It uses the production lifecycle and tray modules.
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { app, BrowserWindow, Menu } from 'electron'
import { WindowLifecycle } from '../src/main/window-lifecycle'
import { createTray } from '../src/main/tray'

if (!process.env.HEXBOT_HOME) throw new Error('Lifecycle fixture needs a disposable home')
app.setPath('userData', join(process.env.HEXBOT_HOME, 'desktop-data'))

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
  await window.loadURL('data:text/html,<title>Lifecycle fixture</title>')
  // Capture Quit before testing it, so the harness can inspect native close.
  app.on('before-quit', () => {
    calls.quits++
  })
  globalThis.lifecycleFixture = { lifecycle, window, tray, trayMenu, calls }
})
