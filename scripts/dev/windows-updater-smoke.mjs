// Run real installed Full and Client packages through their signed NSIS updater.
// Input: {full,client,next/full,next/client} packages and versions.json from CI.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

assert.equal(process.platform, 'win32', 'This smoke requires a disposable Windows VM')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { _electron: electron, expect } = require('@playwright/test')
const run = promisify(execFile)
const packages = resolve(process.argv[2] || 'windows-packages')
const versions = JSON.parse(await readFile(join(packages, 'versions.json'), 'utf8'))
for (const version of [versions.current, versions.next])
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
assert.notEqual(versions.current, versions.next)
const artifacts = process.env.HEXBOT_SMOKE_ARTIFACTS || join(packages, 'evidence')
await mkdir(artifacts, { recursive: true })

async function installedVersion(directory) {
  // Read the package actually replaced by NSIS, independently of updater state.
  const bytes = await readFile(join(directory, 'resources/app.asar'))
  assert(bytes.length >= 16, 'Installed ASAR header is incomplete')
  const headerSize = bytes.readUInt32LE(4)
  const jsonSize = bytes.readUInt32LE(12)
  assert(headerSize >= 8 && jsonSize <= headerSize - 8 && headerSize + 8 <= bytes.length)
  const header = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString('utf8'))
  const file = header.files['package.json']
  assert(file && !file.unpacked && !file.link, 'Installed ASAR must contain package.json')
  const offset = Number(file.offset) + 8 + headerSize
  assert(Number.isSafeInteger(offset) && offset >= headerSize + 8 && offset + file.size <= bytes.length)
  return JSON.parse(bytes.subarray(offset, offset + file.size).toString('utf8')).version
}

async function command(executable, args, env) {
  return run(executable, args, { env, timeout: 180_000, windowsHide: true,
    // NSIS consumes the final /D value verbatim, including spaces.
    windowsVerbatimArguments: args.some(arg => arg.startsWith('/D=')), maxBuffer: 8 * 1024 * 1024 })
}

async function ownedApplications(executable, env) {
  // Every match is inside this test's unique temporary installation directory.
  // Discover the updater's relaunched PIDs, then terminate only those exact PIDs.
  const result = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$items = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ceq $env:HEXBOT_TEST_APP_EXECUTABLE } | Select-Object ProcessId, ParentProcessId); ConvertTo-Json -InputObject $items -Compress'
  ], { ...env, HEXBOT_TEST_APP_EXECUTABLE: executable })
  return JSON.parse(result.stdout.trim() || '[]')
}

async function stopOwnedApplications(executable, env) {
  const items = await ownedApplications(executable, env)
  const ids = new Set(items.map(item => item.ProcessId))
  for (const item of items.filter(item => !ids.has(item.ParentProcessId)))
    await command('taskkill.exe', ['/PID', String(item.ProcessId), '/T', '/F'], env).catch(error => {
      if (!/not found|no running instance/i.test(`${error.stdout}\n${error.stderr}`)) throw error
    })
  return items
}

async function exercise(edition) {
  const prefix = edition === 'client' ? 'HexbotClient' : 'Hexbot'
  const appId = edition === 'client' ? 'app.hexbot.client' : 'app.hexbot.desktop'
  const currentName = `${prefix}-${versions.current}-win-x64.exe`
  const nextName = `${prefix}-${versions.next}-win-x64.exe`
  const current = join(packages, edition, currentName)
  const next = join(packages, 'next', edition, nextName)
  await Promise.all([access(current), access(next)])
  const temporary = await mkdtemp(join(tmpdir(), `Hexbot Windows update ${edition} Ω `))
  const directory = join(temporary, 'Programs', appId)
  const executable = join(directory, 'Hexbot.exe')
  const home = join(temporary, 'home')
  const user = join(temporary, 'user')
  const env = { ...process.env, HEXBOT_HOME: home, HEXBOT_SERVICE_ROOT: join(temporary, 'services'),
    USERPROFILE: user, HOME: user, LOCALAPPDATA: join(user, 'AppData/Local'), APPDATA: join(user, 'AppData/Roaming') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.HEXBOT_PI_EXECUTABLE
  delete env.HEXBOT_PI_SCRIPT
  await Promise.all([mkdir(home, { recursive: true }), mkdir(user, { recursive: true }), mkdir(env.LOCALAPPDATA, { recursive: true })])
  const sentinel = join(home, 'keep-user-data.txt')
  await writeFile(sentinel, 'Preserved through the signed app update.')
  const files = new Map([[currentName, current], [nextName, next]])
  for (const path of [current, next]) {
    const blockmap = `${path}.blockmap`
    if (await access(blockmap).then(() => true, () => false)) files.set(basename(blockmap), blockmap)
  }
  const payload = await readFile(next)
  const sha512 = createHash('sha512').update(payload).digest('base64')
  const feed = `version: ${versions.next}\nfiles:\n  - url: ${nextName}\n    sha512: ${sha512}\n    size: ${payload.length}\npath: ${nextName}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`
  const requests = []
  const log = { edition, current: versions.current, next: versions.next, temporary, requests, errors: [], launches: [] }
  const server = http.createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).slice(1)
      requests.push({ method: request.method, path, range: request.headers.range })
      if (path === 'latest.yml') { response.writeHead(200, { 'content-type': 'text/yaml' }).end(feed); return }
      const file = files.get(path)
      if (!file || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404).end(); return }
      const size = (await stat(file)).size
      // Differential requests can fall back to the complete signed payload.
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size })
      if (request.method === 'HEAD') response.end()
      else createReadStream(file).on('error', error => response.destroy(error)).pipe(response)
    } catch { response.writeHead(404).end() }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  let application
  let installed = false

  async function launch(version) {
    application = await electron.launch({ executablePath: executable, env, timeout: 60_000 })
    const appLog = { version, stdout: '', stderr: '' }
    log.launches.push(appLog)
    application.process().stdout?.on('data', data => { appLog.stdout += data })
    application.process().stderr?.on('data', data => { appLog.stderr += data })
    const page = await application.firstWindow({ timeout: 60_000 })
    page.on('pageerror', error => log.errors.push(error.message))
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.hexbot?.updater))
    const identity = await application.evaluate(({ app }, feedUrl) => {
      // The Playwright evaluation context has no dynamic-import callback.
      const createRequire = process.getBuiltinModule('module').createRequire
      const { autoUpdater } = createRequire(`${app.getAppPath()}/package.json`)('electron-updater')
      autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
      autoUpdater.autoDownload = false
      return { version: app.getVersion(), packaged: app.isPackaged, appPath: app.getAppPath() }
    }, url)
    assert.equal(identity.version, version)
    assert.equal(identity.packaged, true)
    assert.equal(await page.evaluate(() => window.hexbot.edition), edition)
    assert.equal(await page.evaluate(() => window.hexbot.platform), 'win32')
    assert.equal((await page.evaluate(() => window.hexbot.updater.state())).currentVersion, version)
    const config = await readFile(join(directory, 'resources/app-update.yml'), 'utf8')
    assert.match(config, /^publisherName:/m, 'The installed updater must retain its signing identity')
    await page.screenshot({ path: join(artifacts, `${edition}-${version}-installed.png`), fullPage: true })
    return page
  }

  try {
    await command(current, ['/S', `/D=${directory}`], env)
    installed = true
    assert.equal(await installedVersion(directory), versions.current)
    let page = await launch(versions.current)
    if (edition === 'client') {
      const error = await page.evaluate(async () => {
        try { await window.hexbot.daemon.start(); return '' } catch (error) { return error.message }
      })
      assert.match(error, /client-only/)
    } else {
      const status = await page.evaluate(() => window.hexbot.daemon.start())
      assert.equal(status.state, 'running', JSON.stringify(status))
      await page.evaluate(() => window.hexbot.daemon.stop())
    }
    log.available = await page.evaluate(() => window.hexbot.updater.check())
    assert.equal(log.available.status, 'available', JSON.stringify(log.available))
    assert.equal(log.available.availableVersion, versions.next)
    log.downloaded = await page.evaluate(() => window.hexbot.updater.download())
    assert.equal(log.downloaded.status, 'downloaded', JSON.stringify(log.downloaded))
    const closed = application.waitForEvent('close', { timeout: 60_000 })
    await page.evaluate(() => window.hexbot.updater.install()).catch(error => {
      if (!/closed|destroyed/i.test(error.message)) throw error
    })
    await closed
    application = undefined
    await expect.poll(async () => installedVersion(directory).catch(() => null), { timeout: 180_000 }).toBe(versions.next)
    await expect.poll(async () => (await ownedApplications(executable, env)).length, { timeout: 60_000 }).toBeGreaterThan(0)
    log.relaunched = await stopOwnedApplications(executable, env)
    page = await launch(versions.next)
    assert.equal(await readFile(sentinel, 'utf8'), 'Preserved through the signed app update.')
    assert.equal(log.errors.length, 0, log.errors.join('\n'))
    assert(requests.some(request => request.path === nextName), 'The actual next-version installer was downloaded')
    await application.close()
    application = undefined
    await command(join(directory, 'Uninstall Hexbot.exe'), ['/S'], env)
    await expect.poll(() => access(executable).then(() => true, () => false), { timeout: 60_000 }).toBe(false)
    assert.equal(await readFile(sentinel, 'utf8'), 'Preserved through the signed app update.')
    installed = false
    log.passed = true
    console.log(JSON.stringify({ edition, passed: true, current: versions.current, next: versions.next, signatures: 'verified by the installed NSIS updater' }))
  } finally {
    if (application) await application.close().catch(() => {})
    await stopOwnedApplications(executable, env).catch(error => log.errors.push(`Process cleanup: ${error.message}`))
    if (installed) await command(join(directory, 'Uninstall Hexbot.exe'), ['/S'], env).catch(error => log.errors.push(`Uninstall cleanup: ${error.message}`))
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await writeFile(join(artifacts, `${edition}-updater.json`), `${JSON.stringify(log, null, 2)}\n`)
    if (log.passed) await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
}

for (const edition of ['full', 'client']) await exercise(edition)
