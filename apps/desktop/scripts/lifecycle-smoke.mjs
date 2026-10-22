// Builds and launches real Electron on the host OS. No runtime downloads,
// provider credentials, live home, logoff, shutdown, or updater installation.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(desktop, 'package.json'))
const { _electron: electron, expect } = require('@playwright/test')
const { build } = await import('vite')
const executablePath = process.env.HEXBOT_LIFECYCLE_APP || require('electron')
const artifacts =
  process.env.HEXBOT_LIFECYCLE_ARTIFACTS ||
  (await mkdtemp(join(tmpdir(), 'hexbot-lifecycle-evidence-')))
await mkdir(artifacts, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'hexbot-lifecycle-'))
const environment = { ...process.env, HEXBOT_WEB_DEV_URL: 'http://127.0.0.1:1' }
delete environment.ELECTRON_RUN_AS_NODE
const results = []
let currentApp

async function prepare(edition) {
  const directory = join(root, edition)
  await mkdir(directory)
  await promisify(execFile)(
    process.execPath,
    [
      join(desktop, 'node_modules/electron-vite/bin/electron-vite.js'),
      'build',
      '--outDir',
      join(directory, 'out')
    ],
    {
      cwd: desktop,
      env: { ...environment, HEXBOT_EDITION: edition },
      timeout: 120_000
    }
  )
  const manifest = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'))
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
  await symlink(
    join(desktop, 'node_modules'),
    join(directory, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await cp(join(desktop, 'resources'), join(directory, 'resources'), {
    recursive: true,
    filter: source => !source.includes('hexbot-native') && !source.includes('hexbot-src')
  })
  await cp(join(desktop, '../web/dist'), join(directory, 'out/renderer'), { recursive: true })
  return directory
}
async function launch(directory, name) {
  const home = join(root, `${name}-home`)
  await mkdir(home)
  currentApp = await electron.launch({
    executablePath,
    args: [
      ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []),
      ...(process.env.HEXBOT_LIFECYCLE_APP ? [] : [directory])
    ],
    env: { ...environment, HEXBOT_HOME: home },
    timeout: 30_000
  })
  return currentApp
}
async function quit(app, fromTray = false) {
  const closed = app.waitForEvent('close', { timeout: 15_000 })
  await app.evaluate(({ app }, fromTray) => {
    setImmediate(() => {
      if (fromTray)
        globalThis.lifecycleFixture.trayMenu.items.find(item => item.label === 'Quit').click()
      else app.quit()
    })
  }, fromTray)
  await closed
  currentApp = undefined
}

try {
  for (const edition of process.env.HEXBOT_LIFECYCLE_APP ? ['client'] : ['full', 'client']) {
    const directory = process.env.HEXBOT_LIFECYCLE_APP ? desktop : await prepare(edition)
    const app = await launch(directory, edition)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    assert.equal(await page.evaluate(() => window.hexbot.edition), edition)
    await expect.poll(() => app.evaluate(({ Menu }) => !!Menu.getApplicationMenu())).toBe(true)
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling()
      ),
      false
    )
    // Set a sentinel in the real renderer: close/reopen must retain this page.
    await page.evaluate(() => {
      window.lifecycleSentinel = 'kept'
    })
    const windowId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]
          return process.platform === 'linux' ? win.isMinimized() : !win.isVisible()
        })
      )
      .toBe(true)
    assert.equal(await page.evaluate(() => window.lifecycleSentinel), 'kept')
    await app.evaluate(({ app }) => app.emit('activate'))
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]
          return win.isVisible() && !win.isMinimized()
        })
      )
      .toBe(true)
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id),
      windowId
    )
    // A real second process must exit and reopen the first instance.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    const env = await app.evaluate(() => ({
      home: process.env.HEXBOT_HOME,
      executable: process.execPath
    }))
    const second = spawn(env.executable, process.env.HEXBOT_LIFECYCLE_APP ? [] : [directory], {
      env: { ...environment, HEXBOT_HOME: env.home },
      stdio: 'ignore'
    })
    const timer = setTimeout(() => second.kill(), 15_000)
    const [code] = await once(second, 'exit')
    clearTimeout(timer)
    assert.equal(code, 0, 'Second launch must hand off and exit')
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]
          return win.isVisible() && !win.isMinimized()
        })
      )
      .toBe(true)
    assert.equal(await page.evaluate(() => window.lifecycleSentinel), 'kept')
    await page.screenshot({ path: join(artifacts, `${edition}-reopened.png`) })
    // Capture the native File submenu on Windows/Linux, not a rendered mock.
    if (process.platform !== 'darwin') {
      await app.evaluate(({ BrowserWindow, Menu }) =>
        Menu.getApplicationMenu().items[0].submenu.popup({
          window: BrowserWindow.getAllWindows()[0],
          x: 10,
          y: 30
        })
      )
      const screenshot = await app.evaluate(async ({ desktopCapturer }) => {
        const [source] = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1600, height: 1200 }
        })
        return source.thumbnail.toPNG().toString('base64')
      })
      await writeFile(
        join(artifacts, `${edition}-file-menu.png`),
        Buffer.from(screenshot, 'base64')
      )
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.closePopup())
    }
    // Quit while backgrounded through the same native menu action users have.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    const closed = app.waitForEvent('close', { timeout: 15_000 })
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu().items[0].submenu.items.find(
        item => item.role === 'quit'
      )
      if (!item) throw new Error('Missing native Quit menu')
      setImmediate(() => item.click())
    })
    await closed
    currentApp = undefined
    results.push({ edition, closeReopenSecondLaunchQuit: 'passed' })
    const endingApp = await launch(directory, `${edition}-session`)
    await endingApp.firstWindow()
    await expect
      .poll(() => endingApp.evaluate(({ powerMonitor }) => powerMonitor.listenerCount('shutdown')))
      .toBeGreaterThan(0)
    const session = await endingApp
      .evaluate(({ BrowserWindow, powerMonitor }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (process.platform === 'win32')
          win.emit('session-end', {
            preventDefault() {
              throw new Error('Session end vetoed')
            }
          })
        else
          powerMonitor.emit('shutdown', {
            preventDefault() {
              throw new Error('Shutdown vetoed')
            }
          })
        // before-quit is intentionally absent here.
        let prevented = false
        win.once('close', event => {
          prevented = event.defaultPrevented
        })
        win.close()
        return !prevented
      })
      .catch(error => {
        // On Windows/Linux window-all-closed quits the process immediately.
        if (endingApp.process().exitCode === 0) return true
        throw error
      })
    assert(session, 'OS session end must allow native close')
    if (process.platform === 'darwin') {
      await expect
        .poll(() => endingApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
        .toBe(0)
      await quit(endingApp)
    } else await expect.poll(() => endingApp.process().exitCode).toBe(0)
    currentApp = undefined
    results.push({ edition, osEventClose: 'passed' })
  }
  if (!process.env.HEXBOT_LIFECYCLE_APP) {
    const fixture = join(root, 'fixture')
    await mkdir(fixture)
    await cp(join(desktop, 'resources'), join(fixture, 'resources'), {
      recursive: true,
      filter: source => source.endsWith('resources') || source.endsWith('.png')
    })
    await writeFile(
      join(fixture, 'package.json'),
      JSON.stringify({ type: 'module', main: 'fixture.js' })
    )
    await build({
      configFile: false,
      logLevel: 'warn',
      define: { __HEXBOT_EDITION__: '"full"' },
      build: {
        target: 'esnext',
        outDir: fixture,
        emptyOutDir: false,
        lib: {
          entry: join(desktop, 'e2e/lifecycle-fixture.mjs'),
          formats: ['es'],
          fileName: () => 'fixture.js'
        },
        rollupOptions: { external: ['electron', 'node:events', 'node:path'] }
      }
    })
    for (const mode of ['update', 'session-end', 'tray-absent']) {
      const app = await launch(fixture, mode)
      await expect.poll(() => app.evaluate(() => !!globalThis.lifecycleFixture)).toBe(true)
      const state = await app.evaluate(async (_electron, mode) => {
        const { lifecycle, window, tray, trayMenu, calls } = globalThis.lifecycleFixture
        tray.emit('double-click')
        if (process.platform !== 'darwin') tray.emit('click')
        const opens = calls.opens
        trayMenu.items.find(item => item.label.startsWith('Open ')).click()
        trayMenu.items.find(item => item.label === 'Stop daemon')?.click()
        if (mode === 'tray-absent') tray.destroy()
        window.close()
        const retained = !window.isDestroyed()
        const minimized = retained && window.isMinimized()
        if (mode === 'update') {
          lifecycle.setInstalling(true)
          lifecycle.setInstalling(false)
          window.show()
          window.close()
          if (window.isDestroyed()) throw new Error('Failed update must restore ordinary close')
          lifecycle.setInstalling(true)
        } else if (mode === 'session-end') {
          window.emit('session-end', {
            preventDefault() {
              throw new Error('Session end vetoed')
            }
          })
        }
        if (mode !== 'tray-absent')
          await new Promise(resolve => {
            window.once('closed', resolve)
            window.close()
          })
        return { retained, minimized, opens, calls, destroyed: window.isDestroyed() }
      }, mode)
      assert(state.retained)
      assert.equal(state.opens, process.platform === 'darwin' ? 1 : 2)
      assert.equal(state.calls.stops, 1)
      assert.equal(state.calls.opens, state.opens + 1)
      if (mode !== 'tray-absent') assert(state.destroyed)
      else if (process.platform !== 'darwin')
        assert(state.minimized, 'No tray must keep a taskbar entry')
      await quit(app, true)
      results.push({ fixture: mode, passed: true })
    }
  }
  await writeFile(
    join(artifacts, 'results.json'),
    JSON.stringify({ platform: process.platform, results }, null, 2)
  )
  console.log(JSON.stringify({ platform: process.platform, results, artifacts }, null, 2))
} finally {
  if (currentApp) await quit(currentApp).catch(() => currentApp.process().kill())
  await rm(root, { recursive: true, force: true })
}
