// Exercise signed NSIS updates in a disposable Windows VM, including both tracks.
// Input: {full,client,next/{full,client},nightly/{full,client}} and versions.json.
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
for (const version of [versions.current, versions.next, versions.nightly])
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
assert.equal(new Set([versions.current, versions.next, versions.nightly]).size, 3)
assert.match(versions.nightly, /-nightly\./)
const artifacts = process.env.HEXBOT_SMOKE_ARTIFACTS || join(packages, 'evidence')
await mkdir(artifacts, { recursive: true })
const pathKey = path => resolve(path).toLowerCase()
const present = path => access(path).then(() => true, () => false)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function updateFeed(version, filename, payload) {
  const hash = createHash('sha512').update(payload).digest('base64')
  return `version: ${version}\nfiles:\n  - url: ${filename}\n    sha512: ${hash}\n    size: ${payload.length}\npath: ${filename}\nsha512: ${hash}\nreleaseDate: '${new Date().toISOString()}'\n`
}

function tamperedInstaller(bytes) {
  assert(bytes.length > 0x44 && bytes.subarray(0, 2).toString() === 'MZ', 'The signing fixture must be a Windows executable')
  const header = bytes.readUInt32LE(0x3c)
  assert(header > 0x40 && header + 4 <= bytes.length, 'The signing fixture must have an unused DOS stub byte')
  assert(bytes.subarray(header, header + 4).equals(Buffer.from([0x50, 0x45, 0, 0])), 'The signing fixture must retain its PE header')
  // Windows loads the PE image directly. This DOS stub byte participates in
  // the Authenticode hash and leaves the PE headers and executable code intact.
  const changed = Buffer.from(bytes)
  changed[0x40] ^= 1
  return changed
}

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
  if (executable === 'pwsh.exe') {
    const script = args.indexOf('-Command') + 1
    args = [...args]
    args[script] = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ${args[script]}`
  }
  return run(executable, args, { env, timeout: 180_000, windowsHide: true,
    // NSIS consumes the final /D value verbatim, including spaces.
    windowsVerbatimArguments: args.some(arg => arg.startsWith('/D=')), maxBuffer: 8 * 1024 * 1024 })
}

async function ownedApplications(executable, env) {
  // The executable is inside this test's unique temporary installation directory.
  const result = await command('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$items = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ieq $env:HEXBOT_TEST_APP_EXECUTABLE } | Select-Object ProcessId, ParentProcessId); ConvertTo-Json -InputObject $items -Compress'
  ], { ...env, HEXBOT_TEST_APP_EXECUTABLE: executable })
  return JSON.parse(result.stdout.trim() || '[]')
}

async function stopOwnedApplications(executable, env) {
  const items = await ownedApplications(executable, env)
  const ids = new Set(items.map(item => item.ProcessId))
  for (const item of items.filter(item => !ids.has(item.ParentProcessId)))
    await command('taskkill.exe', ['/PID', String(item.ProcessId), '/T', '/F'], env).catch(async error => {
      if ((await ownedApplications(executable, env)).some(live => live.ProcessId === item.ProcessId)) throw error
    })
  return items
}

async function registrations(installations, temporary, env) {
  const result = await command('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$ids = ConvertFrom-Json $env:HEXBOT_TEST_INSTALL_IDS
$items = @{}
foreach ($id in $ids) {
  $installPath = 'Registry::HKEY_CURRENT_USER\\Software\\' + $id
  $uninstallPath = 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + $id
  $install = Get-ItemProperty -LiteralPath $installPath -ErrorAction SilentlyContinue
  $uninstall = Get-ItemProperty -LiteralPath $uninstallPath -ErrorAction SilentlyContinue
  $items[$id] = @{
    installed = ($null -ne $install); location = $install.InstallLocation; shortcut = $install.ShortcutName
    uninstaller = ($null -ne $uninstall); command = $uninstall.UninstallString
    quiet = $uninstall.QuietUninstallString; version = $uninstall.DisplayVersion
  }
}
$owned = @()
foreach ($container in @('Registry::HKEY_CURRENT_USER\\Software', 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) {
  foreach ($key in Get-ChildItem -LiteralPath $container -ErrorAction SilentlyContinue) {
    $values = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
    $location = $values.InstallLocation
    $uninstall = $values.UninstallString
    $prefix = $env:HEXBOT_TEST_INSTALL_ROOT + '\\'
    if (($location -and $location.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) -or ($uninstall -and $uninstall.IndexOf($prefix, [StringComparison]::OrdinalIgnoreCase) -ge 0)) {
      $owned += @{ container = $container; id = $key.PSChildName; location = $location; command = $uninstall }
    }
  }
}
@{ items = $items; owned = $owned } | ConvertTo-Json -Depth 6 -Compress
`], { ...env, HEXBOT_TEST_INSTALL_IDS: JSON.stringify(installations.map(item => item.id)), HEXBOT_TEST_INSTALL_ROOT: temporary })
  return JSON.parse(result.stdout.trim())
}

async function shellFolders(env) {
  const result = await command('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "@{ desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory, [Environment+SpecialFolderOption]::DoNotVerify); programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs, [Environment+SpecialFolderOption]::DoNotVerify); localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData, [Environment+SpecialFolderOption]::DoNotVerify) } | ConvertTo-Json -Compress"
  ], env)
  const folders = JSON.parse(result.stdout.trim())
  assert(folders.desktop && folders.programs && folders.localAppData, 'Windows shell folders must be available')
  return { shortcuts: [folders.desktop, folders.programs], localAppData: folders.localAppData }
}

async function configuration(installation) {
  const bytes = await readFile(join(installation.directory, 'hexbot-install.ini'))
  const ini = bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8').replace(/^\uFEFF/, '')
  const section = ini.split(/^\[installation\]\s*$/im)[1]?.split(/^\[/m)[0]
  assert(section, 'The installed identity marker must contain [installation]')
  assert.deepEqual([...section.matchAll(/^appId\s*=\s*(\S+)\s*$/gim)].map(match => match[1]), [installation.id])
  const update = await readFile(join(installation.directory, 'resources/app-update.yml'), 'utf8')
  const cache = update.match(/^updaterCacheDirName:\s*([^\r\n]+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  assert.equal(cache, `${installation.id}-updater`)
  const publisher = update.match(/^publisherName:[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/m)?.[0]
  assert(publisher, 'The installed updater must retain its signing identity')
  return { ini, update, cache, publisher }
}

async function fingerprint(installation) {
  const hashes = {}
  for (const file of ['Hexbot.exe', 'Uninstall Hexbot.exe', 'hexbot-install.ini', 'resources/app.asar', 'resources/app-update.yml'])
    hashes[file] = sha256(await readFile(join(installation.directory, file)))
  return hashes
}

async function shortcuts(application, folders) {
  return application.evaluate(({ shell }, roots) => {
    const fs = process.getBuiltinModule('fs')
    const path = process.getBuiltinModule('path')
    const links = []
    const visit = (directory, depth = 0) => {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, item.name)
        if (item.isDirectory() && depth < 2) { visit(file, depth + 1); continue }
        if (!item.isFile() || !/^Hexbot.*\.lnk$/i.test(item.name)) continue
        const details = shell.readShortcutLink(file)
        links.push({ file, target: details.target, appUserModelId: details.appUserModelId,
          sha256: process.getBuiltinModule('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex') })
      }
    }
    for (const directory of roots) visit(directory)
    return links.sort((left, right) => left.file.localeCompare(right.file))
  }, folders)
}

async function exercise(edition) {
  const prefix = edition === 'client' ? 'HexbotClient' : 'Hexbot'
  const id = edition === 'client' ? 'app.hexbot.client' : 'app.hexbot.desktop'
  const temporary = await mkdtemp(join(tmpdir(), `Hexbot Windows update ${edition} Ω ' `))
  const user = join(temporary, 'user')
  const baseEnv = { ...process.env, HEXBOT_SERVICE_ROOT: join(temporary, 'services'),
    USERPROFILE: user, HOME: user, LOCALAPPDATA: join(user, 'AppData/Local'), APPDATA: join(user, 'AppData/Roaming') }
  delete baseEnv.ELECTRON_RUN_AS_NODE
  delete baseEnv.HEXBOT_PI_EXECUTABLE
  delete baseEnv.HEXBOT_PI_SCRIPT
  await Promise.all([mkdir(user, { recursive: true }), mkdir(baseEnv.LOCALAPPDATA, { recursive: true })])
  const installation = (id, label) => {
    const directory = join(temporary, 'Programs', id)
    const home = join(temporary, `${label} home`)
    return { id, directory, home, executable: join(directory, 'Hexbot.exe'), env: { ...baseEnv, HEXBOT_HOME: home } }
  }
  const primary = installation(id, 'stable')
  const secondary = installation(`${id}.nightly`, 'nightly')
  const installations = [primary, secondary]
  for (const item of installations) {
    await mkdir(item.home, { recursive: true })
    await writeFile(join(item.home, 'keep-user-data.txt'), `Keep ${item.id}`)
  }
  const names = Object.fromEntries(Object.entries(versions).filter(([kind]) => ['current', 'next', 'nightly'].includes(kind)).map(([kind, version]) => [kind, `${prefix}-${version}-win-x64.exe`]))
  const binaries = { current: join(packages, edition, names.current), next: join(packages, 'next', edition, names.next), nightly: join(packages, 'nightly', edition, names.nightly) }
  await Promise.all(Object.values(binaries).map(path => access(path)))
  const files = new Map()
  const feeds = {}
  for (const kind of ['current', 'next', 'nightly']) {
    files.set(names[kind], binaries[kind])
    if (await present(`${binaries[kind]}.blockmap`)) files.set(`${names[kind]}.blockmap`, `${binaries[kind]}.blockmap`)
    if (kind === 'current') continue
    const payload = await readFile(binaries[kind])
    feeds[kind === 'nightly' ? 'nightly.yml' : 'latest.yml'] = updateFeed(versions[kind], names[kind], payload)
  }
  const requests = []
  const log = { edition, versions, temporary, requests, errors: [], launches: [], steps: [] }
  const server = http.createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).slice(1)
      requests.push({ method: request.method, path, range: request.headers.range })
      if (feeds[path]) { response.writeHead(200, { 'content-type': 'text/yaml' }).end(feeds[path]); return }
      const file = files.get(path)
      if (!file || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404).end(); return }
      const size = (await stat(file)).size
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size })
      if (request.method === 'HEAD') response.end()
      else createReadStream(file).on('error', error => response.destroy(error)).pipe(response)
    } catch { if (!response.headersSent) response.writeHead(404); response.end() }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  let folders
  let installerCache
  let application
  let secondaryApplication
  let secondaryPid
  let secondarySnapshot
  let secondaryCacheSnapshot
  let secondaryRegistration
  let secondaryShortcuts
  let primaryShortcuts
  let primaryShortcutName
  let publisher

  async function launch(item, version, label) {
    application = await electron.launch({ executablePath: item.executable, env: item.env, timeout: 60_000 })
    const appLog = { id: item.id, version, label, stdout: '', stderr: '' }
    log.launches.push(appLog)
    application.process().stdout?.on('data', data => { appLog.stdout += data })
    application.process().stderr?.on('data', data => { appLog.stderr += data })
    const page = await application.firstWindow({ timeout: 60_000 })
    page.on('pageerror', error => log.errors.push(error.message))
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.hexbot?.updater))
    const identity = await application.evaluate(({ app }, feedUrl) => {
      const createRequire = process.getBuiltinModule('module').createRequire
      const { autoUpdater } = createRequire(`${app.getAppPath()}/package.json`)('electron-updater')
      autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
      autoUpdater.autoDownload = false
      return { version: app.getVersion(), packaged: app.isPackaged, executable: app.getPath('exe'),
        verifiesSignatures: typeof autoUpdater.verifyUpdateCodeSignature === 'function' }
    }, url)
    assert.equal(identity.version, version)
    assert.equal(identity.packaged, true)
    assert.equal(pathKey(identity.executable), pathKey(item.executable))
    assert.equal(identity.verifiesSignatures, true, 'Update signature verification must remain enabled')
    assert.equal(await page.evaluate(() => window.hexbot.edition), edition)
    assert.equal(await page.evaluate(() => window.hexbot.platform), 'win32')
    assert.equal((await page.evaluate(() => window.hexbot.updater.state())).currentVersion, version)
    const config = await configuration(item)
    if (publisher) assert.equal(config.publisher, publisher)
    else publisher = config.publisher
    await page.screenshot({ path: join(artifacts, `${edition}-${label}-${version}.png`), fullPage: true })
    return page
  }

  async function nightlyCache() {
    const cache = {}
    for (const root of new Set([baseEnv.LOCALAPPDATA, installerCache])) {
      const file = join(root, `${secondary.id}-updater`, 'installer.exe')
      if (await present(file)) cache[file] = sha256(await readFile(file))
    }
    assert(Object.keys(cache).length, 'The independent Nightly installer cache is missing')
    return cache
  }

  async function unchangedNightly() {
    assert((await ownedApplications(secondary.executable, secondary.env)).some(item => item.ProcessId === secondaryPid), 'The running independent Nightly process was stopped')
    const running = await secondaryApplication.evaluate(({ app }) => ({ version: app.getVersion(), home: process.env.HEXBOT_HOME, userData: app.getPath('userData') }))
    assert.equal(running.version, versions.nightly)
    assert.equal(pathKey(running.home), pathKey(secondary.home))
    assert.equal(pathKey(running.userData), pathKey(join(secondary.home, 'desktop-data')))
    assert.deepEqual(await fingerprint(secondary), secondarySnapshot, 'The independent Nightly installation changed')
    assert.deepEqual(await nightlyCache(), secondaryCacheSnapshot, 'The independent Nightly installer cache changed')
    assert.equal(await installedVersion(secondary.directory), versions.nightly)
    const registry = await registrations(installations, temporary, baseEnv)
    assert.deepEqual(registry.items[secondary.id], secondaryRegistration, 'The independent Nightly registration changed')
    return registry
  }

  async function verifyPrimary(version) {
    assert.equal(await installedVersion(primary.directory), version)
    await configuration(primary)
    const registry = await unchangedNightly()
    const item = registry.items[primary.id]
    assert.equal(item.installed, true)
    assert.equal(item.uninstaller, true)
    assert.equal(pathKey(item.location), pathKey(primary.directory))
    assert.equal(item.shortcut, primaryShortcutName)
    assert.equal(item.version, version)
    const uninstaller = join(primary.directory, 'Uninstall Hexbot.exe').toLowerCase()
    assert(item.command.toLowerCase().includes(uninstaller))
    assert(item.quiet.toLowerCase().includes(uninstaller))
    assert.equal(registry.owned.length, 4, 'An update created or removed another installation identity')
    assert.deepEqual([...new Set(registry.owned.map(item => item.id))].sort(), installations.map(item => item.id).sort())
    const links = await shortcuts(application, folders)
    for (const link of [...primaryShortcuts, ...secondaryShortcuts]) {
      const actual = links.find(item => pathKey(item.file) === pathKey(link.file))
      assert(actual, `Shortcut disappeared: ${link.file}`)
      assert.equal(pathKey(actual.target), pathKey(link.target))
      assert.equal(actual.appUserModelId, link.appUserModelId)
      if (link.appUserModelId === secondary.id) assert.equal(actual.sha256, link.sha256)
    }
    assert.deepEqual(links.filter(link => pathKey(link.target) === pathKey(primary.executable)).map(link => pathKey(link.file)).sort(), primaryShortcuts.map(link => pathKey(link.file)).sort())
    for (const item of installations) assert.equal(await readFile(join(item.home, 'keep-user-data.txt'), 'utf8'), `Keep ${item.id}`)
    return registry
  }

  async function rejectTamperedUpdate(page) {
    const original = await readFile(binaries.next)
    const payload = tamperedInstaller(original)
    const filename = `${prefix}-${versions.next}-tampered-win-x64.exe`
    const file = join(temporary, filename)
    await writeFile(file, payload)
    const before = await fingerprint(primary)
    const validFeed = feeds['latest.yml']
    const proof = {
      filename, version: versions.next, modifiedOffset: 0x40, peHeaderOffset: payload.readUInt32LE(0x3c),
      bytes: payload.length, originalSha512: createHash('sha512').update(original).digest('base64'),
      feedSha512: createHash('sha512').update(payload).digest('base64')
    }
    log.invalidSignature = proof
    assert.notEqual(proof.originalSha512, proof.feedSha512)
    // Finish any startup check before replacing its feed. The next check and
    // download must use the modified payload and its correct SHA-512 digest.
    await page.evaluate(() => window.hexbot.updater.check())
    const start = requests.length
    files.set(filename, file)
    feeds['latest.yml'] = updateFeed(versions.next, filename, payload)
    try {
      proof.available = await page.evaluate(() => window.hexbot.updater.check())
      assert.equal(proof.available.status, 'available', JSON.stringify(proof.available))
      assert.equal(proof.available.availableVersion, versions.next)
      proof.rejected = await page.evaluate(() => window.hexbot.updater.download())
      assert.equal(proof.rejected.status, 'error', 'The installed updater accepted a modified Authenticode payload')
      assert.equal(proof.rejected.errorContext, 'download')
      assert.match(proof.rejected.message, /not signed by the application owner/i)
      assert.equal(proof.rejected.downloadedVersion, null)
      assert(requests.slice(start).some(request => request.method === 'GET' && request.path === filename), 'The modified installer was not downloaded')
      assert.equal(await installedVersion(primary.directory), versions.current)
      assert.deepEqual(await fingerprint(primary), before, 'A rejected installer changed the installed app')
      await verifyPrimary(versions.current)
      proof.passed = true
    } finally {
      feeds['latest.yml'] = validFeed
      files.delete(filename)
    }
    // The ordinary check/download flow below must recover without deleting
    // updater caches or changing its verifier after the rejected download.
  }

  async function update(page, channel, kind) {
    const step = { channel, version: versions[kind] }
    log.steps.push(step)
    await page.evaluate(channel => window.hexbot.updater.setChannel(channel), channel)
    step.available = await page.evaluate(() => window.hexbot.updater.check())
    assert.equal(step.available.status, 'available', JSON.stringify(step.available))
    assert.equal(step.available.availableVersion, versions[kind])
    step.downloaded = await page.evaluate(() => window.hexbot.updater.download())
    assert.equal(step.downloaded.status, 'downloaded', JSON.stringify(step.downloaded))
    step.cache = await application.evaluate(({ app }) => {
      const createRequire = process.getBuiltinModule('module').createRequire
      return createRequire(`${app.getAppPath()}/package.json`)('electron-updater').autoUpdater.downloadedUpdateHelper?.cacheDir
    })
    assert.equal(basename(step.cache), `${primary.id}-updater`)
    const closed = application.waitForEvent('close', { timeout: 60_000 })
    await page.evaluate(() => window.hexbot.updater.install()).catch(error => {
      if (!/closed|destroyed/i.test(error.message)) throw error
    })
    await closed
    application = undefined
    await expect.poll(() => installedVersion(primary.directory).catch(() => null), { timeout: 180_000 }).toBe(versions[kind])
    await expect.poll(async () => (await ownedApplications(primary.executable, primary.env)).length, { timeout: 60_000 }).toBeGreaterThan(0)
    step.relaunched = await stopOwnedApplications(primary.executable, primary.env)
    const nextPage = await launch(primary, versions[kind], `${log.steps.length}-${channel}`)
    step.registry = await verifyPrimary(versions[kind])
    return nextPage
  }

  async function uninstall(item) {
    await stopOwnedApplications(item.executable, item.env)
    const uninstaller = join(item.directory, 'Uninstall Hexbot.exe')
    if (await present(uninstaller)) await command(uninstaller, ['/S'], item.env)
    await expect.poll(() => present(item.executable), { timeout: 60_000 }).toBe(false)
    await expect.poll(async () => {
      const state = (await registrations(installations, temporary, baseEnv)).items[item.id]
      return state.installed || state.uninstaller
    }, { timeout: 60_000 }).toBe(false)
  }

  try {
    const locations = await shellFolders(baseEnv)
    folders = locations.shortcuts
    installerCache = locations.localAppData
    const prior = await registrations(installations, temporary, baseEnv)
    for (const item of installations) assert(!prior.items[item.id].installed && !prior.items[item.id].uninstaller, `The disposable VM already has ${item.id} installed`)
    // The other track already exists when the Stable installation first updates.
    await command(binaries.nightly, ['/S', `/D=${secondary.directory}`], secondary.env)
    await launch(secondary, versions.nightly, 'initial-nightly')
    await configuration(secondary)
    secondarySnapshot = await fingerprint(secondary)
    secondaryCacheSnapshot = await nightlyCache()
    log.independentNightlyCache = secondaryCacheSnapshot
    secondaryRegistration = (await registrations(installations, temporary, baseEnv)).items[secondary.id]
    secondaryApplication = application
    secondaryPid = application.process().pid
    log.independentNightlyPid = secondaryPid
    application = undefined
    await command(binaries.current, ['/S', `/D=${primary.directory}`], primary.env)
    let page = await launch(primary, versions.current, 'initial-stable')
    const links = await shortcuts(application, folders)
    primaryShortcuts = links.filter(link => pathKey(link.target) === pathKey(primary.executable))
    secondaryShortcuts = links.filter(link => pathKey(link.target) === pathKey(secondary.executable))
    for (const item of installations) {
      const owned = links.filter(link => pathKey(link.target) === pathKey(item.executable))
      for (const folder of folders) assert(owned.some(link => pathKey(link.file).startsWith(`${pathKey(folder)}\\`)), `Missing shortcut for ${item.id} in ${folder}`)
      for (const link of owned) assert.equal(link.appUserModelId, item.id)
    }
    primaryShortcutName = (await registrations(installations, temporary, baseEnv)).items[primary.id].shortcut
    assert(primaryShortcutName)
    await verifyPrimary(versions.current)
    if (edition === 'client') {
      const error = await page.evaluate(async () => {
        try { await window.hexbot.daemon.start(); return '' } catch (error) { return error.message }
      })
      assert.match(error, /client-only/)
    } else {
      const status = await page.evaluate(() => window.hexbot.daemon.start())
      assert.notEqual(status.state, 'crashed', JSON.stringify(status))
      await expect.poll(() => page.evaluate(() => window.hexbot.daemon.status()), { timeout: 60_000 }).toMatchObject({ state: 'running' })
      await page.evaluate(() => window.hexbot.daemon.stop())
    }
    await rejectTamperedUpdate(page)
    page = await update(page, 'stable', 'next')
    page = await update(page, 'nightly', 'nightly')
    await update(page, 'stable', 'next')
    for (const name of [names.next, names.nightly])
      assert(requests.some(request => request.path === name), `The actual signed installer was not downloaded: ${name}`)
    assert.equal(log.errors.length, 0, log.errors.join('\n'))
    await application.close()
    application = undefined
    await uninstall(primary)
    await unchangedNightly()
    await secondaryApplication.close()
    secondaryApplication = undefined
    await launch(secondary, versions.nightly, 'final-independent-nightly')
    assert.deepEqual(await fingerprint(secondary), secondarySnapshot)
    const remaining = await shortcuts(application, folders)
    for (const link of primaryShortcuts) assert(!remaining.some(item => pathKey(item.file) === pathKey(link.file)))
    for (const link of secondaryShortcuts) assert(remaining.some(item => pathKey(item.file) === pathKey(link.file) && item.appUserModelId === secondary.id))
    await application.close()
    application = undefined
    await uninstall(secondary)
    for (const link of [...primaryShortcuts, ...secondaryShortcuts]) assert.equal(await present(link.file), false)
    assert.equal((await registrations(installations, temporary, baseEnv)).owned.length, 0)
    assert.equal(log.errors.length, 0, log.errors.join('\n'))
    for (const item of installations) assert.equal(await readFile(join(item.home, 'keep-user-data.txt'), 'utf8'), `Keep ${item.id}`)
    log.passed = true
    console.log(JSON.stringify({ edition, passed: true, versions, tracks: ['stable', 'nightly', 'stable'], independentNightlyPreserved: true, signatures: 'verified by the installed NSIS updater' }))
  } catch (error) {
    log.failure = error.stack || error.message
    throw error
  } finally {
    if (application) await application.close().catch(error => log.errors.push(`App cleanup: ${error.message}`))
    if (secondaryApplication) await secondaryApplication.close().catch(error => log.errors.push(`Nightly app cleanup: ${error.message}`))
    for (const item of installations) {
      await stopOwnedApplications(item.executable, item.env).catch(error => log.errors.push(`Process cleanup ${item.id}: ${error.message}`))
      if (await present(join(item.directory, 'Uninstall Hexbot.exe')))
        await uninstall(item).catch(error => log.errors.push(`Uninstall cleanup ${item.id}: ${error.message}`))
    }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await writeFile(join(artifacts, `${edition}-updater.json`), `${JSON.stringify(log, null, 2)}\n`)
    if (log.passed) await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
}

for (const edition of ['full', 'client']) await exercise(edition)
