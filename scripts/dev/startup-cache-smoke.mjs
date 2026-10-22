// Production web bundle + real daemon + pinned Pi + local model. No live Hexbot state.
// Build the daemon and web bundle, then run: node scripts/dev/startup-cache-smoke.mjs
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { chromium, expect: baseExpect } = require('@playwright/test')
const expect = baseExpect.configure({ timeout: 20_000 })
const binary = path.join(root, 'backend/hexbot-core/target/debug/hexbot')
const pi = path.join(root, 'backend/pi-runtime/node_modules/.bin/pi')
const home = await mkdtemp(path.join(tmpdir(), 'hexbot-cache-smoke-'))
const workspace = await mkdtemp(path.join(tmpdir(), 'hexbot-cache-workspace-'))
const artifacts = await mkdtemp(path.join(tmpdir(), 'hexbot-cache-artifacts-'))
let daemon,
  browser,
  page,
  socket,
  log = '',
  count = 0
const errors = []
const model = http.createServer(async (request, response) => {
  if (request.url?.endsWith('/models')) {
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ data: [{ id: 'test-model' }] }))
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  count++
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const frame = (delta, finish_reason = null) =>
    JSON.stringify({
      id: `cache-${count}`,
      object: 'chat.completion.chunk',
      model: 'test-model',
      choices: [{ index: 0, delta, finish_reason }]
    })
  response.write(`data: ${frame({ role: 'assistant', content: 'Cache reply.' })}\n\n`)
  response.write(`data: ${frame({}, 'stop')}\n\n`)
  response.end('data: [DONE]\n\n')
})
try {
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  const modelBase = `http://127.0.0.1:${model.address().port}/v1`
  await mkdir(path.join(home, 'users/local'), { recursive: true })
  await writeFile(path.join(home, 'users/local/user.md'), '')
  await writeFile(
    path.join(home, 'config.yaml'),
    `model:\n  provider: lmstudio\n  default: test-model\n  base_url: ${modelBase}\n  api_key: fixture\n`
  )
  const env = {
    ...process.env,
    HEXBOT_HOME: home,
    HEXBOT_PI_EXECUTABLE: pi,
    HEXBOT_WEB_DIST: path.join(root, 'apps/web/dist')
  }
  daemon = spawn(binary, ['serve', '--host', '127.0.0.1', '--port', '0'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  daemon.stderr.on('data', data => {
    log += data
  })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Daemon readiness: ${log}`)), 30_000)
    daemon.on('error', reject)
    daemon.on('exit', code => {
      clearTimeout(timer)
      reject(new Error(`Daemon exited ${code}: ${log}`))
    })
    daemon.stdout.on('data', data => {
      log += data
      const match = /HERMES_BACKEND_READY port=(\d+)/.exec(log)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
  })
  const base = `http://127.0.0.1:${port}`
  const token = (await readFile(path.join(home, 'local-device.token'), 'utf8')).trim()
  socket = new WebSocket(
    `${base.replace('http:', 'ws:')}/api/ws?token=${encodeURIComponent(token)}`
  )
  const pending = new Map()
  let nextId = 0
  socket.addEventListener('message', event => {
    for (const line of String(event.data).split('\n').filter(Boolean)) {
      const reply = JSON.parse(line)
      const finish = pending.get(reply.id)
      if (finish) {
        pending.delete(reply.id)
        finish(reply)
      }
    }
  })
  await once(socket, 'open')
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000)
      pending.set(id, reply => {
        clearTimeout(timer)
        reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.result)
      })
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  await rpc('hexbot.settings.set', {
    patch: {
      workspace_dir: workspace,
      dream_enabled: false,
      approval_mode: 'off',
      default_model: 'lmstudio/test-model',
      billing_notice_ack: true
    }
  })
  const { section } = await rpc('hexbot.bots.create', {
    name: 'owl',
    display_name: 'Private Owl',
    model: 'test-model',
    provider: 'lmstudio',
    persona: 'You are Owl.',
    tools: []
  })
  await writeFile(
    path.join(home, 'profiles/owl/config.yaml'),
    `model:\n  provider: lmstudio\n  default: test-model\n  api_key: fixture\n  base_url: ${modelBase}\ntools:\n  enabled_toolsets: []\napproval_mode: off\n`
  )
  const code = /^Pairing code: (\S+)/m.exec(
    (await promisify(execFile)(binary, ['pair'], { env })).stdout
  )?.[1]
  assert(code)
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
  page.setDefaultTimeout(20_000)
  page.on('pageerror', error => errors.push(error.message))
  let hold = false,
    held,
    clientSide,
    holdLogRoom,
    heldRoomLog,
    holdGetRoom,
    heldRoomGet
  const requests = []
  await page.routeWebSocket(/\/api\/ws\?/, ws => {
    const server = ws.connectToServer()
    clientSide = ws
    const methods = new Map()
    const logRooms = new Map()
    ws.onMessage(message => {
      for (const line of String(message).split('\n').filter(Boolean)) {
        const frame = JSON.parse(line)
        if (frame.method) {
          methods.set(frame.id, frame.method)
          if (frame.method === 'hexbot.rooms.log' || frame.method === 'hexbot.rooms.get')
            logRooms.set(frame.id, frame.params.id)
          requests.push(frame.method)
        }
      }
      server.send(message)
    })
    server.onMessage(message => {
      const frames = String(message).split('\n').filter(Boolean).map(JSON.parse)
      if (
        holdGetRoom &&
        frames.some(
          frame =>
            methods.get(frame.id) === 'hexbot.rooms.get' && logRooms.get(frame.id) === holdGetRoom
        )
      ) {
        heldRoomGet = () => ws.send(message)
      } else if (
        holdLogRoom &&
        frames.some(
          frame =>
            methods.get(frame.id) === 'hexbot.rooms.log' && logRooms.get(frame.id) === holdLogRoom
        )
      ) {
        heldRoomLog = () => ws.send(message)
      } else if (hold && frames.some(frame => methods.get(frame.id) === 'hexbot.sections.open')) {
        hold = false
        held = () => ws.send(message)
      } else ws.send(message)
    })
  })
  const cache = () =>
    page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('hexbot.cache', 1)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      if (!db.objectStoreNames.contains('entries')) {
        db.close()
        return []
      }
      const values = await new Promise(resolve => {
        const tx = db.transaction('entries')
        const store = tx.objectStore('entries')
        const keys = store.getAllKeys(),
          rows = store.getAll()
        tx.oncomplete = () => resolve(keys.result.map((key, i) => ({ key, value: rows.result[i] })))
      })
      db.close()
      return values
    })
  await page.goto(`${base}/login?code=${code}`)
  await page.goto(`${base}/b/owl/s/${section.id}`)
  const composer = page.locator('#conversation-composer')
  await expect(composer).toBeEnabled()
  await composer.fill('Continue')
  await composer.press('Enter')
  await expect(page.getByTestId('bot-message').filter({ hasText: 'Cache reply.' })).toBeVisible()
  await expect
    .poll(async () =>
      (await cache())
        .find(entry => entry.key[1] === `section:${section.id}`)
        ?.value.rows.some(row => row.text === 'Cache reply.')
    )
    .toBe(true)

  // Auth succeeds but a genuine history response is held: cache draws while input stays live.
  hold = true
  await page.reload()
  await expect.poll(() => Boolean(held)).toBe(true)
  await expect(page.getByTestId('bot-message').filter({ hasText: 'Cache reply.' })).toBeVisible()
  // A cached process ID must never enable input before the first proving read.
  await expect(composer).toBeDisabled()
  held()
  held = undefined
  await expect(composer).toBeEnabled()

  // A warm navigation retains a proven live session while a new history read waits.
  await page.getByRole('button', { name: 'Bot settings', exact: true }).click()
  await expect(page).toHaveURL(/\/b\/owl\/settings/)
  hold = true
  await page.goBack()
  await expect.poll(() => Boolean(held)).toBe(true)
  await expect(composer).toBeEnabled()
  await composer.fill('Continue')
  await composer.press('Enter')
  await expect(page.getByTestId('bot-message').filter({ hasText: 'Cache reply.' })).toHaveCount(2)
  held()
  held = undefined
  await expect
    .poll(
      async () =>
        (await rpc('hexbot.sections.open', { id: section.id })).messages.filter(
          row => row.role === 'user' && row.text === 'Continue'
        ).length
    )
    .toBe(2)
  await expect
    .poll(
      async () =>
        (await cache())
          .find(entry => entry.key[1] === `section:${section.id}`)
          ?.value.rows.filter(row => row.role === 'user' && row.text === 'Continue').length
    )
    .toBe(2)
  await expect(page.getByTestId('user-message').filter({ hasText: 'Continue' })).toHaveCount(2)
  await page.screenshot({ path: path.join(artifacts, 'authorized-hydration.png') })

  // Drop the real socket and verify a new history read after reconnect.
  const before = requests.filter(method => method === 'hexbot.sections.open').length
  await clientSide.close({ code: 1012, reason: 'Smoke reconnect' })
  await expect
    .poll(() => requests.filter(method => method === 'hexbot.sections.open').length)
    .toBeGreaterThan(before)
  await expect(page.getByTestId('bot-message').filter({ hasText: 'Cache reply.' })).toHaveCount(2)

  const staleRooms = []
  for (const name of ['Deleted offline', 'Archived offline']) {
    const { room } = await rpc('hexbot.rooms.create', { name, members: ['owl'], main_bot: 'owl' })
    staleRooms.push(room.id)
    await rpc('hexbot.rooms.send', { id: room.id, text: `Private log for ${name}` })
    await expect
      .poll(async () =>
        (await rpc('hexbot.rooms.log', { id: room.id })).events.some(
          event => event.kind === 'message.bot'
        )
      )
      .toBe(true)
    // Open once so the log has a verified baseline before it is persisted.
    await page.goto(`${base}/r/${room.id}`)
    await expect(
      page.getByTestId('room-event').filter({ hasText: `Private log for ${name}` })
    ).toBeVisible()
    await expect
      .poll(async () => (await cache()).some(entry => entry.key[1] === `room:${room.id}`))
      .toBe(true)
  }
  await page.goto(`${base}/b/owl/s/${section.id}`)
  await expect(composer).toBeEnabled()

  // Cold offline reload: serve static assets, but authorization cannot complete.
  await page.route('**/api/auth/ws-ticket', route => route.abort('internetdisconnected'))
  await page.reload()
  await expect(page.getByTestId('root-connection-status')).toHaveAttribute(
    'data-connection-state',
    /offline|connecting|reconnecting/
  )
  await expect(page.getByTestId('bot-message')).toHaveCount(0)
  await expect(page.locator('[data-roster-id="bot:owl"]')).toHaveCount(0)
  assert(
    JSON.stringify(await cache()).includes('Cache reply.'),
    'Offline gating retains disk data for a later authorized connection'
  )
  await page.screenshot({ path: path.join(artifacts, 'offline-gated.png') })
  await rpc('hexbot.rooms.delete', { id: staleRooms[0] })
  await rpc('hexbot.rooms.archive', { id: staleRooms[1] })
  const { room: slowRoom } = await rpc('hexbot.rooms.create', {
    name: 'Held optional log',
    members: ['owl'],
    main_bot: 'owl'
  })
  holdLogRoom = slowRoom.id
  await page.unroute('**/api/auth/ws-ticket')
  await page.reload()
  await expect(page.getByTestId('bot-message').filter({ hasText: 'Cache reply.' })).toHaveCount(2)
  await expect.poll(() => Boolean(heldRoomLog)).toBe(true)
  await expect
    .poll(
      async () =>
        (await cache()).filter(entry => staleRooms.some(id => entry.key[1] === `room:${id}`)).length
    )
    .toBe(0)
  assert(heldRoomLog, 'Cleanup completes while the optional log is still held')
  await page.screenshot({ path: path.join(artifacts, 'held-log-cleanup.png') })
  holdLogRoom = undefined
  heldRoomLog()
  heldRoomLog = undefined

  // Cold settings: a real gone lookup cannot leave Loading after a fresh list.
  holdGetRoom = staleRooms[0]
  await page.goto(`${base}/r/${holdGetRoom}/settings`)
  await expect.poll(() => Boolean(heldRoomGet)).toBe(true)
  await expect(page.locator(`[data-roster-id="room:${slowRoom.id}"]`)).toBeVisible()
  holdGetRoom = undefined
  heldRoomGet()
  heldRoomGet = undefined
  await expect(page).toHaveURL(`${base}/b/owl/s/${section.id}`)
  await expect(composer).toBeEnabled()
  await page.screenshot({ path: path.join(artifacts, 'cold-gone-room-settings.png') })

  // A valid room remains open across the same list/lookup ordering.
  holdGetRoom = slowRoom.id
  await page.goto(`${base}/r/${holdGetRoom}/settings`)
  await expect.poll(() => Boolean(heldRoomGet)).toBe(true)
  await expect(page.getByRole('region', { name: 'Room settings' })).toBeVisible()
  holdGetRoom = undefined
  heldRoomGet()
  heldRoomGet = undefined
  await expect(page).toHaveURL(`${base}/r/${slowRoom.id}/settings`)
  await page.screenshot({ path: path.join(artifacts, 'cold-room-settings.png') })
  await page.goto(`${base}/b/owl/s/${section.id}`)
  await expect(composer).toBeEnabled()

  // An interrupted kickoff can be a plain durable user row. Store that shape
  // through the real daemon, then hold the proving read during cached reload.
  const hiddenPrompt = 'You were just created and named Owl. Internal kickoff fixture.'
  const kickoffLive = (await rpc('hexbot.sections.open', { id: section.id })).section
    .live_session_id
  await rpc('prompt.submit', { session_id: kickoffLive, text: hiddenPrompt })
  await expect
    .poll(async () =>
      (await cache())
        .find(entry => entry.key[1] === `section:${section.id}`)
        ?.value.rows.some(row => row.text === hiddenPrompt)
    )
    .toBe(true)
  hold = true
  await page.reload()
  await expect.poll(() => Boolean(held)).toBe(true)
  await expect(page.getByTestId('bot-message').filter({ hasText: 'Cache reply.' })).toHaveCount(3)
  await expect(page.getByTestId('user-message').filter({ hasText: hiddenPrompt })).toHaveCount(0)
  await expect(composer).toBeDisabled()
  held()
  held = undefined
  await expect(composer).toBeEnabled()
  await expect(page.getByTestId('user-message').filter({ hasText: hiddenPrompt })).toHaveCount(0)

  // A real oversized durable input must not turn every cached write into a multi-MB copy.
  const live = (await rpc('hexbot.sections.open', { id: section.id })).section.live_session_id
  await rpc('prompt.submit', {
    session_id: live,
    text: 'Large cache bound ' + 'x'.repeat(600 * 1024),
    input_id: '11111111-1111-4111-8111-111111111111'
  })
  await expect
    .poll(
      async () => {
        const rows = (await cache()).find(entry => entry.key[1] === `section:${section.id}`)?.value
          .rows
        return rows?.length === 1 && rows[0].text === 'Cache reply.'
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  const kept = (await cache()).find(entry => entry.key[1] === `section:${section.id}`).value.rows
  assert(Buffer.byteLength(JSON.stringify(kept)) <= 512 * 1024)
  assert.equal(
    (await rpc('hexbot.sections.open', { id: section.id })).messages.filter(
      row => row.input_id === '11111111-1111-4111-8111-111111111111'
    ).length,
    1,
    'The daemon keeps the omitted input'
  )

  const devices = (await rpc('hexbot.devices.list')).devices
  const browserDevice = devices.find(device => device.platform !== 'local')
  assert(browserDevice, 'The sign-in link must create a separate browser device')
  await rpc('hexbot.devices.revoke', { id: browserDevice.id })
  // A reconnect forces a real ticket 401 without waiting for the daemon's periodic token check.
  await clientSide.close({ code: 1012, reason: 'Check revoked credential' })
  await expect.poll(async () => (await cache()).length, { timeout: 30_000 }).toBe(0)
  await expect(page.getByTestId('bot-message')).toHaveCount(0)
  await expect(page.locator('[data-roster-id="bot:owl"]')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('bot-message')).toHaveCount(0)
  assert.equal((await cache()).length, 0)
  await page.screenshot({ path: path.join(artifacts, 'revoked.png') })
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify(
      {
        passed: true,
        scenarios: [
          'authorized cached hydration',
          'repeated input during real history read',
          'reconnect proving read',
          'offline reload authorization gate',
          'offline deletion and archive prune persisted room logs while an optional log is held',
          'cold settings resolve gone and valid rooms across held lookups',
          'cached kickoff filtering while real history is pending',
          'bounded storage after a 600 KiB durable input',
          'real device revocation and cache deletion'
        ],
        modelRequests: count,
        artifacts
      },
      null,
      2
    )
  )
} catch (error) {
  await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
  console.error(`Artifacts: ${artifacts}\nDaemon: ${log.slice(-3000)}`)
  if (page)
    console.error(
      (
        await page
          .locator('body')
          .innerText()
          .catch(() => '')
      ).slice(0, 2000)
    )
  throw error
} finally {
  socket?.close()
  await browser?.close()
  if (daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM')
    await Promise.race([
      once(daemon, 'exit'),
      new Promise(resolve => setTimeout(resolve, 5000).unref())
    ])
    if (daemon.exitCode === null) daemon.kill('SIGKILL')
  }
  model.closeAllConnections()
  await new Promise(resolve => model.close(resolve))
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
}
