import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, app, dialog, ipcMain, shell, type Rectangle } from 'electron'
import { bootstrap, type BootstrapProgress } from './backend/bootstrap'
import { DaemonManager } from './backend/manager'
import { hexbotHome } from './backend/paths'
import { resolveWebDevUrl } from './dev-url'
import { notify } from './notify'
import { pair, type PairOptions } from './pair'
import { installService, serviceStatus, uninstallService } from './service'
import { createTray } from './tray'
import { checkForUpdates, installUpdate, updaterEvents } from './updater'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const stateFile = (): string => join(hexbotHome(), 'desktop-state.json')
let mainWindow: BrowserWindow | null = null
let pendingLink = app.isPackaged
  ? process.argv.find(arg => arg.startsWith('hexbot://pair?'))
  : undefined
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
async function loadBounds(): Promise<Partial<Rectangle>> {
  try {
    const value = JSON.parse(await readFile(stateFile(), 'utf8')) as Partial<Rectangle>
    return value.width && value.height ? value : {}
  } catch {
    return {}
  }
}
async function saveBounds(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return
  await mkdir(hexbotHome(), { recursive: true })
  await writeFile(stateFile(), JSON.stringify(window.getBounds()))
}
async function createWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    ...(await loadBounds()),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(currentDirectory, '../preload/index.js')
    }
  })
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
  if (app.isPackaged) await window.loadFile(join(currentDirectory, '../renderer/index.html'))
  else {
    const devUrl = resolveWebDevUrl()
    try {
      const response = await fetch(devUrl, { signal: AbortSignal.timeout(2_000) })
      if (!response.ok) throw new Error(`Web dev server returned ${response.status}`)
      await window.loadURL(devUrl)
    } catch {
      const builtRenderer = join(currentDirectory, '../renderer/index.html')
      if (existsSync(builtRenderer)) await window.loadFile(builtRenderer)
      else await window.loadURL('data:text/html,<title>Hexbot</title>')
    }
  }
  return window
}
function navigate(url: string): void {
  if (!url.startsWith('hexbot://pair?')) return
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
  ipcMain.on('hexbot:metadata', event => {
    event.returnValue = {
      platform: process.platform,
      version: app.getVersion(),
      isPackaged: app.isPackaged
    }
  })
  ipcMain.handle('hexbot:daemon:status', () => daemon.status())
  ipcMain.handle('hexbot:daemon:start', async () => {
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
  ipcMain.handle('hexbot:service:install', () => installService())
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
    daemon = new DaemonManager(undefined, async () => (await serviceStatus()).installed)
    registerIpc()
    updaterEvents.on('status', status => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('hexbot:updater:status', status)
    })
    await createWindow()
    createTray(daemon, () => {
      void createWindow()
      return mainWindow!
    })
    if (app.isPackaged && existsSync(join(hexbotHome(), 'runtime')))
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
