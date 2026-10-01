// Run the unchanged browser bundle against Rust + pinned Pi + a local streaming model.
// Build first: cargo build --manifest-path backend/hexbot-core/Cargo.toml --bin hexbot
//              pnpm --filter ./apps/web run build
// Usage: node scripts/dev/native-ui-smoke.mjs [--desktop] [--edition=full|client]
// Desktop mode builds an isolated edition and connects it to the same test daemon.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile, mkdir, mkdtemp, rm, access, cp, copyFile, readdir, symlink } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { chromium, _electron: electron, expect } = require('@playwright/test')
const flags = process.argv.slice(2)
const desktop = flags.includes('--desktop')
const edition = flags.find(flag => flag.startsWith('--edition='))?.split('=')[1] || 'full'
assert(['full', 'client'].includes(edition), 'Edition must be full or client')
assert(flags.every(flag => flag === '--desktop' || flag.startsWith('--edition=')), 'Unknown smoke option')
const daemonPath = process.env.HEXBOT_SMOKE_DAEMON || path.join(root, 'backend/hexbot-core/target/debug/hexbot')
const piPath = process.env.HEXBOT_TEST_PI || path.join(root, 'backend/pi-runtime/node_modules/.bin/pi')
const webDist = path.join(root, 'apps/web/dist')
await Promise.all([access(daemonPath), access(piPath), access(path.join(webDist, 'index.html'))])
assert.equal((await promisify(execFile)(piPath, ['--version'])).stdout.trim(), '0.87.1')
const home = await mkdtemp(path.join(tmpdir(), 'hexbot-native-ui-'))
// The daemon refuses a workspace inside its home.
const workspace = await mkdtemp(path.join(tmpdir(), 'hexbot-native-ui-workspace-'))
const artifacts = process.env.HEXBOT_SMOKE_ARTIFACTS || await mkdtemp(path.join(tmpdir(), 'hexbot-native-ui-artifacts-'))
await mkdir(artifacts, { recursive: true })
const requests = []
const errors = []
let daemon, browser, page, socket, electronApp, desktopHome, desktopBuild
let daemonLog = ''

function textOf(value) {
  return typeof value === 'string' ? value : Array.isArray(value) ? value.map(block => block.text || '').join('\n') : ''
}
const model = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model', object: 'model', owned_by: 'local' }] }))
    return
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const prompt = textOf(body.messages?.findLast(message => message.role === 'user')?.content)
    const isRoom = prompt.startsWith('Room: ')
    const answer = isRoom
      ? prompt.includes('You are @fox.') ? 'Fox checked the details.'
        : prompt.includes('Replies to collect:') ? 'Room complete. @user the result is ready.'
          : '@fox Please check the details.'
      : 'Native browser reply.'
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const frame = (delta, finish_reason = null) => JSON.stringify({ id: `smoke-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })
    res.write(`data: ${frame({ role: 'assistant', content: answer })}\n\n`)
    res.write(`data: ${frame({}, 'stop')}\n\n`)
    res.end('data: [DONE]\n\n')
  } catch (error) {
    errors.push(`Local model: ${error.message}`)
    res.writeHead(500).end()
  }
})

try {
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  const modelBase = `http://127.0.0.1:${model.address().port}/v1`
  await writeFile(path.join(home, 'config.yaml'), `model:\n  provider: lmstudio\n  default: test-model\n  base_url: ${modelBase}\n  api_key: smoke-key\n`)
  // An existing About you (even empty, as Skip leaves it) keeps the first-run page out of the chat flow.
  await mkdir(path.join(home, 'users', 'local'), { recursive: true })
  await writeFile(path.join(home, 'users', 'local', 'user.md'), '')
  const daemonEnv = { ...process.env, HEXBOT_HOME: home, HEXBOT_PI_EXECUTABLE: piPath, HEXBOT_WEB_DIST: webDist }
  daemon = spawn(daemonPath, ['serve', '--host', '127.0.0.1', '--port', '0'], { cwd: root, env: daemonEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  daemon.stderr.on('data', data => { daemonLog += data })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Daemon readiness timed out: ${daemonLog}`)), 30_000)
    daemon.once('error', reject)
    daemon.once('exit', code => { clearTimeout(timer); reject(new Error(`Daemon exited ${code}: ${daemonLog}`)) })
    daemon.stdout.on('data', data => {
      daemonLog += data
      const match = /HERMES_BACKEND_READY port=(\d+)/.exec(daemonLog)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
  })
  const base = `http://127.0.0.1:${port}`
  // A piped daemon prints no startup sign-in code; the
  // link is minted the way pnpm dev does it, with `hexbot pair`.
  assert(!daemonLog.includes('Sign in:'), 'A daemon writing to a pipe must not print a sign-in link')
  const code = /^Pairing code: (\S+)/m.exec((await promisify(execFile)(daemonPath, ['pair'], { env: daemonEnv })).stdout)?.[1]
  assert(code, 'hexbot pair must print a code')
  const signIn = `${base}/login?code=${code}`
  // Any local process can fetch the page, so it must not carry a credential.
  assert(!(await (await fetch(base)).text()).includes('__HERMES_SESSION_TOKEN__'), 'The loopback page must not embed a token')
  const token = (await readFile(path.join(home, 'local-device.token'), 'utf8')).trim()
  socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/ws?token=${encodeURIComponent(token)}`)
  const pending = new Map()
  let nextId = 0
  socket.addEventListener('message', event => {
    for (const line of String(event.data).split('\n').filter(Boolean)) {
      const response = JSON.parse(line)
      const resolve = pending.get(response.id)
      if (resolve) { pending.delete(response.id); resolve(response) }
    }
  })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 30_000)
    pending.set(id, response => { clearTimeout(timer); response.error ? reject(new Error(`${method}: ${JSON.stringify(response.error)}`)) : resolve(response.result) })
    socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  await rpc('hexbot.settings.set', { patch: { workspace_dir: workspace, dream_enabled: false, approval_mode: 'off', default_model: 'lmstudio/test-model', billing_notice_ack: true } })
  const bots = {}
  for (const name of ['owl', 'fox']) {
    bots[name] = await rpc('hexbot.bots.create', { name, display_name: name === 'owl' ? 'Owl' : 'Fox', model: 'test-model', provider: 'lmstudio', persona: `You are ${name}.`, tools: [] })
    await writeFile(path.join(home, `profiles/${name}/config.yaml`), `model:\n  provider: lmstudio\n  default: test-model\n  api_key: smoke-key\n  base_url: ${modelBase}\ntools:\n  enabled_toolsets: []\napproval_mode: off\n`)
  }
  const section = bots.owl.section.id
  await rpc('hexbot.sections.rename', { id: section, title: 'Browser smoke conversation' })
  const room = (await rpc('hexbot.rooms.create', { name: 'Browser smoke room', members: ['owl', 'fox'], main_bot: 'owl' })).room.id
  if (desktop) {
    desktopHome = await mkdtemp(path.join(tmpdir(), `hexbot-smoke-${edition}-home-`))
    desktopBuild = await mkdtemp(path.join(tmpdir(), `hexbot-smoke-${edition}-build-`))
    // The app signs in with its daemon's private token file, never from the page.
    await copyFile(path.join(home, 'local-device.token'), path.join(desktopHome, 'local-device.token'))
    const desktopRoot = path.join(root, 'apps/desktop')
    // Build into a private directory so testing one edition cannot overwrite another.
    await promisify(execFile)(path.join(desktopRoot, 'node_modules/.bin/electron-vite'), ['build', '--outDir', path.join(desktopBuild, 'out')], {
      cwd: desktopRoot, env: { ...process.env, HEXBOT_EDITION: edition }, timeout: 120_000
    })
    const manifest = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8'))
    await writeFile(path.join(desktopBuild, 'package.json'), JSON.stringify(manifest))
    await symlink(path.join(desktopRoot, 'node_modules'), path.join(desktopBuild, 'node_modules'), 'dir')
    await cp(webDist, path.join(desktopBuild, 'out/renderer'), { recursive: true })
    await mkdir(path.join(desktopBuild, 'resources'))
    for (const name of await readdir(path.join(desktopRoot, 'resources'))) {
      if (name.endsWith('.png')) await copyFile(path.join(desktopRoot, 'resources', name), path.join(desktopBuild, 'resources', name))
    }
    const electronEnv = { ...process.env, HEXBOT_HOME: desktopHome, HEXBOT_PI_EXECUTABLE: piPath, HEXBOT_E2E_TARGET: base, HEXBOT_WEB_DEV_URL: 'http://127.0.0.1:1' }
    // Agent hosts may themselves run in Electron's Node mode; the app must not inherit it.
    delete electronEnv.ELECTRON_RUN_AS_NODE
    electronApp = await electron.launch({
      executablePath: require('electron'), args: [...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []), desktopBuild], timeout: 30_000, env: electronEnv
    })
    page = await electronApp.firstWindow()
    await page.setViewportSize({ width: 1360, height: 900 })
    assert.equal(await page.evaluate(() => window.hexbot.edition), edition, 'Edition must be baked into Electron main')
    assert.equal(await page.evaluate(() => window.hexbot.e2eTarget), base)
    assert.equal((await page.evaluate(() => window.hexbot.daemon.status())).state, 'stopped', 'External target must not start a second daemon')
    if (edition === 'client') {
      const rejected = await page.evaluate(async () => {
        try { await window.hexbot.daemon.start(); return '' } catch (error) { return error.message }
      })
      assert.match(rejected, /client-only/, 'Client-only runtime operations must be rejected')
    }
  } else {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
  }
  page.setDefaultTimeout(20_000)
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(origin => localStorage.setItem('hexbot.target', JSON.stringify({ kind: 'local', origin })), base)
  if (!desktop) {
    // The browser signs in through the one-time link, which then stops working.
    const signedIn = await page.goto(signIn, { waitUntil: 'domcontentloaded' })
    assert.equal(signedIn.status(), 200)
    assert.equal(new URL(page.url()).pathname, '/', 'The sign-in link must land on the app')
    const cookies = await page.context().cookies(base)
    assert(cookies.some(cookie => cookie.name === `hermes_session_at_${port}` && cookie.sameSite === 'Strict' && cookie.httpOnly), 'The browser must keep its Strict, port-scoped session after the 303')
    assert.equal((await page.request.post(`${base}/api/auth/ws-ticket`)).status(), 200, 'The redirect must leave the browser signed in')
    // A signed-in browser is sent on without a new cookie; the spent code shows a
    // notice to a browser without a session, and a cross-site navigation never redeems.
    const reused = await page.request.get(signIn, { maxRedirects: 0 })
    assert.equal(reused.status(), 303)
    assert.equal(reused.headers()['location'], '/')
    assert(!reused.headers()['set-cookie'], 'A signed-in browser keeps its session')
    const spent = await fetch(signIn, { redirect: 'manual' })
    assert.equal(spent.status, 200)
    assert.match(await spent.text(), /used or has expired/)
    const foreign = await fetch(signIn, { redirect: 'manual', headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(foreign.status, 200)
    assert.match(await foreign.text(), /work only when opened directly/)
  }
  const visit = async route => {
    const response = await page.goto((desktop ? 'hexbot-app://app' : base) + route, { waitUntil: 'domcontentloaded' })
    assert.equal(response.status(), 200, `SPA route ${route}`)
    await expect(page.getByTestId('root-connection-status')).toHaveAttribute('data-connection-state', 'connected', { timeout: 30_000 })
  }
  await visit(`/b/owl/s/${section}`)
  const composer = page.locator('#conversation-composer')
  await composer.fill('Native browser chat')
  await composer.press('Enter')
  await expect(page.getByTestId('bot-message').filter({ hasText: 'Native browser reply.' })).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: path.join(artifacts, 'chat.png') })
  await visit(`/r/${room}`)
  const roomComposer = page.getByTestId('room-composer').locator('textarea').first()
  await roomComposer.fill('Room browser task')
  await roomComposer.press('Enter')
  await expect(page.getByTestId('room-event').filter({ hasText: 'Fox checked the details.' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('room-event').filter({ hasText: 'Room complete.' })).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: path.join(artifacts, 'room.png') })
  await expect.poll(async () => (await rpc('hexbot.rooms.log', { id: room })).events.some(event => event.kind === 'waiting.human')).toBe(true)
  const log = (await rpc('hexbot.rooms.log', { id: room })).events
  assert.deepEqual(log.filter(event => event.kind === 'message.bot').map(event => event.actor_id), ['owl', 'fox', 'owl'])

  await visit('/b/owl/settings/memory')
  await page.getByRole('textbox', { name: 'Bot memory', exact: true }).fill('The user likes jasmine tea.')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await rpc('hexbot.memory.bot.get', { bot: 'owl' })).memory_md).toBe('The user likes jasmine tea.')
  assert.equal((await rpc('hexbot.memory.bot.get', { bot: 'fox' })).memory_md, '', 'Bot memories must be isolated')
  await visit('/b/owl/settings/persona')
  await page.getByRole('textbox', { name: 'Soul', exact: true }).fill('You are Owl. Give clear, short answers.')
  await page.getByRole('textbox', { name: 'Soul', exact: true }).blur()
  await expect.poll(async () => (await rpc('hexbot.bots.get', { name: 'owl' })).bot.persona).toBe('You are Owl. Give clear, short answers.')
  await visit('/settings/memory')
  await page.getByRole('textbox', { name: 'About you', exact: true }).fill('I prefer jasmine tea.')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await rpc('hexbot.memory.user.get')).text).toBe('I prefer jasmine tea.')

  await visit('/b/owl/settings/sections')
  await page.getByRole('button', { name: 'Archive Browser smoke conversation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Unarchive Browser smoke conversation', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Unarchive Browser smoke conversation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Archive Browser smoke conversation', exact: true })).toBeVisible()
  await visit(`/b/owl/s/${section}`)
  await expect(page.getByTestId('bot-message').filter({ hasText: 'Native browser reply.' })).toBeVisible()
  await page.screenshot({ path: path.join(artifacts, 'restored.png') })
  if (!desktop) {
    // Invalid codes eventually show the distinct rate-limit notice on the real page.
    // A signed-in browser never redeems, so this runs in a context without a session.
    const anonymous = await (await browser.newContext()).newPage()
    for (let attempt = 0; attempt < 11; attempt++) await anonymous.request.get(`${base}/login?code=invalid`)
    await anonymous.goto(`${base}/login?code=invalid`, {waitUntil:'domcontentloaded'})
    await expect(anonymous.getByRole('alert')).toHaveText('Too many attempts. Wait a minute and try again.')
    await anonymous.screenshot({path: path.join(artifacts, 'sign-in-rate-limit.png')})
    await anonymous.context().close()
  }
  assert.deepEqual(errors, [], 'No uncaught browser or local model errors')
  assert(requests.length >= 4, 'The real Pi process must call the local streaming model')
  console.log(JSON.stringify({ passed: true, client: desktop ? 'electron' : 'browser', edition: desktop ? edition : undefined, scenarios: ['chat', 'multi-agent room and @user', 'per-bot memory', 'soul editing', 'About you', 'archive/unarchive and history'], modelRequests: requests.length, artifacts }, null, 2))
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
    console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 2500))
  }
  console.error(`Artifacts: ${artifacts}\nDaemon: ${daemonLog.slice(-3000)}`)
  throw error
} finally {
  socket?.close()
  await electronApp?.close()
  await browser?.close()
  if (daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM')
    await Promise.race([once(daemon, 'exit'), new Promise(resolve => setTimeout(resolve, 10_000).unref())])
    if (daemon.exitCode === null) daemon.kill('SIGKILL')
  }
  model.closeAllConnections()
  await new Promise(resolve => model.close(resolve))
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
  if (desktopHome) await rm(desktopHome, { recursive: true, force: true })
  if (desktopBuild) await rm(desktopBuild, { recursive: true, force: true })
}
