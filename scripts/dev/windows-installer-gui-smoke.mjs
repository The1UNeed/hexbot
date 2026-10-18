// Launch the exact signed Tauri NSIS download, then inspect its installed WebView2 UI.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { join } from 'node:path'

export async function verifyWindowsInstallerGui(wrapper, { root, directory, env, artifacts, command, log }) {
  const require = createRequire(join(root, 'apps/desktop/package.json'))
  const { chromium, expect } = require('@playwright/test')
  const record = { wrapper, directory, errors: [], stdout: '', stderr: '' }
  log.push({ gui: record })
  const runtimeQuery = '$roots = @("Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients", "Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients", "Registry::HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients"); $items = @(foreach ($root in $roots) { Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.name -like "*WebView2*" } | Select-Object name, pv, PSPath }); ConvertTo-Json -InputObject $items -Compress'
  const runtimes = async () => JSON.parse((await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', runtimeQuery])).stdout.trim() || '[]')
  const signature = async file => {
    const result = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-AuthenticodeSignature -LiteralPath $env:HEXBOT_TEST_SIGNED_FILE).Status.ToString()'], 180_000, { env: { ...env, HEXBOT_TEST_SIGNED_FILE: file } })
    assert.equal(result.stdout.trim(), 'Valid', `The exact GUI download must have a trusted Authenticode signature: ${file}`)
  }
  record.webviewBefore = await runtimes()
  await signature(wrapper)
  let installed = false, child, browser
  try {
    installed = true
    await command(wrapper, ['/S', `/D=${directory}`], 300_000, { windowsVerbatimArguments: true })
    const executable = join(directory, 'hexbot-installer-app.exe')
    await access(executable)
    await signature(executable)
    record.webviewAfter = await runtimes()
    record.webviewBootstrap = record.webviewBefore.length ? 'Runtime already installed in this VM' : 'NSIS provisioned the previously absent runtime'
    assert(record.webviewAfter.length, 'The GUI installer must leave WebView2 installed')
    const listener = net.createServer()
    listener.listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const port = listener.address().port
    await new Promise(resolve => listener.close(resolve))
    const guiEnv = { ...env, WEBVIEW2_USER_DATA_FOLDER: join(directory, 'test-webview-profile'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }
    await mkdir(guiEnv.WEBVIEW2_USER_DATA_FOLDER, { recursive: true })
    child = spawn(executable, [], { env: guiEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
    let launchError
    child.once('error', error => { launchError = error })
    child.stdout.on('data', bytes => { record.stdout += bytes })
    child.stderr.on('data', bytes => { record.stderr += bytes })
    const endpoint = `http://127.0.0.1:${port}`
    await expect.poll(async () => {
      if (launchError) throw launchError
      assert.equal(child.exitCode, null, `Installed GUI exited early: ${record.stderr}`)
      return fetch(`${endpoint}/json/version`).then(response => response.ok, () => false)
    }, { timeout: 60_000 }).toBe(true)
    browser = await chromium.connectOverCDP(endpoint)
    let page
    await expect.poll(() => {
      page = browser.contexts().flatMap(context => context.pages()).find(page => /tauri\.localhost|tauri:\/\//.test(page.url()))
      return Boolean(page)
    }, { timeout: 30_000 }).toBe(true)
    page.on('pageerror', error => record.errors.push(error.message))
    await expect(page.getByRole('heading', { name: 'Welcome to Hexbot', exact: true })).toBeVisible()
    const detection = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('detect'))
    assert.equal(detection.target, 'windows-x86_64', JSON.stringify(detection))
    record.detection = detection
    const session = await browser.newBrowserCDPSession()
    record.browser = await session.send('Browser.getVersion')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    for (const option of ['Headless', 'Client', 'Full'])
      await expect(page.getByRole('radio', { name: new RegExp(option) })).toBeVisible()
    await page.screenshot({ path: join(artifacts, 'windowed-installer-installed.png'), fullPage: true })
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('quit')).catch(error => {
      if (!/closed|destroyed|disconnected/i.test(error.message)) throw error
    })
    await expect.poll(() => child.exitCode, { timeout: 10_000 }).not.toBe(null)
    assert.deepEqual(record.errors, [])
    record.passed = true
  } finally {
    await browser?.close().catch(() => {})
    if (child?.pid && child.exitCode === null)
      await command('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']).catch(error => record.errors.push(error.message))
    if (installed) {
      const uninstallers = (await readdir(directory).catch(() => [])).filter(name => /^uninstall.*\.exe$/i.test(name))
      if (uninstallers.length === 1)
        await command(join(directory, uninstallers[0]), ['/S', `_?=${directory}`], 180_000, { windowsVerbatimArguments: true })
      else if (record.passed) throw new Error('The installed GUI must provide exactly one uninstaller')
    }
    await writeFile(join(artifacts, 'windowed-installer.json'), `${JSON.stringify(record, null, 2)}\n`)
  }
}
