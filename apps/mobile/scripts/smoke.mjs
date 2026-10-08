// The mobile UI talks to real Rust + pinned Pi. Only the model service is a local fixture.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium, expect } from '@playwright/test'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const daemonPath = path.join(root, 'backend/hexbot-core/target/debug/hexbot')
const piPath = path.join(root, 'backend/pi-runtime/node_modules/.bin/pi')
await Promise.all([access(daemonPath), access(piPath)])
let appUrl = process.env.HEXBOT_MOBILE_URL || 'http://127.0.0.1:8181'
let appServer
const artifacts =
  process.env.HEXBOT_MOBILE_ARTIFACTS ||
  (await mkdtemp(path.join(tmpdir(), 'hexbot-mobile-evidence-')))
const home = await mkdtemp(path.join(tmpdir(), 'hexbot-mobile-home-'))
const workspace = await mkdtemp(path.join(tmpdir(), 'hexbot-mobile-workspace-'))
await mkdir(artifacts, { recursive: true })
const errors = []
const modelRequests = []
let daemon,
  browser,
  page,
  socket,
  daemonLog = ''
const textOf = value =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map(p => p.text || '').join('\n')
      : ''
const model = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mobile-test', object: 'model', owned_by: 'local' }] }))
    return
  }
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks).toString())
    modelRequests.push(request)
    const prompt = textOf(request.messages.findLast(m => m.role === 'user')?.content)
    const lastUser = request.messages.findLastIndex(m => m.role === 'user')
    const toolAnswered = request.messages.slice(lastUser + 1).some(m => m.role === 'tool')
    const tool =
      !toolAnswered && prompt.includes('Ask two questions')
        ? {
            name: 'clarify',
            args: {
              questions: [
                {
                  qid: 'when',
                  question: 'When should I send the brief?',
                  choices: ['Morning', 'Evening']
                },
                {
                  qid: 'topics',
                  question: 'Which topics?',
                  choices: ['One', 'Two'],
                  multi_select: true
                }
              ]
            }
          }
        : !toolAnswered && prompt.includes('Show a visual')
          ? {
              name: 'hexbot_show_html',
              args: {
                title: 'Mobile chart',
                html: '<!doctype html><html><body><h1>42 completed tasks</h1></body></html>'
              }
            }
          : !toolAnswered && prompt.includes('Ask for approval')
            ? { name: 'write', args: { path: 'mobile-approval.txt', content: 'approved' } }
            : null
    const answer = prompt.startsWith('Room: ')
      ? 'The mobile room is working. @user your team is ready.'
      : /native|Hello from/i.test(prompt)
        ? 'Your native message reached the daemon and Pi.'
        : prompt.includes('Ask two questions')
          ? 'Questions answered on mobile.'
          : prompt.includes('Show a visual')
            ? 'The mobile visual is ready.'
            : prompt.includes('Read the attachment')
              ? 'The mobile attachment reached Pi.'
              : prompt.includes('Ask for approval')
                ? 'The mobile approval reached Pi.'
                : 'Your daemon received this from mobile. The connection is working.'
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const frame = (delta, finish_reason = null) =>
      JSON.stringify({
        id: `mobile-${modelRequests.length}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mobile-test',
        choices: [{ index: 0, delta, finish_reason }]
      })
    if (tool) {
      res.write(
        `data: ${frame({ role: 'assistant', tool_calls: [{ index: 0, id: `tool-${modelRequests.length}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] })}\n\n`
      )
      res.write(`data: ${frame({}, 'tool_calls')}\n\n`)
    } else {
      res.write(`data: ${frame({ role: 'assistant', content: answer.slice(0, 20) })}\n\n`)
      res.write(`data: ${frame({ content: answer.slice(20) })}\n\n`)
      res.write(`data: ${frame({}, 'stop')}\n\n`)
    }
    res.end('data: [DONE]\n\n')
  } catch (e) {
    errors.push(e.message)
    res.writeHead(500).end()
  }
})
const exec = promisify(execFile)
try {
  if (process.argv.includes('--static')) {
    const dist = path.join(root, 'apps/mobile/dist')
    await access(path.join(dist, 'index.html'))
    const mime = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.json': 'application/json',
      '.ttf': 'font/ttf',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.css': 'text/css'
    }
    appServer = createServer(async (req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
        const file = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`)
        if (!file.startsWith(dist + path.sep)) {
          res.writeHead(403).end()
          return
        }
        res.setHeader('content-type', mime[path.extname(file)] || 'application/octet-stream')
        res.end(await readFile(file))
      } catch {
        res.writeHead(404).end()
      }
    })
    appServer.listen(0, '127.0.0.1')
    await once(appServer, 'listening')
    appUrl = `http://127.0.0.1:${appServer.address().port}`
  }
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  const modelBase = `http://127.0.0.1:${model.address().port}/v1`
  await writeFile(
    path.join(home, 'config.yaml'),
    `model:\n  provider: lmstudio\n  default: mobile-test\n  base_url: ${modelBase}\n  api_key: test-key\nmodel_overrides:\n  lmstudio:\n    mobile-test:\n      supports_reasoning: true\n`
  )
  await writeFile(
    path.join(home, 'live_model_levels.json'),
    JSON.stringify({ lmstudio: { 'mobile-test': ['off', 'minimal', 'low', 'medium', 'high'] } })
  )
  await mkdir(path.join(home, 'users/local'), { recursive: true })
  await writeFile(path.join(home, 'users/local/user.md'), '')
  const env = {
    ...process.env,
    HEXBOT_HOME: home,
    HEXBOT_PI_EXECUTABLE: piPath,
    HEXBOT_WEB_DEV_URL: appUrl
  }
  daemon = spawn(daemonPath, ['serve', '--host', '127.0.0.1', '--port', '0'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Daemon readiness timed out: ${daemonLog}`)),
      30000
    )
    daemon.once('error', reject)
    daemon.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`Daemon exited ${code}`))
    })
    const data = chunk => {
      daemonLog += chunk
      const match = /HERMES_BACKEND_READY port=(\d+)/.exec(daemonLog)
      if (match) {
        clearTimeout(timer)
        resolve(+match[1])
      }
    }
    daemon.stdout.on('data', data)
    daemon.stderr.on('data', data)
  })
  const base = `http://127.0.0.1:${port}`
  const token = (await readFile(path.join(home, 'local-device.token'), 'utf8')).trim()
  const ticket = (
    await (
      await fetch(`${base}/api/auth/ws-ticket`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      })
    ).json()
  ).ticket
  const pending = new Map()
  let id = 0
  socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/ws?ticket=${ticket}`)
  socket.addEventListener('message', e => {
    for (const line of String(e.data).split('\n').filter(Boolean)) {
      const reply = JSON.parse(line)
      const task = pending.get(reply.id)
      if (task) {
        pending.delete(reply.id)
        reply.error
          ? task.reject(new Error(`${task.method}: ${JSON.stringify(reply.error)}`))
          : task.resolve(reply.result)
      }
    }
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id
      const timer = setTimeout(() => {
        pending.delete(key)
        reject(new Error(`${method} timed out`))
      }, 30000)
      pending.set(key, {
        method,
        resolve: v => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: e => {
          clearTimeout(timer)
          reject(e)
        }
      })
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n')
    })
  await rpc('hexbot.settings.set', {
    patch: {
      workspace_dir: workspace,
      dream_enabled: false,
      approval_mode: 'smart',
      default_model: 'lmstudio/mobile-test',
      billing_notice_ack: true
    }
  })
  const bots = {}
  for (const name of ['owl', 'fox', 'fern']) {
    bots[name] = await rpc('hexbot.bots.create', {
      name,
      display_name: name === 'owl' ? 'Owl' : name === 'fox' ? 'Fox' : 'Fern',
      title: name === 'owl' ? 'Chief of staff' : name === 'fox' ? 'Research' : 'Inbox manager',
      description:
        name === 'owl'
          ? 'Keeps the calendar, travel and family logistics in order.'
          : name === 'fox'
            ? 'Reads long sources and reports what changed.'
            : 'Sorts email and drafts replies for your approval.',
      provider: 'lmstudio',
      model: 'mobile-test',
      persona: `You are ${name}. Keep replies short.`,
      tools: name === 'owl' ? ['files'] : [],
      approval_mode: name === 'owl' ? 'manual' : 'smart'
    })
    await writeFile(
      path.join(home, `profiles/${name}/config.yaml`),
      `model:\n  provider: lmstudio\n  default: mobile-test\n  base_url: ${modelBase}\n  api_key: test-key\ntools:\n  enabled_toolsets: ${name === 'owl' ? '[file]' : '[]'}\napproval_mode: ${name === 'owl' ? 'manual' : 'smart'}\n`
    )
  }
  const section = bots.owl.section.id
  await rpc('hexbot.sections.rename', { id: section, title: 'Daily brief' })
  const trip = (await rpc('hexbot.sections.create', { bot: 'owl' })).section.id
  await rpc('hexbot.sections.rename', { id: trip, title: 'Tokyo trip' })
  const old = (await rpc('hexbot.sections.create', { bot: 'owl' })).section.id
  await rpc('hexbot.sections.rename', { id: old, title: 'Old errands' })
  await rpc('hexbot.sections.archive', { id: old })
  const room = (
    await rpc('hexbot.rooms.create', { name: 'Our team', members: ['owl', 'fox'], main_bot: 'owl' })
  ).room
  const launch = (
    await rpc('hexbot.rooms.create', { name: 'Launch week', members: ['fern', 'fox'] })
  ).room
  const code = (await rpc('hexbot.pairing.code')).code
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: process.env.HEXBOT_MOBILE_SCHEME === 'dark' ? 'dark' : 'light'
  })
  const shot = name => page.screenshot({ path: path.join(artifacts, `${name}.png`) })
  // Cards rise in; wait for them to settle before a picture.
  const settle = () => page.waitForTimeout(450)
  page = await context.newPage()
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('connection-screen')).toBeVisible({ timeout: 60000 })
  await page.screenshot({ path: path.join(artifacts, 'connection.png') })
  await page.getByTestId('connection-address').fill(base)
  await page.getByTestId('connection-code').fill(code)
  await page.getByTestId('connection-pair').click()
  await expect(page.getByTestId('bot-row-owl')).toBeVisible({ timeout: 30000 })
  await page.screenshot({ path: path.join(artifacts, 'bots.png') })
  const device = (await rpc('hexbot.devices.list')).devices.find(
    d => d.name === 'Hexbot on Android'
  )
  assert(device, 'The browser preview must pair through the native credential flow')
  await page.getByTestId('daemon-pill').click()
  await expect(page.getByTestId('daemon-switcher')).toBeVisible()
  await settle()
  await shot('daemon-switcher')
  await page.getByTestId('daemon-switcher-close').click()
  await expect(page.getByTestId('daemon-switcher')).not.toBeVisible()
  await page.getByTestId('bot-row-owl').click()
  await expect(page.getByTestId(`thread-row-${section}`)).toBeVisible()
  await expect(page.getByTestId(`thread-row-${trip}`)).toBeVisible()
  await expect(page.getByTestId(`thread-row-${old}`)).not.toBeVisible()
  await page.getByTestId('threads-model').click()
  await expect(page.getByTestId('threads-model-menu-level-xhigh')).toHaveCount(0)
  await expect(page.getByTestId('threads-model-menu-level-max')).toHaveCount(0)
  await page.getByTestId('threads-model-menu-level-high').click()
  await expect
    .poll(async () => (await rpc('hexbot.bots.get', { name: 'owl' })).bot.reasoning_effort)
    .toBe('high')
  await expect(page.getByTestId('threads-model')).toContainText('High')
  await shot('model-menu')
  await page.getByTestId('threads-model-menu-backdrop').click({ position: { x: 12, y: 12 } })
  await page.getByTestId(`thread-row-${section}`).click()
  await expect(page.getByTestId('chat-empty')).toBeVisible()
  await expect(page.getByText('Opening conversation', { exact: true })).not.toBeVisible()
  await shot('thread-empty')
  await page.getByTestId('chat-input').fill('Check the mobile connection')
  await page.getByTestId('chat-send').click()
  await expect(
    page.getByText('Your daemon received this from mobile. The connection is working.', {
      exact: true
    })
  ).toBeVisible({ timeout: 30000 })
  await page.screenshot({ path: path.join(artifacts, 'chat.png') })
  await page.getByTestId('chat-input').fill('Ask two questions')
  await page.getByTestId('chat-send').click()
  await page.getByTestId('question-choice-Morning').click({ timeout: 30000 })
  await page.getByTestId('question-sheet-action').click()
  await page.getByTestId('question-choice-One').click()
  await page.getByTestId('question-choice-Two').click()
  await page.screenshot({ path: path.join(artifacts, 'questions.png') })
  await page.getByTestId('question-sheet-action').click()
  await expect(page.getByText('Questions answered on mobile.', { exact: true })).toBeVisible({
    timeout: 30000
  })
  const answerRequest = modelRequests.at(-1)
  assert.match(JSON.stringify(answerRequest.messages), /Morning/)
  assert.match(JSON.stringify(answerRequest.messages), /One, Two/)
  await page.getByTestId('chat-input').fill('Show a visual')
  await page.getByTestId('chat-send').click()
  await expect(page.getByText('The mobile visual is ready.', { exact: true })).toBeVisible({
    timeout: 30000
  })
  await page.locator('[data-testid^="visual-open-"]').first().click()
  await expect(page.frameLocator('iframe').getByText('42 completed tasks')).toBeVisible()
  await settle()
  await page.screenshot({ path: path.join(artifacts, 'visual.png') })
  await page.getByTestId('visual-sheet-close').click()
  await expect(page.getByTestId('visual-sheet')).not.toBeVisible()
  await shot('chat-visual')
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('chat-attach').click()
  await (
    await chooser
  ).setFiles({
    name: 'brief.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('A brief from the phone.')
  })
  await expect(page.getByText('brief.txt', { exact: true })).toBeVisible()
  await page.getByTestId('chat-input').fill('Read the attachment')
  await page.getByTestId('chat-send').click()
  await expect(page.getByText('The mobile attachment reached Pi.', { exact: true })).toBeVisible({
    timeout: 30000
  })
  assert.match(JSON.stringify(modelRequests.at(-1).messages), /brief\.txt/)
  await page.getByTestId('chat-input').fill('Ask for approval')
  await page.getByTestId('chat-send').click()
  const allowOnce = page.locator('[data-testid^="approval-"][data-testid$="-once"]')
  await expect(allowOnce).toBeVisible({ timeout: 30000 })
  await assert.rejects(access(path.join(workspace, 'mobile-approval.txt')))
  await page.screenshot({ path: path.join(artifacts, 'approval.png') })
  await allowOnce.click()
  await expect(page.getByText('The mobile approval reached Pi.', { exact: true })).toBeVisible({
    timeout: 30000
  })
  assert.equal(await readFile(path.join(workspace, 'mobile-approval.txt'), 'utf8'), 'approved')
  await shot('chat-tools')
  await page.locator('[data-testid^="chat-tool-"]').last().click()
  await expect(page.getByTestId('tool-sheet')).toBeVisible()
  await settle()
  await shot('tool-card')
  await page.getByTestId('tool-sheet-close').click()
  await expect(page.getByTestId('tool-sheet')).not.toBeVisible()
  await page.getByTestId('chat-title').click()
  await expect(page.getByTestId(`sections-row-${trip}`)).toBeVisible()
  await settle()
  await shot('thread-switcher')
  await page.getByTestId('sections-close').click()
  await expect(page.getByTestId('sections')).not.toBeVisible()
  await page.getByTestId('chat-settings').click()
  await expect(page.getByTestId('field-persona')).toBeVisible()
  await settle()
  await shot('profile')
  await page.getByTestId('action-delete-bot').scrollIntoViewIfNeeded()
  await shot('profile-setup')
  await page.getByTestId('field-persona').fill('You are Owl. Give short, clear answers.')
  await page.getByTestId('management-sheet-action').click()
  await expect
    .poll(async () => (await rpc('hexbot.bots.get', { name: 'owl' })).bot.persona)
    .toBe('You are Owl. Give short, clear answers.')
  await expect(page.getByTestId('management-sheet')).not.toBeVisible()
  await page.getByTestId('chat-settings').click()
  await page.getByTestId('field-title').fill('Unsaved role on my phone')
  await page.getByTestId('manage-memory').click()
  await page.getByTestId('field-memory_md').fill('The user prefers jasmine tea.')
  await expect(page.getByTestId('field-memory_md')).toHaveValue('The user prefers jasmine tea.')
  await shot('bot-memory')
  await page.getByTestId('management-sheet-action').click()
  await expect
    .poll(async () => (await rpc('hexbot.memory.bot.get', { bot: 'owl' })).memory_md)
    .toBe('The user prefers jasmine tea.')
  assert.equal((await rpc('hexbot.memory.bot.get', { bot: 'fox' })).memory_md, '')
  // Saving a card opened from the profile returns to the profile.
  await expect(page.getByTestId('field-persona')).toBeVisible()
  await expect(page.getByTestId('field-title')).toHaveValue('Unsaved role on my phone')
  await page.getByTestId('manage-tools').click()
  await expect(page.getByTestId('tool-files-row')).toBeVisible()
  await settle()
  await shot('profile-tools')
  await page.getByTestId('management-sheet-back').click()
  await page.getByTestId('management-sheet-close').click()
  await expect(page.getByTestId('management-sheet')).not.toBeVisible()
  await page.getByTestId('chat-new-section').click()
  await expect(page.getByTestId('chat-empty')).toBeVisible()
  await expect(page.getByText('Opening conversation', { exact: true })).not.toBeVisible()
  await shot('thread-new')
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByTestId('threads-screen')).toBeVisible()
  await page.getByTestId(`thread-actions-${trip}`).click()
  await settle()
  await shot('thread-options')
  await page.getByTestId('field-title').fill('Tokyo trip, November')
  await page.getByTestId('management-sheet-action').click()
  await expect
    .poll(
      async () =>
        (await rpc('hexbot.sections.list', { bot: 'owl', include_archived: true })).sections.find(
          s => s.id === trip
        ).title
    )
    .toBe('Tokyo trip, November')
  await page.getByTestId('threads-shelf').click()
  await expect(page.getByTestId(`thread-row-${old}`)).toBeVisible()
  await shot('threads-archived')
  await page.getByTestId(`thread-restore-${old}`).click()
  await expect
    .poll(
      async () =>
        (await rpc('hexbot.sections.list', { bot: 'owl', include_archived: true })).sections.find(
          s => s.id === old
        ).archived_at
    )
    .toBe(null)
  await page.getByTestId('threads-shelf').click()
  await expect(page.getByTestId(`thread-row-${old}`)).toBeVisible()
  await shot('threads')
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByTestId('home-tabs-groups').click()
  await expect(page.getByTestId('groups-view')).toBeVisible()
  await expect(page.getByTestId(`group-chip-${launch.id}`)).toBeVisible()
  await page.getByTestId(`group-chip-${room.id}`).click()
  await expect(page.getByRole('heading', { name: 'Our team', exact: true })).toBeVisible()
  await page.getByTestId('chat-input').fill('Check our team on mobile')
  await page.getByTestId('chat-send').click()
  await expect(
    page.getByText('The mobile room is working. @user your team is ready.', { exact: true })
  ).toBeVisible({ timeout: 30000 })
  await page.screenshot({ path: path.join(artifacts, 'room.png') })
  await page.getByTestId('group-settings').click()
  await expect(page.getByTestId('main-bot-owl')).toBeVisible()
  await settle()
  await shot('group-settings')
  await page.getByTestId('management-sheet-close').click()
  await expect(page.getByTestId('management-sheet')).not.toBeVisible()
  await page.getByTestId('home-tabs-daemon').click()
  await shot('daemon')
  await page.getByTestId('daemon-about').click()
  await page.getByTestId('field-text').fill('I prefer brief updates from my phone.')
  await page.getByTestId('management-sheet-action').click()
  await expect
    .poll(async () => (await rpc('hexbot.memory.user.get')).text)
    .toBe('I prefer brief updates from my phone.')
  await expect(page.getByTestId('management-sheet')).not.toBeVisible()
  for (const area of [
    'settings',
    'providers',
    'connectors',
    'skills',
    'activity',
    'usage',
    'network',
    'devices',
    'users',
    'connect',
    'updates'
  ]) {
    await page.getByTestId(`daemon-${area}`).click()
    await expect(page.getByTestId('management-loading')).not.toBeVisible({ timeout: 30000 })
    await expect(page.getByTestId('management-error')).not.toBeVisible()
    await settle()
    await shot(`area-${area}`)
    if (area === 'users') {
      await page.getByTestId('manage-invite').click()
      await page.getByTestId('field-display_name').fill('Mobile teammate')
      await page.getByTestId('management-sheet-action').click()
      await expect(page.getByTestId('management-notice')).toContainText('Pairing code:')
      await expect
        .poll(async () =>
          (await rpc('hexbot.users.list')).users.some(u => u.display_name === 'Mobile teammate')
        )
        .toBe(true)
      await settle()
      await shot('invite')
      await page.getByTestId('management-sheet-back').click()
    }
    if (area === 'connectors') {
      await page.getByTestId('manage-mcp').click()
      await page.getByTestId('field-name').fill('Calendar MCP')
      await page.getByTestId('mcp-http').click()
      await page.getByTestId('field-url').fill('https://mcp.example.com')
      await settle()
      await shot('mcp')
      await page.getByTestId('management-sheet-back').click()
    }
    if (area === 'skills') {
      await page.getByTestId('manage-skill-create').click()
      await page.getByTestId('field-name').fill('mobile-update')
      await page
        .getByTestId('field-content')
        .fill(
          '---\ndescription: Send brief updates from your phone\n---\n\nSend a short update when the work is ready.'
        )
      await settle()
      await shot('skill-editor')
      await page.getByTestId('management-sheet-action').click()
      await expect
        .poll(async () =>
          (await rpc('hexbot.skills.list')).skills.some(s => s.name === 'mobile-update')
        )
        .toBe(true)
    }
    await page.getByTestId('management-sheet-close').click()
    await expect(page.getByTestId('management-sheet')).not.toBeVisible()
  }
  await page.getByTestId('daemon-jobs').click()
  await page.getByTestId('manage-job-create').click()
  await page.getByTestId('field-name').fill('Mobile morning brief')
  await page.getByTestId('field-prompt').fill('Write my brief')
  await page.getByTestId('management-sheet-action').click()
  await expect.poll(async () => (await rpc('hexbot.jobs.list', { bot: 'owl' })).jobs.length).toBe(1)
  const job = (await rpc('hexbot.jobs.list', { bot: 'owl' })).jobs[0]
  await page.getByTestId(`job-${job.id}`).click()
  await page.getByTestId('action-pause-job').click()
  await expect
    .poll(
      async () =>
        (await rpc('hexbot.jobs.list', { bot: 'owl', include_disabled: true })).jobs[0].enabled
    )
    .toBe(false)
  await page.screenshot({ path: path.join(artifacts, 'job.png') })
  await page.getByTestId('management-sheet-backdrop').click({ position: { x: 196, y: 20 } })
  await page.screenshot({ path: path.join(artifacts, 'daemons.png') })
  await expect(page.getByTestId('management-sheet')).not.toBeVisible()
  await page.getByTestId('home-tabs-bots').click()
  await shot('bots-feed')
  await page.getByTestId('bots-new').click()
  await expect(page.getByTestId('field-name')).toBeVisible()
  await settle()
  await shot('bot-new')
  await page.getByTestId('management-sheet-close').click()
  await expect(page.getByTestId('management-sheet')).not.toBeVisible()
  await page.getByTestId('bot-row-owl').click()
  await page.getByTestId(`thread-row-${section}`).click()
  await expect(
    page.getByText('Your daemon received this from mobile. The connection is working.', {
      exact: true
    })
  ).toBeVisible()
  await page.locator('[data-testid^="visual-open-"]').first().click()
  await expect(page.frameLocator('iframe').getByText('42 completed tasks')).toBeVisible()
  await page.getByTestId('visual-sheet-close').click()
  // A reload keeps metadata, but the browser preview intentionally has no persistent secrets.
  // Reconnect the same client by disconnecting and selecting its saved target.
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByTestId('home-tabs-daemon').click()
  await page.getByTestId('daemon-disconnect').click()
  await expect(page.getByTestId('connection-screen')).toBeVisible()
  await shot('connection-saved')
  await page.locator('[data-testid^="connection-saved-"]').first().click()
  await page.getByTestId('home-tabs-bots').click()
  await expect(page.getByTestId('bot-row-owl')).toBeVisible({ timeout: 30000 })
  await page.getByTestId('bot-row-owl').click()
  await page.getByTestId(`thread-row-${section}`).click()
  await expect(
    page.getByText('Your daemon received this from mobile. The connection is working.', {
      exact: true
    })
  ).toBeVisible()
  assert(
    modelRequests.length >= 2,
    'The real Pi process must call the streaming model for chat and room'
  )
  assert.deepEqual(errors, [], 'No uncaught UI or model errors')
  const report = {
    passed: true,
    client: 'Expo React Native web at iPhone size',
    realDaemon: true,
    realPi: true,
    model: 'local streaming fixture',
    scenarios: [
      'pairing with device proof',
      'bot chat and streaming',
      'batched questions and multiple choices',
      'sandboxed bot visual',
      'file attachment delivered to Pi',
      'approval gates a real file write',
      'bot feed, thread list, rename, archive shelf and restore',
      'model menu sets a supported thinking level',
      'thread switcher, tool card and new thread',
      'soul editing',
      'isolated bot memory',
      'About you',
      'daemon management panels',
      'user invitation and skill creation',
      'group chat in the Groups tab',
      'scheduled jobs and pause',
      'daemon disconnect and reconnect',
      'history restoration'
    ],
    modelRequests: modelRequests.length,
    artifacts
  }
  await writeFile(path.join(artifacts, 'smoke.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  if (process.argv.includes('--keep')) {
    const nativeCode = (await rpc('hexbot.pairing.code')).code
    await writeFile(
      path.join(artifacts, 'native-pairing.json'),
      JSON.stringify({ base, port, code: nativeCode, home, workspace })
    )
    console.log('Test daemon is available for simulator validation. Stop this process to clean up.')
    await new Promise(resolve => process.once('SIGINT', resolve))
  }
} catch (e) {
  await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
  console.error(`Artifacts: ${artifacts}\nDaemon: ${daemonLog.slice(-1600)}`)
  console.error(
    await page
      ?.locator('body')
      .innerText()
      .catch(() => '')
  )
  throw e
} finally {
  socket?.close()
  await browser?.close()
  if (daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM')
    await once(daemon, 'exit')
  }
  model.closeAllConnections()
  await new Promise(resolve => model.close(resolve))
  if (appServer) {
    appServer.closeAllConnections()
    await new Promise(resolve => appServer.close(resolve))
  }
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
}
