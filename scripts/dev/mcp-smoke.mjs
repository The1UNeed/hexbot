// Real daemon + pinned Pi + MCP fixture + local model, driven through pnpm dev.
// Usage: node scripts/dev/mcp-smoke.mjs
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile, realpath, stat } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { chromium, expect } = require('@playwright/test')
const home = await realpath(await mkdtemp(path.join(tmpdir(), 'hexbot-mcp-smoke-home-')))
const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'hexbot-mcp-smoke-work-')))
const artifacts = process.env.HEXBOT_SMOKE_ARTIFACTS || path.join(tmpdir(), 'hexbot-mcp-smoke-artifacts')
await mkdir(artifacts, { recursive: true })
const requests = [], events = [], browserWarnings = [], errors = []
let dev, browser, page, socket
let log = ''
let stage = { name: 'initial', code: 'text(await tools.mcp__fixture__inspect({})); text(await tools.mcp__fixture__echo({text:"live MCP echo"})); text(await tools.mcp__fixture__change({}));' }
const turns = []
const fixtureConfig = token => ({ name: 'fixture', command: process.execPath, args: [path.join(root, 'backend/pi-runtime/fixtures/mcp-server.mjs')], env: { FIXTURE_REPORT: path.join(artifacts, 'fixture-child.json'), FIXTURE_TOKEN: token } })
await writeFile(path.join(workspace, 'mcp-smoke-planted.txt'), 'workspace-planted-file')
const localModel = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model', object: 'model' }] }))
    return
  }
  if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
  try {
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    requests.push(request)
    const called = request.messages.at(-1)?.role === 'tool' || !request.tools?.some(tool => tool.function.name === 'codemode')
    const results = request.messages.filter(message => message.role === 'tool').slice(-1)
    if (called && results.length) turns.push({ stage: stage.name, results })
    const delta = called ? { role: 'assistant', content: stage.name === 'initial' ? 'Smoke initial complete. Echo returned live MCP echo. Approved change completed.' : `Smoke ${stage.name} complete.` }
      : { role: 'assistant', tool_calls: [{ index: 0, id: `mcp-live-${requests.length}`, type: 'function', function: {
        name: 'codemode', arguments: JSON.stringify({ code: stage.code })
      } }] }
    const frame = (delta, finish_reason = null) => JSON.stringify({ id: 'mcp-smoke', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${frame(delta)}\n\ndata: ${frame({}, called ? 'stop' : 'tool_calls')}\n\ndata: [DONE]\n\n`)
  } catch (error) { errors.push(error.message); res.writeHead(500).end() }
})
try {
  localModel.listen(0, '127.0.0.1')
  await once(localModel, 'listening')
  const modelBase = `http://127.0.0.1:${localModel.address().port}/v1`
  // Legacy SSE configuration exercises the warning while the stdio fixture stays usable.
  await writeFile(path.join(home, 'config.yaml'), `model:\n  provider: lmstudio\n  default: test-model\n  base_url: ${modelBase}\n  api_key: smoke-key\nmcp_servers:\n  legacy:\n    transport: sse\n    url: http://127.0.0.1:1/sse\n`)
  await mkdir(path.join(home, 'users/local'), { recursive: true })
  await writeFile(path.join(home, 'users/local/user.md'), '')
  dev = spawn('pnpm', ['dev', '--home', home], { cwd: root, env: { ...process.env, UNRELATED_SECRET: 'must-not-leak' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const devReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pnpm dev readiness timed out: ${log.slice(-3000)}`)), 180_000)
    const consume = data => {
      log += data
      process.stdout.write(data)
      const daemon = /\[dev\] daemon (http:\/\/127\.0\.0\.1:\d+)/.exec(log)
      const web = /Local:\s+(http:\/\/localhost:\d+)/.exec(log)
      if (daemon && web) { clearTimeout(timer); resolve({ base: daemon[1], webBase: web[1] }) }
    }
    dev.stdout.on('data', consume)
    dev.stderr.on('data', consume)
    dev.once('error', error => { clearTimeout(timer); reject(error) })
    dev.once('exit', code => { clearTimeout(timer); reject(new Error(`pnpm dev exited ${code}`)) })
  })
  const { base, webBase } = await devReady
  // Pi changes its process title on macOS. Record the daemon's exact invocation
  // in the disposable launcher before it execs the installed Pi executable.
  const launcher = path.join(home, 'runtime/hexbot-pi')
  const argvFile = path.join(artifacts, 'pi-launch-args.txt')
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  const launchScript = await readFile(launcher, 'utf8')
  await writeFile(launcher, launchScript.replace(/^exec /m, `printf '%s\\n' "$@" > ${quote(argvFile)}\nexec `))
  const token = (await readFile(path.join(home, 'local-device.token'), 'utf8')).trim()
  socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/ws?token=${encodeURIComponent(token)}`)
  const pending = new Map()
  let nextId = 0
  socket.addEventListener('message', event => {
    for (const line of String(event.data).split('\n').filter(Boolean)) {
      const response = JSON.parse(line)
      if (pending.has(response.id)) { pending.get(response.id)(response); pending.delete(response.id) }
      else events.push(response)
    }
  })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 30_000)
    pending.set(id, response => { clearTimeout(timer); response.error ? reject(new Error(`${method}: ${JSON.stringify(response.error)}`)) : resolve(response.result) })
    socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  await rpc('hexbot.settings.set', { patch: { workspace_dir: workspace, dream_enabled: false, approval_mode: 'smart', default_model: 'lmstudio/test-model', billing_notice_ack: true } })
  await rpc('hexbot.bots.create', { name: 'owl', display_name: 'Owl', model: 'test-model', provider: 'lmstudio', persona: 'You are Owl.', tools: [] })
  await writeFile(path.join(home, 'profiles/owl/config.yaml'), `model:\n  provider: lmstudio\n  default: test-model\n  api_key: smoke-key\n  base_url: ${modelBase}\ntools:\n  enabled_toolsets: []\napproval_mode: smart\n`)
  const added = await rpc('hexbot.connectors.add_mcp', fixtureConfig('old-smoke-token'))
  assert.equal(added.connector.id, 'mcp:fixture')
  await rpc('hexbot.connectors.set_for_bot', { id: 'mcp:fixture', bot: 'owl', enabled: true })
  const probe = await rpc('hexbot.connectors.test', { id: 'mcp:fixture', bot: 'owl' })
  assert.equal(probe.ok, true, JSON.stringify(probe))
  const probeReport = JSON.parse(await readFile(path.join(artifacts, 'fixture-child.json'), 'utf8'))
  assert.equal(probeReport.cwd, path.join(home, 'runtime/mcp/owl'))
  assert.equal(probeReport.token, 'old-smoke-token')
  assert.equal(probeReport.unrelated, null)
  const section = (await rpc('hexbot.sections.create', { bot: 'owl', title: 'Connected tools live check' })).section.id
  const daemonPath = path.join(root, 'backend/hexbot-core/target/debug/hexbot')
  const pair = await promisify(execFile)(daemonPath, ['pair'], { cwd: root, env: { ...process.env, HEXBOT_HOME: home } })
  const code = /^Pairing code: (\S+)/m.exec(pair.stdout)?.[1]
  assert(code)
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
  page.setDefaultTimeout(30_000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('websocket', ws => ws.on('framereceived', frame => {
    for (const line of String(frame.payload).split('\n').filter(Boolean)) {
      try { const event = JSON.parse(line); if (event.params?.type === 'warning') browserWarnings.push(event) } catch {}
    }
  }))
  await page.goto(`${webBase}/login?code=${code}`, { waitUntil: 'domcontentloaded' })
  await page.goto(`${webBase}/settings/appearance`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('radio', { name: 'light', exact: true }).click()
  await page.goto(`${webBase}/b/owl/s/${section}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('root-connection-status')).toHaveAttribute('data-connection-state', 'connected')
  const warning = page.getByRole('status').filter({ hasText: "can't use legacy" })
  await expect(warning).toBeVisible()
  await expect(warning.locator('span[title]')).toHaveAttribute('title', /can't use legacy\. Its server uses an old connection type/)
  await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'connected-tools-warning-light.png') })
  await page.locator('#conversation-composer').fill('Use the connected echo tool and then change the record.')
  await page.locator('#conversation-composer').press('Enter')
  await expect(page.getByText('Approval needed', { exact: true })).toBeVisible()
  await expect(page.getByText('fixture/change', { exact: true })).toBeVisible()
  await expect(page.getByText('Auto mode asks before a connected tool changes anything.', { exact: true })).toBeVisible()
  await page.locator('article').getByRole('button', { name: 'Connecting to Fixture', exact: true }).click()
  await expect(page.getByText('Running code', { exact: true })).toBeVisible()
  await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'connected-tools-live-approval-light.png') })
  const piArgs = (await readFile(argvFile, 'utf8')).trim().split('\n')
  const piProcess = `pi ${piArgs.join(' ')}`
  assert(piArgs.includes('builtin:mcp'), 'Actual Pi invocation must launch builtin:mcp')
  assert(piArgs.includes('builtin:codemode'))
  assert(piArgs.includes('--no-builtin-tools'))
  assert(piArgs.includes('--exclude-tools'), 'Unwrapped Pi built-ins must be excluded')
  assert(piArgs[piArgs.indexOf('--exclude-tools') + 1].includes('powershell'))
  assert(!piArgs.includes('--tools'))
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByTestId('bot-message').filter({ hasText: 'Smoke initial complete.' })).toBeVisible()
  if (await page.getByRole('button', { name: /^(?:Worked|Thought) / }).getAttribute('aria-expanded') !== 'true') await page.getByRole('button', { name: /^(?:Worked|Thought) / }).click()
  await expect(page.getByText('Ran code', { exact: true })).toBeVisible()
  const liveLabels = await page.getByTestId('work-status').locator('li > button').allTextContents()
  assert.deepEqual(liveLabels, ['Ran code', 'Used Fixture', 'Used Fixture', 'Used Fixture'])
  await expect(page.getByTestId('work-status').locator('li.ml-6')).toHaveCount(3)
  await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'connected-tools-live-light.png') })
  await page.reload({ waitUntil: 'domcontentloaded' })
  if (await page.getByRole('button', { name: /^(?:Worked|Thought) / }).getAttribute('aria-expanded') !== 'true') await page.getByRole('button', { name: /^(?:Worked|Thought) / }).click()
  await expect(page.getByText('Ran code', { exact: true })).toBeVisible()
  const reloadedLabels = await page.getByTestId('work-status').locator('li > button').allTextContents()
  assert.deepEqual(reloadedLabels, liveLabels, 'Live and reloaded nested transcript must match')
  await expect(page.getByTestId('work-status').locator('li.ml-6')).toHaveCount(3)
  await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'connected-tools-reloaded-light.png') })
  await page.goto(`${webBase}/settings/appearance`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('radio', { name: 'dark', exact: true }).click()
  await page.goto(`${webBase}/b/owl/s/${section}`, { waitUntil: 'domcontentloaded' })
  if (await page.getByRole('button', { name: /^(?:Worked|Thought) / }).getAttribute('aria-expanded') !== 'true') await page.getByRole('button', { name: /^(?:Worked|Thought) / }).click()
  await expect(page.getByText('Ran code', { exact: true })).toBeVisible()
  await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'connected-tools-reloaded-dark.png') })

  const agentRequests = requests.filter(request => request.tools?.some(tool => tool.function.name === 'codemode'))
  assert(agentRequests.length >= 2, 'Real Pi must make a follow-up model request')
  assert(agentRequests[0].tools.some(tool => tool.function.name === 'codemode'), 'Codemode must be declared to the model')
  assert(!agentRequests[0].tools.some(tool => tool.function.name.startsWith('mcp__')), 'MCP tools must be nested')
  const toolResults = agentRequests[1].messages.filter(message => message.role === 'tool')
  assert(JSON.stringify(toolResults).includes('live MCP echo'), 'Nested echo must return fixture data')
  assert(JSON.stringify(toolResults).includes('changed'), 'Approved nested change must execute')
  const child = JSON.parse(await readFile(path.join(artifacts, 'fixture-child.json'), 'utf8'))
  assert.equal(child.cwd, path.join(home, 'runtime/mcp/owl'))
  assert.notEqual(child.cwd, workspace)
  assert.equal(child.unrelated, null, 'Actual Pi server must not inherit unrelated daemon secrets')
  assert.equal((await stat(child.cwd)).mode & 0o777, 0o700)
  assert(JSON.stringify(turns[0].results).includes('old-smoke-token'))
  assert.match(JSON.stringify(turns[0].results), /planted.{0,5}:false/, 'Workspace planted file must be invisible from server cwd')
  const send = async (name, code, beforeApproval) => {
    stage = { name, code }
    await page.locator('#conversation-composer').fill(`Smoke ${name}`)
    await page.locator('#conversation-composer').press('Enter')
    if (beforeApproval) {
      await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
      await beforeApproval()
      await page.getByRole('button', { name: 'Approve', exact: true }).click()
    }
    await expect(page.getByTestId('bot-message').filter({ hasText: `Smoke ${name} complete.` })).toBeVisible()
    const result = turns.find(turn => turn.stage === name)
    assert(result, `Model must receive ${name} tool results`)
    return JSON.stringify(result.results)
  }
  await send('dark-live', 'text(await tools.mcp__fixture__echo({text:"dark live echo"})); text(await tools.mcp__fixture__change({}));', async () => {
    await page.locator('article').getByRole('button', { name: 'Connecting to Fixture', exact: true }).click()
    await expect(page.getByText('Running code', { exact: true })).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'connected-tools-live-approval-dark.png') })
  })
  await rpc('hexbot.bots.update', { name: 'owl', approval_mode: 'manual' })
  const manual = await send('manual-readonly', 'text(await tools.mcp__fixture__echo({text:"Manual read-only approved"}));', async () => {
    await expect(page.getByText(/^fixture\/echo/)).toBeVisible()
    await expect(page.getByText('Manual mode asks before a connected tool runs.', { exact: true })).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'connected-tool-manual-readonly-dark.png') })
  })
  assert(manual.includes('Manual read-only approved'), 'Manual read-only call must ask, then execute after approval')
  const removed = await send('removed', 'text(await tools.mcp__fixture__echo({text:"must never execute removed"}));', async () => {
    await rpc('hexbot.connectors.remove_mcp', { name: 'fixture' })
  })
  assert.match(removed, /This connected tool was removed or disabled/i)
  assert(!removed.includes('must never execute removed'), 'Removed server must not return fixture echo')
  await rpc('hexbot.connectors.add_mcp', fixtureConfig('old-smoke-token'))
  await rpc('hexbot.connectors.set_for_bot', { id: 'mcp:fixture', bot: 'owl', enabled: true })
  const disabled = await send('disabled', 'text(await tools.mcp__fixture__inspect({}));', async () => {
    await rpc('hexbot.connectors.set_for_bot', { id: 'mcp:fixture', bot: 'owl', enabled: false })
  })
  assert.match(disabled, /disabled|no longer available/i)
  assert(!disabled.includes('old-smoke-token'), 'Disabled server must not execute')
  await rpc('hexbot.connectors.set_for_bot', { id: 'mcp:fixture', bot: 'owl', enabled: true })
  const changed = await send('changed-env-midturn', 'text(await tools.mcp__fixture__inspect({}));', async () => {
    await rpc('hexbot.connectors.add_mcp', fixtureConfig('new-smoke-token'))
  })
  assert(!changed.includes('old-smoke-token'), 'Changed config must never execute with stale credentials')
  assert.match(changed, /changed|new-smoke-token|no longer available/i)
  await rpc('hexbot.bots.update', { name: 'owl', approval_mode: 'off' })
  const fresh = await send('fresh-env', 'text(await tools.mcp__fixture__inspect({}));')
  assert(fresh.includes('new-smoke-token'), 'Next prompt must reconnect using fresh credentials')
  assert(!fresh.includes('old-smoke-token'))
  await rpc('hexbot.connectors.set_for_bot', { id: 'mcp:fixture', bot: 'owl', enabled: false })
  const bypass = await send('bypass-disabled', 'text(await tools.mcp__fixture__inspect({}));')
  assert.match(bypass, /disabled|not.*(?:function|available)|no longer available/i)
  assert(!bypass.includes('new-smoke-token'), 'Bypass must still respect disablement')
  await rpc('hexbot.bots.create', { name: 'fox', display_name: 'Fox', model: 'test-model', provider: 'lmstudio', persona: 'You are Fox.', tools: [] })
  await writeFile(path.join(home, 'profiles/fox/config.yaml'), `model:\n  provider: lmstudio\n  default: test-model\n  api_key: smoke-key\n  base_url: ${modelBase}\ntools:\n  enabled_toolsets: []\napproval_mode: off\n`)
  const room = (await rpc('hexbot.rooms.create', { name: 'Connected tools room', members: ['fox'], main_bot: 'fox' })).room.id
  stage = { name: 'room-warning', code: 'text("Room warning check complete.");' }
  await page.getByRole('button', { name: /^Connected tools room/ }).click()
  await expect(page.getByTestId('root-connection-status')).toHaveAttribute('data-connection-state', 'connected')
  await page.getByTestId('room-composer').locator('textarea').fill('Smoke room-warning')
  await page.getByTestId('room-composer').locator('textarea').press('Enter')
  const roomWarning = page.getByRole('status').filter({ hasText: "Fox can't use legacy" })
  await expect(roomWarning).toBeVisible()
  await expect(roomWarning.locator('span[title]')).toHaveAttribute('title', /^Fox can't use legacy\. Its server uses an old connection type; switch it to the server's HTTP address in bot settings\.$/)
  await expect(page.getByTestId('room-event').filter({ hasText: 'Smoke room-warning complete.' })).toBeVisible()
  await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'connected-tools-room-warning-dark.png') })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await page.getByRole('radio', { name: 'light', exact: true }).click()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await page.getByRole('button', { name: /^Connected tools room/ }).click()
  await expect(roomWarning).toBeVisible()
  await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'connected-tools-room-warning-light.png') })
  assert.equal(events.filter(event => event.params?.type === 'warning' && event.params.payload.message.includes("can't use legacy")).length, 2, 'SSE warning must appear once per bot across sections and turns')
  assert.deepEqual(errors, [])
  await writeFile(path.join(artifacts, 'live-proof.json'), JSON.stringify({ passed: true, home, workspace, base, webBase, section, piProcess, modelRequests: requests.length, tools: agentRequests[0].tools, toolResults, turns, liveLabels, reloadedLabels, browserWarnings, events }, null, 2))
  console.log(JSON.stringify({ passed: true, home, workspace, artifacts, modelRequests: requests.length, turns: turns.length, piExtensions: ['builtin:mcp', 'builtin:codemode'], toolResults }, null, 2))
} catch (error) {
  if (page) {
    await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'failure.png') }).catch(() => {})
    console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 4000))
  }
  await writeFile(path.join(artifacts, 'failure-proof.json'), JSON.stringify({ home, workspace, requests, events, browserWarnings, errors, log }, null, 2))
  throw error
} finally {
  await writeFile(path.join(artifacts, 'dev.log'), log)
  socket?.close()
  await browser?.close()
  if (dev && dev.exitCode === null) { dev.kill('SIGTERM'); await once(dev, 'exit') }
  localModel.closeAllConnections()
  await new Promise(resolve => localModel.close(resolve))
}
