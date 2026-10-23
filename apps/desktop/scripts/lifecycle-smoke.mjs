// Builds and launches real Electron on the host OS. No runtime downloads,
// provider credentials, live home, logoff, shutdown, or updater installation.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { instrumentShutdown, observeShutdown, requestShutdown } from '../../../scripts/desktop/lifecycle-shutdown.mjs'

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
let currentProcess
const processes = new WeakMap()
const launchBounds = new WeakMap()
const shutdowns = new WeakMap()

function recordProcess(child, name) {
  const file = join(artifacts, `${name}-process.log`)
  const record = message => appendFileSync(file, message)
  record(`pid=${child.pid}\n`)
  child.stdout?.on('data', data => record(`[${Date.now()} stdout] ${data}`))
  child.stderr?.on('data', data => record(`[${Date.now()} stderr] ${data}`))
  child.on('exit', (code, signal) => record(`\nexit=${JSON.stringify({ time: Date.now(), code, signal })}\n`))
  return (event, details = {}) => record(`harness=${JSON.stringify({ event, time: Date.now(), ...details })}\n`)
}

function launchArgs(directory) {
  return [
    ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []),
    ...(process.env.HEXBOT_LIFECYCLE_APP ? [] : [directory])
  ]
}

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
async function launch(directory, name, fixture = false) {
  const home = join(root, `${name}-home`)
  await mkdir(home)
  const notBefore = Date.now()
  currentApp = await electron.launch({
    executablePath,
    args: launchArgs(directory),
    env: {
      ...environment,
      HEXBOT_HOME: home,
      ...(fixture ? { HEXBOT_LIFECYCLE_TRACE: join(artifacts, `${name}-events.jsonl`) } : {})
    },
    timeout: 30_000
  })
  // Playwright disposes its process accessor when the Electron connection closes.
  launchBounds.set(currentApp, { notBefore, notAfter: Date.now() })
  currentProcess = currentApp.process()
  processes.set(currentApp, currentProcess)
  const record = recordProcess(currentProcess, name)
  shutdowns.set(currentApp, observeShutdown(currentApp, currentProcess, record))
  await currentApp.evaluate(instrumentShutdown, join(artifacts, `${name}-shutdown.jsonl`))
  return currentApp
}
async function quit(app, source = 'app') {
  try {
    await requestShutdown(shutdowns.get(app), () => app.evaluate(({ app, Menu }, source) => {
      setImmediate(() => {
        globalThis.hexbotLifecycleTrace('shutdown-request', { source })
        globalThis.lifecycleFixture?.trace('shutdown-request', { source })
        if (source === 'tray')
          globalThis.lifecycleFixture.trayMenu.items.find(item => item.label === 'Quit').click()
        else if (source === 'window') globalThis.lifecycleFixture.window.close()
        else if (source === 'menu')
          Menu.getApplicationMenu().items[0].submenu.items.find(item => item.role === 'quit').click()
        else app.quit()
      })
    }, source))
    currentApp = undefined
  } catch (error) {
    // Diagnostics run only after a failed strict gate and before cleanup kills
    // the owned test process. They must never replace the primary failure.
    if (process.platform === 'win32') {
      try {
        const system = process.env.SystemRoot
        assert(system && isAbsolute(system))
        const program = join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe')
        const info = await lstat(program)
        assert(info.isFile() && !info.isSymbolicLink())
        const child = processes.get(app)
        let result
        try {
          const output = await promisify(execFile)(program,
            ['-NoProfile', '-NonInteractive', '-File', resolve(desktop, '../../scripts/desktop/windows-shutdown-diagnostic.ps1')],
            { cwd: tmpdir(), windowsHide: true, timeout: 5000, maxBuffer: 65536,
              env: { ...environment, HEXBOT_TEST_SHUTDOWN_PID: String(child.pid),
                HEXBOT_TEST_SHUTDOWN_IMAGE: executablePath,
                HEXBOT_TEST_SHUTDOWN_AFTER: String(launchBounds.get(app).notBefore),
                HEXBOT_TEST_SHUTDOWN_BEFORE: String(launchBounds.get(app).notAfter) } })
          result = { status: 0, ...output }
        } catch (diagnostic) {
          result = { status: diagnostic.code, signal: diagnostic.signal, message: diagnostic.message.slice(0, 2048),
            stdout: diagnostic.stdout, stderr: diagnostic.stderr }
        }
        const bounded = stream => ({ bytes: Buffer.byteLength(stream || ''), text: (stream || '').slice(0, 16384) })
        const evidence = { pid: child.pid, utc: new Date().toISOString(), source, phase: 'after strict deadline, before cleanup',
          observed: shutdowns.get(app).observed, status: result.status, signal: result.signal, message: result.message,
          stdout: bounded(result.stdout), stderr: bounded(result.stderr) }
        console.error('Native shutdown failure snapshot:', JSON.stringify(evidence))
        await writeFile(join(artifacts, `shutdown-failure-${child.pid}.json`), JSON.stringify(evidence, null, 2))
      } catch (diagnostic) { console.error('Shutdown diagnostics failed:', diagnostic.message) }
    }
    throw error
  }
}

async function background(app) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  // Minimize is asynchronous on Linux/Windows. Do not race a pending minimize
  // against activation or a second launch's restore.
  await expect
    .poll(
      () =>
        app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]
          return process.platform === 'linux' ? win.isMinimized() : !win.isVisible()
        }),
      { timeout: 10_000 }
    )
    .toBe(true)
}

async function rendered(app, page) {
  await expect
    .poll(
      () =>
        app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]
          return win.isVisible() && !win.isMinimized()
        }),
      { timeout: 10_000 }
    )
    .toBe(true)
  await page.waitForFunction(() => innerWidth > 0 && innerHeight > 0, undefined, {
    timeout: 10_000
  })
  // Native visibility and font readiness can precede Chromium's restored
  // viewport. Wait for actual frames and protocol geometry before capture.
  await page.waitForFunction(
    () =>
      new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))
      }),
    undefined,
    { timeout: 10_000 }
  )
  const session = await page.context().newCDPSession(page)
  try {
    let metrics
    await expect
      .poll(
        async () => {
          metrics = await session.send('Page.getLayoutMetrics')
          return (
            [metrics.cssLayoutViewport, metrics.cssVisualViewport].every(
              viewport => viewport.clientWidth > 0 && viewport.clientHeight > 0
            ) &&
            metrics.cssContentSize.width > 0 &&
            metrics.cssContentSize.height > 0
          )
        },
        { timeout: 10_000, message: 'Restored renderer must have a nonzero viewport' }
      )
      .toBe(true)
    return metrics
  } finally {
    await session.detach()
  }
}

try {
  for (const edition of process.env.HEXBOT_LIFECYCLE_APP ? ['client'] : ['full', 'client']) {
    const directory = process.env.HEXBOT_LIFECYCLE_APP ? desktop : await prepare(edition)
    const app = await launch(directory, edition)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await rendered(app, page)
    await expect
      .poll(() => app.evaluate(({ app }) => app.listenerCount('activate')), { timeout: 10_000 })
      .toBeGreaterThan(0)
    assert.equal(await page.evaluate(() => window.hexbot.edition), edition)
    await expect.poll(() => app.evaluate(({ Menu }) => !!Menu.getApplicationMenu())).toBe(true)
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling()
      ),
      true
    )
    // Set a sentinel in the real renderer: close/reopen must retain this page.
    await page.evaluate(() => {
      window.lifecycleSentinel = 'kept'
    })
    const windowId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
    await background(app)
    assert.equal(await page.evaluate(() => window.lifecycleSentinel), 'kept')
    await app.evaluate(({ app }) => app.emit('activate'))
    await rendered(app, page)
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id),
      windowId
    )
    // A real second process must exit and reopen the first instance.
    await background(app)
    const env = await app.evaluate(() => ({
      home: process.env.HEXBOT_HOME,
      executable: process.execPath
    }))
    const second = spawn(env.executable, launchArgs(directory), {
      env: { ...environment, HEXBOT_HOME: env.home },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    recordProcess(second, `${edition}-second`)
    const timer = setTimeout(() => second.kill(), 15_000)
    const [code, signal] = await once(second, 'close').finally(() => clearTimeout(timer))
    assert.equal(code, 0, `Second launch must hand off and exit (signal=${signal})`)
    const metrics = await rendered(app, page)
    await writeFile(join(artifacts, `${edition}-viewport.json`), JSON.stringify(metrics, null, 2))
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
    await background(app)
    await quit(app, 'menu')
    results.push({ edition, closeReopenSecondLaunchQuit: 'passed' })
    const endingApp = await launch(directory, `${edition}-session`)
    const endingProcess = processes.get(endingApp)
    const endingPage = await endingApp.firstWindow()
    await endingPage.waitForLoadState()
    await expect
      .poll(() => endingApp.evaluate(({ powerMonitor }) => powerMonitor.listenerCount('shutdown')))
      .toBeGreaterThan(0)
    const closeSession = () => endingApp.evaluate(({ BrowserWindow, powerMonitor }) => {
      const win = BrowserWindow.getAllWindows()[0]
      // Return the command acknowledgement before native close can dispose CDP.
      setImmediate(() => {
        globalThis.hexbotLifecycleTrace('session-close-request')
        if (process.platform === 'win32')
          win.emit('session-end', { preventDefault() { throw new Error('Session end vetoed') } })
        else
          powerMonitor.emit('shutdown', { preventDefault() { throw new Error('Shutdown vetoed') } })
        // before-quit is intentionally absent here. Register after production's
        // close handler and persist its actual veto result before destruction.
        win.once('close', event => globalThis.hexbotLifecycleTrace('session-window-close', {
          prevented: event.defaultPrevented
        }))
        win.close()
      })
    })
    if (process.platform === 'darwin') {
      await closeSession()
      await expect.poll(() => endingApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)
      await quit(endingApp)
    } else await requestShutdown(shutdowns.get(endingApp), closeSession)
    const shutdownEvents = (await readFile(join(artifacts, `${edition}-session-shutdown.jsonl`), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line))
    const closes = shutdownEvents.filter(event => event.event === 'session-window-close')
    assert.equal(closes.length, 1, 'One actual native session close')
    assert.equal(closes[0].prevented, false, 'OS session end must allow native close')
    assert.equal(shutdownEvents.filter(event => event.event === 'session-close-request').length, 1)
    assert.equal(shutdownEvents.filter(event => event.event === 'inspector-detach').length, 1)
    assert.equal(endingProcess.exitCode, 0)
    assert.equal(endingProcess.signalCode, null)
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
        rollupOptions: { external: ['electron', 'node:events', 'node:fs', 'node:path'] }
      }
    })
    for (const mode of ['update', 'session-end', 'tray', 'tray-absent']) {
      const app = await launch(fixture, mode, true)
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
        return { retained, opens, calls, destroyed: window.isDestroyed() }
      }, mode)
      assert(state.retained)
      assert.equal(state.opens, process.platform === 'darwin' ? 1 : 2)
      assert.equal(state.calls.stops, 1)
      assert.equal(state.calls.opens, state.opens + 1)
      assert(!state.destroyed)
      if (mode === 'tray-absent' && process.platform !== 'darwin')
        await expect
          .poll(() => app.evaluate(() => globalThis.lifecycleFixture.window.isMinimized()), {
            message: 'No tray must keep a taskbar entry'
          })
          .toBe(true)
      if (mode === 'update' || mode === 'session-end') {
        // Closing the last window starts Quit on Windows/Linux. Do not send a
        // second Tray Quit into the native shutdown already in progress.
        if (process.platform !== 'darwin') await quit(app, 'window')
        else {
          await app.evaluate(async () => {
            const { window, trace } = globalThis.lifecycleFixture
            trace('window-close-request')
            await new Promise(resolve => {
              window.once('closed', resolve)
              window.close()
            })
          })
          await quit(app, 'tray')
        }
      } else await quit(app, 'tray')
      const events = (await readFile(join(artifacts, `${mode}-events.jsonl`), 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      const named = name => events.filter(item => item.event === name)
      const closesWindow = ['update', 'session-end'].includes(mode)
      assert.equal(named('shutdown-request').length, 1, `${mode}: exactly one Quit request`)
      assert.equal(
        named('shutdown-request')[0].source,
        process.platform !== 'darwin' && closesWindow ? 'window' : 'tray'
      )
      assert.equal(named('closed').length, 1, `${mode}: native window closed`)
      // Electron omits window-all-closed when app.quit() initiates the close.
      assert.equal(
        named('window-all-closed').length,
        closesWindow ? 1 : 0,
        `${mode}: platform close policy`
      )
      assert.equal(named('before-quit').length, 1, `${mode}: one native Quit`)
      assert.equal(named('quit').length, 1, `${mode}: native Quit completed`)
      assert.equal(named('process-exit').length, 1, `${mode}: process exit recorded`)
      assert.equal(named('process-exit')[0].code, 0)
      assert.equal(named('render-process-gone').length, 0, `${mode}: renderer did not crash`)
      const finalClose = named('close').at(-1)
      assert.equal(finalClose.prevented, false, `${mode}: final close allowed`)
      assert.equal(finalClose.exiting, true, `${mode}: lifecycle permits exit`)
      assert(finalClose.sequence < named('closed')[0].sequence)
      if (closesWindow) {
        assert(named('closed')[0].sequence < named('window-all-closed')[0].sequence)
        assert(named('window-all-closed')[0].sequence < named('before-quit')[0].sequence)
      } else assert(named('before-quit')[0].sequence < finalClose.sequence)
      if (mode === 'session-end') {
        assert.equal(named('session-end').length, 1)
        assert(named('session-end')[0].sequence < finalClose.sequence)
      }
      results.push({ fixture: mode, passed: true })
    }
  }
  await writeFile(
    join(artifacts, 'results.json'),
    JSON.stringify({ platform: process.platform, results }, null, 2)
  )
  console.log(JSON.stringify({ platform: process.platform, results, artifacts }, null, 2))
} catch (error) {
  console.error(error)
  await writeFile(join(artifacts, 'failure.txt'), String(error.stack || error)).catch(console.error)
  throw error
} finally {
  if (currentApp && currentProcess.exitCode === null && currentProcess.signalCode === null) {
    appendFileSync(join(artifacts, 'cleanup.jsonl'), JSON.stringify({
      time: Date.now(), pid: currentProcess.pid, shutdownAlreadyRequested: shutdowns.get(currentApp)?.requested
    }) + '\n')
    if (shutdowns.get(currentApp)?.requested) {
      // Preserve the failed exit gate. Never issue another Quit into a native
      // shutdown already in progress, including a debugger disconnect failure.
      currentProcess.kill()
    } else await quit(currentApp, 'cleanup').catch(error => {
      console.error('Lifecycle cleanup:', error)
      if (currentProcess.exitCode === null && currentProcess.signalCode === null) currentProcess.kill()
    })
  }
  await rm(root, { recursive: true, force: true }).catch(console.error)
}
