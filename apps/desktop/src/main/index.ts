import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type Rectangle
} from 'electron'
import { applicationMenuTemplate } from './application-menu'
import { APP_ORIGIN, installAppProtocol, registerAppScheme } from './app-protocol'
import { bootstrap, type BootstrapProgress } from './backend/bootstrap'
import { DaemonManager } from './backend/manager'
import { hexbotHome } from './backend/paths'
import { resolveWebDevUrl } from './dev-url'
import { edition, hasRuntime, requireRuntime } from './edition'
import { parseDeepLink } from './deep-link'
import { notify } from './notify'
import { pair, pairWithGrant, type GrantPairOptions, type PairOptions } from './pair'
import { installService, serviceStatus, uninstallService } from './service'
import { createTray } from './tray'
import { setCrashReports, startCrashReports } from './crash-reports'
import { readDesktopState, updateDesktopState } from './desktop-state'
import {
  checkForUpdates,
  getUpdateChannel,
  installUpdate,
  setUpdateChannel,
  updaterEvents
} from './updater'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const rendererDirectory = join(currentDirectory, '../renderer')
if (!app.isPackaged) app.setName(hasRuntime ? 'Hexbot (dev)' : 'Hexbot Client (dev)')
const devIcon = !app.isPackaged ? join(currentDirectory, '../../resources/icon-dev.png') : undefined
// Keep Chromium's profile (localStorage, caches) inside the Hexbot home so an
// install is self-contained and tests with a temporary home start clean.
app.setPath('userData', join(hexbotHome(), 'desktop-data'))
await startCrashReports()
registerAppScheme()
let mainWindow: BrowserWindow | null = null
let pendingLink = app.isPackaged ? process.argv.find(arg => parseDeepLink(arg) !== null) : undefined
let daemon: DaemonManager
let quitting = false

function validString(value: unknown, name: string, max = 1_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new TypeError(`Invalid ${name}`)
  return value.trim()
}
function validatePair(value: unknown): PairOptions {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid pair options')
  const item = value as Record<string, unknown>
  const host = validString(item.host, 'host', 253)
  if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)$/i.test(host)) throw new TypeError('Invalid host')
  if (!Number.isInteger(item.port) || Number(item.port) < 1 || Number(item.port) > 65_535)
    throw new TypeError('Invalid port')
  return {
    host,
    port: Number(item.port),
    code: validString(item.code, 'code', 64),
    deviceName: validString(item.deviceName, 'device name', 128)
  }
}
function validateGrantPair(value: unknown): GrantPairOptions {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid grant pair options')
  const item = value as Record<string, unknown>
  const host = validString(item.host, 'host', 253)
  if (!/^(?:\[[0-9a-f:]+\](?::\d+)?|[a-z0-9.-]+(?::\d+)?)$/i.test(host))
    throw new TypeError('Invalid host')
  if (item.tls !== undefined && typeof item.tls !== 'boolean') throw new TypeError('Invalid TLS')
  return {
    host,
    grant: validString(item.grant, 'grant', 4_096),
    deviceName: validString(item.deviceName, 'device name', 128),
    tls: item.tls as boolean | undefined
  }
}
async function loadBounds(): Promise<Partial<Rectangle>> {
  try {
    const value = await readDesktopState()
    return value.width && value.height ? value : {}
  } catch {
    return {}
  }
}
async function saveBounds(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return
  await updateDesktopState(window.getBounds())
}
async function createWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  const window = new BrowserWindow({
    icon: devIcon,
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    ...(await loadBounds()),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Matches the page background in tokens.css, so the first frame is not white.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e0e0e' : '#ffffff',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(currentDirectory, '../preload/index.js')
    }
  })
  if (!app.isPackaged) {
    window.setTitle(app.name)
    window.on('page-title-updated', event => event.preventDefault())
  }
  mainWindow = window
  window.once('ready-to-show', () => {
    window.show()
    if (pendingLink) {
      window.webContents.send('hexbot:navigate', pendingLink)
      pendingLink = undefined
    }
  })
  window.on('close', event => {
    if (!quitting && process.platform === 'darwin' && daemon.status().state === 'running') {
      event.preventDefault()
      window.hide()
    }
  })
  window.on('closed', () => {
    mainWindow = null
  })
  window.on('resize', () => void saveBounds(window))
  window.on('move', () => void saveBounds(window))
  if (app.isPackaged) await window.loadURL(`${APP_ORIGIN}/`)
  else {
    const devUrl = resolveWebDevUrl()
    try {
      const response = await fetch(devUrl, { signal: AbortSignal.timeout(2_000) })
      if (!response.ok) throw new Error(`Web dev server returned ${response.status}`)
      await window.loadURL(devUrl)
    } catch {
      if (existsSync(join(rendererDirectory, 'index.html'))) await window.loadURL(`${APP_ORIGIN}/`)
      else await window.loadURL('data:text/html,<title>Hexbot</title>')
    }
  }
  return window
}
function navigate(url: string): void {
  if (url !== '/settings/providers' && !parseDeepLink(url)) return
  if (!app.isReady()) {
    pendingLink = url
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.webContents.send('hexbot:navigate', url)
  } else {
    pendingLink = url
    void createWindow()
  }
}
function sendProgress(progress: BootstrapProgress): void {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send('hexbot:daemon:progress', progress)
}
function registerIpc(): void {
  ipcMain.handle('hexbot:http-fetch', async (_event, rawUrl: unknown, rawInit: unknown) => {
    // The renderer runs on hexbot-app://, which the daemon's CORS policy does
    // not admit; the main process performs its HTTP calls instead.
    const url = validString(rawUrl, 'url', 4_096)
    if (!/^https?:\/\//.test(url)) throw new TypeError('Only http(s) URLs are allowed')
    const init = (rawInit ?? {}) as { method?: unknown; headers?: unknown; body?: unknown }
    const method = typeof init.method === 'string' ? init.method.toUpperCase() : 'GET'
    const headers: Record<string, string> = {}
    if (init.headers && typeof init.headers === 'object')
      for (const [key, value] of Object.entries(init.headers as Record<string, unknown>))
        if (typeof value === 'string' && key.length < 200) headers[key] = value
    const body = typeof init.body === 'string' ? init.body : undefined
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(30_000)
    })
    return {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      text: await response.text()
    }
  })
  ipcMain.on('hexbot:metadata', event => {
    event.returnValue = {
      e2eTarget: process.env.HEXBOT_E2E_TARGET,
      platform: process.platform,
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      edition
    }
  })
  ipcMain.handle('hexbot:daemon:status', () => daemon.status())
  ipcMain.handle('hexbot:daemon:start', async () => {
    requireRuntime('Running a daemon on this machine')
    await bootstrap(sendProgress)
    return daemon.start()
  })
  ipcMain.handle('hexbot:daemon:stop', () => daemon.stop())
  ipcMain.handle('hexbot:daemon:local-token', async () => {
    try {
      return (await readFile(join(hexbotHome(), 'local-device.token'), 'utf8')).trim() || null
    } catch {
      return null
    }
  })
  ipcMain.handle('hexbot:pair', (_event, value: unknown) => pair(validatePair(value)))
  ipcMain.handle('hexbot:pair-with-grant', (_event, value: unknown) =>
    pairWithGrant(validateGrantPair(value))
  )
  ipcMain.handle('hexbot:notify', (_event, value: unknown) => {
    if (!value || typeof value !== 'object') throw new TypeError('Invalid notification')
    const item = value as Record<string, unknown>
    notify(
      {
        title: validString(item.title, 'title', 200),
        body: validString(item.body, 'body', 2_000),
        sectionId: validString(item.sectionId, 'section id', 256)
      },
      () => mainWindow
    )
  })
  ipcMain.handle('hexbot:open-external', (_event, value: unknown) => {
    const url = new URL(validString(value, 'URL', 2_048))
    if (!['https:', 'http:'].includes(url.protocol)) throw new TypeError('Unsupported URL')
    return shell.openExternal(url.href)
  })
  ipcMain.handle(
    'hexbot:pick-files',
    async () =>
      (await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })).filePaths
  )
  ipcMain.handle('hexbot:updater:check', () => checkForUpdates())
  ipcMain.handle('hexbot:updater:install', () => installUpdate())
  ipcMain.handle('hexbot:updater:channel', () => getUpdateChannel())
  ipcMain.handle('hexbot:updater:set-channel', (_event, channel: unknown) => {
    if (channel !== 'stable' && channel !== 'nightly') throw new TypeError('Invalid update channel')
    return setUpdateChannel(channel)
  })
  ipcMain.handle('hexbot:crash-reports:set', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new TypeError('Invalid crash report preference')
    return setCrashReports(enabled)
  })
  ipcMain.handle('hexbot:service:install', () => {
    requireRuntime('Starting the daemon at login')
    return installService()
  })
  ipcMain.handle('hexbot:service:uninstall', () => uninstallService())
  ipcMain.handle('hexbot:service:status', () => serviceStatus())
}

if (app.isPackaged) app.setAsDefaultProtocolClient('hexbot')
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', (_event, argv) => {
    const link = argv.find(arg => arg.startsWith('hexbot://'))
    if (link) navigate(link)
    else void createWindow()
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    navigate(url)
  })
  void app.whenReady().then(async () => {
    if (devIcon && process.platform === 'darwin') app.dock?.setIcon(devIcon)
    installAppProtocol(rendererDirectory, existsSync)
    daemon = new DaemonManager(undefined, async () => (await serviceStatus()).installed)
    registerIpc()
    if (process.platform === 'darwin')
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(
          applicationMenuTemplate(
            {
              openSettings: () => navigate('/settings/providers'),
              checkForUpdates: () => void checkForUpdates(),
              quit: () => app.quit()
            },
            app.name
          )
        )
      )
    updaterEvents.on('status', status => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('hexbot:updater:status', status)
    })
    await createWindow()
    createTray(daemon, () => {
      void createWindow()
      return mainWindow!
    })
    // The full package checks only once its runtime is installed; the client
    // package has nothing to install first.
    if (app.isPackaged && (!hasRuntime || existsSync(join(hexbotHome(), 'runtime'))))
      void checkForUpdates().catch(error => console.error('Update check failed', error))
    app.on('activate', () => void createWindow())
  })
}
app.on('before-quit', () => {
  quitting = true
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
