import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BrowserWindow, app } from 'electron'

import { resolveWebDevUrl } from './dev-url'
import { checkForUpdates } from './updater'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    height: 800,
    minHeight: 600,
    minWidth: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(currentDirectory, '../preload/index.js')
    },
    width: 1200
  })

  window.once('ready-to-show', () => window.show())

  if (app.isPackaged) {
    void window.loadFile(join(currentDirectory, '../renderer/index.html'))
  } else {
    void window.loadURL(resolveWebDevUrl())
  }

  return window
}

void app.whenReady().then(() => {
  createWindow()
  checkForUpdates()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
