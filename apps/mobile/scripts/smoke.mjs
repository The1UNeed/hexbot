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
let retainedUploadPath
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
const gmailSent = []
const model = createServer(async (req, res) => {
  // Gmail and Microsoft's sign-in, as far as the draft card and the account
  // panel need them.
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'POST' && req.url === '/gmail/v1/users/me/messages/send') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    gmailSent.push(JSON.parse(Buffer.concat(chunks).toString()))
    return reply(200, { id: 'sent-1' })
  }
  if (req.method === 'POST' && req.url === '/common/oauth2/v2.0/devicecode')
    return reply(200, {
      device_code: 'device-1',
      user_code: 'HXBT-4821',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 900,
      interval: 5
    })
  if (req.method === 'POST' && req.url === '/common/oauth2/v2.0/token')
    return reply(400, { error: 'authorization_pending' })
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        data: ['mobile-test', 'mobile-live'].map(id => ({ id, object: 'model', owned_by: 'local' }))
      })
    )
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
            : !toolAnswered && prompt.includes('Sign in to the school site')
              ? {
                  name: 'hexbot_passwords',
                  args: { action: 'ask', title: 'Northfield School', url: 'https://school.example/login' }
                }
            : !toolAnswered && prompt.includes('Draft an email to Ana')
              ? {
                  name: 'hexbot_mail',
                  args: {
                    action: 'draft',
                    to: ['Lima, Ana <ana@example.com>'],
                    subject: 'Launch review',
                    body: 'Hi Ana,\n\nFriday at 4 works for me.\n\nAlex'
                  }
                }
            : !toolAnswered && prompt.includes('Set up X search')
              ? {
                  name: 'hexbot_plugins',
                  args: { action: 'setup', id: 'connector:x_search' }
                }
            : !toolAnswered && prompt.startsWith('Read the other app attachment')
              ? { name: 'read', args: { path: retainedUploadPath } }
              : !toolAnswered && prompt.startsWith('# Heartbeat')
                ? { name: 'hexbot_notify', args: { message: 'Flight BA 286 is two hours late.' } }
                : null
    // Long enough for the phone to show the heartbeat running.
    if (tool?.name === 'hexbot_notify') await new Promise(resolve => setTimeout(resolve, 1500))
    const answer = prompt.startsWith('# Heartbeat')
    ? 'Told them BA 286 is late.'
    : prompt.startsWith('Room: ')
      ? 'The mobile room is working. @user your team is ready.'
      : /native|Hello from/i.test(prompt)
        ? 'Your native message reached the daemon and Pi.'
        : prompt.includes('Ask two questions')
          ? 'Questions answered on mobile.'
          : prompt.includes('Show a visual')
            ? 'The mobile visual is ready.'
            : prompt.startsWith('Read the other app attachment')
              ? 'The other app attachment reached Pi.'
              : prompt.includes('Read the attachment') ||
                  prompt.includes('Please review the attached files.')
                ? 'The mobile attachment reached Pi.'
                : prompt.includes('Ask for approval')
                  ? 'The mobile approval reached Pi.'
                  : prompt.includes('Sign in to the school site')
                    ? 'The school sign-in is saved.'
                  : prompt.includes('Draft an email to Ana')
                    ? 'Sent. Ana has your reply.'
                  : prompt.includes('Set up X search')
                    ? 'X search has its token.'
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
    `model:\n  provider: lmstudio\n  default: mobile-test\n  base_url: ${modelBase}\n  api_key: test-key\nmodel_overrides:\n  lmstudio:\n    mobile-test:\n      supports_reasoning: true\n    mobile-live:\n      supports_reasoning: false\naccounts:\n  google:\n    endpoint: http://127.0.0.1:${model.address().port}\n  microsoft:\n    endpoint: http://127.0.0.1:${model.address().port}\n`
  )
  // Signed in to Google already; Microsoft signs in with the user's own client.
  await writeFile(path.join(home, '.env'), 'MICROSOFT_OAUTH_CLIENT_ID="mobile-test"\n')
  await mkdir(path.join(home, 'accounts'), { recursive: true })
  await writeFile(
    path.join(home, 'accounts/gmail.json'),
    JSON.stringify({
      email: 'alex@example.com',
      client_id: 'c',
      access_token: 'tok',
      refresh_token: 'r',
      expires_at: Date.now() / 1000 + 86400,
      connected_at: 1
    }),
    { mode: 0o600 }
  )
  await mkdir(path.join(home, 'users/local'), { recursive: true })
  await writeFile(path.join(home, 'users/local/user.md'), '')
  const env = {
    ...process.env,
    HEXBOT_HOME: home,
    // Nothing answers here, so X search's test fails fast and stays offline.
    HEXBOT_X_API_BASE_URL: 'http://127.0.0.1:9',
    // The vault key stays in the temporary home, not the login keychain.
    HEXBOT_PASSWORD_KEY_STORE: 'file',
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
  // Screens show the signed-in name; use a person's name, not the default account.
  await rpc('hexbot.users.me.set', { display_name: 'Sam' })
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
  // A bot has one chat: asking for another returns it.
  assert.equal((await rpc('hexbot.sections.create', { bot: 'owl' })).section.id, section)
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
  // A bot's message in the open chat; the list under it shows the latest too.
  const message = (text, options) =>
    page.getByTestId(/^chat-message-/).getByText(text, options)
  // The stack's own back button, named after the list it returns to.
  const back = () => page.getByLabel('Chats, back', { exact: true }).click()
  page = await context.newPage()
  page.on('pageerror', e => errors.push(e.message))
  const sent = []
  page.on('websocket', ws =>
    ws.on('framesent', ({ payload }) => {
      try {
        sent.push(JSON.parse(String(payload)))
      } catch {}
    })
  )
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('connection-screen')).toBeVisible({ timeout: 60000 })
  await page.screenshot({ path: path.join(artifacts, 'connection.png') })
  await page.getByTestId('connection-address').fill(base)
  await page.getByTestId('connection-code').fill(code)
  await page.getByTestId('connection-pair').click()
  await expect(page.getByTestId('bot-row-owl')).toBeVisible({ timeout: 30000 })
  await page.screenshot({ path: path.join(artifacts, 'bots.png') })
  // A long press on a chat opens its menu beside it: pin it, then rename it from its face.
  const longPress = async locator => {
    const box = await locator.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(600)
    await page.mouse.up()
  }
  const owlName = (await rpc('hexbot.bots.get', { name: 'owl' })).bot.display_name
  await longPress(page.getByTestId('bot-row-owl'))
  await expect(page.getByTestId('row-menu-rename')).toBeVisible()
  await settle()
  await shot('row-menu')
  await page.getByTestId('row-menu-pin').click()
  await expect(page.getByTestId('pinned-bot-owl')).toBeVisible()
  await expect
    .poll(async () => (await rpc('hexbot.bots.get', { name: 'owl' })).bot.pinned_at)
    .not.toBe(null)
  await shot('pinned')
  await longPress(page.getByTestId('pinned-bot-owl'))
  await page.getByTestId('row-menu-rename').click()
  await page.getByTestId('rename-name').fill('Night Owl')
  await page.getByTestId('rename-sheet-action').click()
  await expect(page.getByTestId('pinned-bot-owl')).toContainText('Night Owl')
  await expect
    .poll(async () => (await rpc('hexbot.bots.get', { name: 'owl' })).bot.display_name)
    .toBe('Night Owl')
  await rpc('hexbot.bots.update', { name: 'owl', display_name: owlName })
  await rpc('hexbot.bots.pin', { name: 'owl', pinned: false })
  await expect(page.getByTestId('bot-row-owl')).toBeVisible()
  const device = (await rpc('hexbot.devices.list')).devices.find(
    d => d.name === 'Hexbot on Android'
  )
  assert(device, 'The browser preview must pair through the native credential flow')
  // One saved daemon: the list names no daemon, and Settings switches daemons.
  await expect(page.getByTestId('daemon-pill')).not.toBeVisible()
  await page.getByTestId('home-settings').click()
  await page.getByTestId('daemon-switch').click()
  await expect(page.getByTestId('daemon-switcher')).toBeVisible()
  await settle()
  await shot('daemon-switcher')
  await page.getByTestId('daemon-switcher-close').click()
  await expect(page.getByTestId('daemon-switcher')).not.toBeVisible()
  await back()
  // The bot row opens its one chat.
  await page.getByTestId('bot-row-owl').click()
  await expect(page.getByTestId('chat-empty')).toBeVisible()
  await expect(page.getByText('Opening conversation', { exact: true })).not.toBeVisible({
    timeout: 30000
  })
  await page.getByTestId('chat-settings').click()
  await page.getByTestId('manage-models').click()
  // The menu asks each connected provider for its current list: mobile-live
  // exists only in LM Studio's live /models reply. Providers without a key or
  // sign-in are left out.
  await expect(page.getByTestId('manage-models-menu-model-lmstudio-mobile-live')).toBeVisible({
    timeout: 30000
  })
  await expect(page.locator('[data-testid^="manage-models-menu-model-nous-"]')).toHaveCount(0)
  // The daemon knows no levels for mobile-test, so every level is offered, as on the web.
  await expect(page.getByTestId('manage-models-menu-level-max')).toBeVisible()
  await page.getByTestId('manage-models-menu-level-high').click()
  await expect(page.getByTestId('manage-models')).toContainText('High')
  await shot('model-menu')
  // A model without thinking runs with it off, whatever level is saved.
  await page.getByTestId('manage-models-menu-model-lmstudio-mobile-live').click()
  await expect(page.getByTestId('manage-models-menu-no-thinking')).toBeVisible()
  await expect(page.getByTestId('manage-models')).not.toContainText('High')
  await page.getByTestId('manage-models-menu-model-lmstudio-mobile-test').click()
  await expect(page.getByTestId('manage-models')).toContainText('High')
  await page.getByTestId('manage-models-menu-backdrop').click({ position: { x: 12, y: 12 } })
  await page.getByTestId('management-sheet-action').click()
  const owl = async () => (await rpc('hexbot.bots.get', { name: 'owl' })).bot
  await expect.poll(async () => (await owl()).reasoning_effort).toBe('high')
  assert.equal((await owl()).model, 'mobile-test')
  await expect(page.getByTestId('management-sheet')).not.toBeVisible()
  // The intro reads the level the model runs at, like the picker.
  await expect(page.getByTestId('chat-intro-model')).toHaveText('mobile-test, thinking high')
  await shot('chat-empty')
  await page.getByTestId('chat-input').fill('Check the mobile connection')
  await page.getByTestId('chat-send').click()
  await expect(
    message('Your daemon received this from mobile. The connection is working.', {
      exact: true
    })
  ).toBeVisible({ timeout: 30000 })
  // Read as it landed on screen, so the daemon does not wake this phone about it.
  await expect
    .poll(async () => (await owl()).sections_recent?.[0]?.done_at ?? null, { timeout: 10000 })
    .toBe(null)
  await page.screenshot({ path: path.join(artifacts, 'chat.png') })
  await page.getByTestId('chat-input').fill('Ask two questions')
  await page.getByTestId('chat-send').click()
  await expect(page.getByTestId('question-choice-Morning')).toBeVisible({ timeout: 30000 })
  await page.getByTestId('question-sheet-close').click()
  const answerFile = page.waitForEvent('filechooser')
  // The + offers the phone's photos, its camera, and its files.
  await page.getByTestId('chat-attach').click()
  for (const source of ['library', 'camera', 'files'])
    await expect(page.getByTestId(`chat-attach-${source}`)).toBeVisible()
  await settle()
  await shot('chat-attach-menu')
  await page.getByTestId('chat-attach-files').click()
  await (
    await answerFile
  ).setFiles({
    name: 'answer-notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Save these for later.')
  })
  await page.getByTestId('chat-input').fill('Morning')
  await page.getByTestId('chat-send').click()
  await expect(page.getByTestId('question-sheet')).toBeVisible()
  await expect(
    page.getByText('Your attached files will stay here for the next message.', { exact: true })
  ).toBeVisible()
  await page.getByTestId('question-sheet-action').click()
  await page.getByTestId('question-choice-One').click()
  await page.getByTestId('question-choice-Two').click()
  await page.screenshot({ path: path.join(artifacts, 'questions.png') })
  await page.getByTestId('question-sheet-action').click()
  await expect(message('Questions answered on mobile.', { exact: true })).toBeVisible({
    timeout: 30000
  })
  const answerRequest = modelRequests.at(-1)
  assert.match(JSON.stringify(answerRequest.messages), /Morning/)
  // Multiple choices reach the bot as a JSON array, as from the web.
  const answers = JSON.parse(answerRequest.messages.findLast(m => m.role === 'tool').content)
  assert.deepEqual(JSON.parse(answers.topics), ['One', 'Two'])
  assert.doesNotMatch(JSON.stringify(answerRequest.messages), /answer-notes\.txt/)
  await expect(page.getByText('answer-notes.txt', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Remove answer-notes.txt', exact: true }).click()
  await expect(page.getByText('answer-notes.txt', { exact: true })).not.toBeVisible()
  await page.getByTestId('chat-input').fill('Show a visual')
  await page.getByTestId('chat-send').click()
  await expect(message('The mobile visual is ready.', { exact: true })).toBeVisible({
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
  await page.getByTestId('chat-attach-files').click()
  await (
    await chooser
  ).setFiles({
    name: 'brief.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('A brief from the phone.')
  })
  await expect(page.getByText('brief.txt', { exact: true })).toBeVisible()
  // A file another app staged on this chat and never sent stays out of this message.
  const live = (await rpc('hexbot.sections.list', { include_archived: true })).sections.find(
    s => s.id === section
  ).live_session_id
  const left = await rpc('file.attach', {
    session_id: live,
    name: 'left-behind.txt',
    data_url: 'data:text/plain;base64,' + Buffer.from('Not for this message.').toString('base64')
  })
  retainedUploadPath = left.path
  await page.getByTestId('chat-send').click()
  await expect(message('The mobile attachment reached Pi.', { exact: true })).toBeVisible({
    timeout: 30000
  })
  assert.match(JSON.stringify(modelRequests.at(-1).messages), /brief\.txt/)
  assert.match(JSON.stringify(modelRequests.at(-1).messages), /Please review the attached files\./)
  assert.doesNotMatch(JSON.stringify(modelRequests.at(-1).messages), /left-behind\.txt/)
  // Exact selection keeps the other app's upload available, with its bytes intact.
  const retainedText = await readFile(left.path, 'utf8')
  assert.equal(retainedText, 'Not for this message.')
  // The composer lets the file go; your message keeps it, as a card.
  await expect(page.getByTestId(/^chat-attachment-remove-/)).toHaveCount(0)
  await expect(page.getByText('brief.txt', { exact: true })).toHaveCount(1)
  await expect
    .poll(async () => (await rpc('session.status', { session_id: live })).status)
    .toBe('idle')
  const otherSubmit = {
    session_id: live,
    text: 'Read the other app attachment',
    attachments: [left.id]
  }
  // The same paired app that staged it submits the returned ID through real RPC.
  const otherAck = await rpc('prompt.submit', otherSubmit)
  await expect(message('The other app attachment reached Pi.', { exact: true })).toBeVisible(
    {
      timeout: 30000
    }
  )
  const otherRequest = modelRequests.at(-1)
  const otherUserIndex = otherRequest.messages.findLastIndex(m => m.role === 'user')
  const otherUser = textOf(otherRequest.messages[otherUserIndex].content)
  // Check only the new user. The previous mobile file remains in cached context.
  assert.match(otherUser, /^Read the other app attachment/)
  assert.match(otherUser, /left-behind\.txt/)
  assert.doesNotMatch(otherUser, /brief\.txt|Please review the attached files\./)
  const otherTools = otherRequest.messages.slice(otherUserIndex + 1).filter(m => m.role === 'tool')
  assert.equal(otherTools.length, 1)
  assert.match(textOf(otherTools[0].content), /Not for this message\./)
  await expect
    .poll(async () => (await rpc('session.status', { session_id: live })).status)
    .toBe('idle')
  let repeatedError
  await assert.rejects(rpc('prompt.submit', otherSubmit), error => {
    repeatedError = error.message
    return /"code":4204/.test(error.message)
  })
  const otherUsers = (await rpc('session.history', { session_id: live })).messages.filter(
    m => m.role === 'user' && m.text.startsWith(otherSubmit.text)
  )
  assert.equal(otherUsers.length, 1)
  await shot('paired-upload')
  await writeFile(
    path.join(artifacts, 'paired-upload.json'),
    JSON.stringify(
      { left, retainedText, otherSubmit, otherAck, otherRequest, repeatedError, otherUsers },
      null,
      2
    ) + '\n'
  )
  await page.getByTestId('chat-input').fill('Ask for approval')
  await page.getByTestId('chat-send').click()
  const allowOnce = page.locator('[data-testid^="approval-"][data-testid$="-once"]')
  await expect(allowOnce).toBeVisible({ timeout: 30000 })
  await assert.rejects(access(path.join(workspace, 'mobile-approval.txt')))
  await page.screenshot({ path: path.join(artifacts, 'approval.png') })
  await allowOnce.click()
  await expect(message('The mobile approval reached Pi.', { exact: true })).toBeVisible({
    timeout: 30000
  })
  assert.equal(await readFile(path.join(workspace, 'mobile-approval.txt'), 'utf8'), 'approved')
  await expect(page.locator('[data-testid^="chat-tool"]')).toHaveCount(0)
  await shot('chat-approved')
  // With Computer use, the bot asks for a sign-in on a card. What is typed
  // there is saved in Passwords and never reaches the model.
  await writeFile(
    path.join(home, 'profiles/owl/config.yaml'),
    `model:\n  provider: lmstudio\n  default: mobile-test\n  base_url: ${modelBase}\n  api_key: test-key\ntools:\n  enabled_toolsets: [file]\ncomputer_use:\n  command: ${process.execPath}\napproval_mode: manual\n`
  )
  await page.getByTestId('chat-input').fill('Sign in to the school site')
  await page.getByTestId('chat-send').click()
  // The card folds its form behind Sign in, like a plugin's Connect.
  const open = page.locator('[data-testid^="sign-in-"][data-testid$="-open"]')
  await expect(open).toBeVisible({ timeout: 30000 })
  await expect(page.getByText('Northfield School', { exact: true })).toBeVisible()
  await open.click()
  const signIn = page.locator('[data-testid^="sign-in-"][data-testid$="-password"]')
  await expect(signIn).toBeVisible()
  await page.locator('[data-testid^="sign-in-"][data-testid$="-username"]').fill('alex')
  await signIn.fill('mobile-secret-42')
  await page.screenshot({ path: path.join(artifacts, 'sign-in-card.png') })
  await page.locator('[data-testid^="sign-in-"][data-testid$="-submit"]').click()
  await expect(message('The school sign-in is saved.', { exact: true })).toBeVisible({
    timeout: 30000
  })
  const saved = (await rpc('hexbot.passwords.list')).logins
  assert.deepEqual(
    saved.map(login => [login.title, login.site, login.username, login.bots]),
    [['Northfield School', 'school.example', 'alex', null]]
  )
  assert.doesNotMatch(JSON.stringify(modelRequests), /mobile-secret-42/)
  await shot('chat-signed-in')
  // A plugin's keys go on a card too: Connect opens its fields, and what is
  // typed is saved as Settings, Plugins saves it, never reaching the model.
  await writeFile(
    path.join(home, 'profiles/owl/config.yaml'),
    `model:\n  provider: lmstudio\n  default: mobile-test\n  base_url: ${modelBase}\n  api_key: test-key\ntools:\n  enabled_toolsets: [file, hexbot]\napproval_mode: manual\n`
  )
  await page.getByTestId('chat-input').fill('Set up X search')
  await page.getByTestId('chat-send').click()
  const connect = page.locator('[data-testid^="plugin-"][data-testid$="-open"]')
  await expect(connect).toBeVisible({ timeout: 30000 })
  await expect(page.getByText('X search', { exact: true })).toBeVisible()
  await shot('plugin-card')
  await connect.click()
  // The subscription comes first and needs a sign-in, not a key.
  await expect(page.locator('[data-testid^="plugin-"][data-testid$="-sign-in"]')).toBeVisible()
  await page.screenshot({ path: path.join(artifacts, 'plugin-card-sign-in.png') })
  await page.locator('[data-testid^="plugin-"][data-testid$="-provider-x_api"]').click()
  await page.locator('[data-testid^="plugin-"][data-testid$="-X_BEARER_TOKEN"]').fill('mobile-x-token-42')
  await page.screenshot({ path: path.join(artifacts, 'plugin-card-open.png') })
  await page.locator('[data-testid^="plugin-"][data-testid$="-submit"]').click()
  await expect(message('X search has its token.', { exact: true })).toBeVisible({
    timeout: 30000
  })
  const connectors = (await rpc('hexbot.connectors.list')).connectors
  assert.equal(connectors.find(c => c.id === 'x_search').ready, true)
  assert.doesNotMatch(JSON.stringify(modelRequests), /mobile-x-token-42/)
  await shot('chat-plugin-saved')
  // The bot drafts an email; the user edits it on the card and sends it.
  // A name holding a comma stays one person.
  await writeFile(
    path.join(home, 'profiles/owl/config.yaml'),
    `model:\n  provider: lmstudio\n  default: mobile-test\n  base_url: ${modelBase}\n  api_key: test-key\ntools:\n  enabled_toolsets: [file, hexbot, gmail]\napproval_mode: manual\n`
  )
  await page.getByTestId('chat-input').fill('Draft an email to Ana about the launch review')
  await page.getByTestId('chat-send').click()
  const subject = page.locator('[data-testid^="email-draft-"][data-testid$="-subject"]')
  await expect(subject).toBeVisible({ timeout: 30000 })
  await expect(page.locator('[data-testid^="email-draft-"][data-testid$="-to"]')).toHaveValue(
    'Lima, Ana <ana@example.com>'
  )
  await subject.fill('Launch review, Friday 4pm')
  await settle()
  await shot('email-draft-card')
  assert.equal(gmailSent.length, 0, 'nothing is sent before Send')
  await page.locator('[data-testid^="email-draft-"][data-testid$="-send"]').click()
  await expect(message('Sent. Ana has your reply.', { exact: true })).toBeVisible({
    timeout: 30000
  })
  assert.equal(gmailSent.length, 1)
  const sentMime = Buffer.from(gmailSent[0].raw, 'base64url').toString()
  assert.match(sentMime, /^To: "Lima, Ana" <ana@example.com>\r\n/)
  assert.match(sentMime, /\r\nSubject: Launch review, Friday 4pm\r\n/)
  await shot('chat-email-sent')
  await page.getByTestId('chat-settings').click()
  await expect(page.getByTestId('fingerprint-soul')).toBeVisible()
  await settle()
  await shot('profile')
  await page.getByTestId('action-delete-bot').scrollIntoViewIfNeeded()
  await shot('profile-setup')
  // The soul opens from its card, formatted; Edit shows its Markdown.
  await page.getByTestId('fingerprint-soul').click()
  await expect(page.getByTestId('document-read')).toContainText('Keep replies short.')
  await page.getByTestId('document-mode').getByText('Edit').click()
  await page.getByTestId('document-source').fill('You are Owl. Give short, clear answers.')
  await page.getByTestId('management-sheet-action').click()
  await expect
    .poll(async () => (await rpc('hexbot.bots.get', { name: 'owl' })).bot.persona)
    .toBe('You are Owl. Give short, clear answers.')
  await expect(page.getByTestId('fingerprint-soul')).toBeVisible()
  // The face has its own page behind Change face. A pick is saved at once,
  // with the picture of it this phone drew.
  await page.getByTestId('action-change-face').click()
  await expect(page.getByTestId('face-stage')).toBeVisible()
  await expect(page.getByTestId('face-picker').getByRole('radio')).toHaveCount(40)
  await page.getByTestId('face-picker-shape-star').click()
  await page.getByTestId('face-picker-color-yellow').click()
  await expect
    .poll(async () => (await rpc('hexbot.bots.get', { name: 'owl' })).bot.face)
    .toEqual({ color: 'yellow', shape: 'star' })
  const faced = (await rpc('hexbot.bots.get', { name: 'owl' })).bot
  assert.equal(faced.avatar?.mime, 'image/png', 'a picked face is saved with its picture')
  const picture = Buffer.from(faced.avatar.data.replace(/^data:[^,]*,/, ''), 'base64')
  assert.deepEqual(
    [picture.readUInt32BE(16), picture.readUInt32BE(20)],
    [512, 512],
    'the picture is 512 pixels square'
  )
  await writeFile(path.join(artifacts, 'face-picture.png'), picture)
  // The name of each pick shows beside its heading.
  await expect(page.getByTestId('face-picker')).toContainText('Star')
  await expect(page.getByTestId('face-picker')).toContainText('Lemon')
  await settle()
  await shot('face')
  // A photo takes the face's place and puts it aside; one button brings it back.
  const photoChooser = page.waitForEvent('filechooser')
  await page.getByTestId('action-choose-bot-picture').click()
  await (await photoChooser).setFiles({
    name: 'me.png',
    mimeType: 'image/png',
    // A one-pixel PNG: a picture, but no face this app drew.
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    )
  })
  await expect(page.getByTestId('face-photo')).toBeVisible()
  const withPhoto = (await rpc('hexbot.bots.get', { name: 'owl' })).bot
  assert.equal(withPhoto.face, null, 'a photo puts the face aside')
  assert.deepEqual(withPhoto.kept_face, { color: 'yellow', shape: 'star' })
  await expect(page.getByTestId('face-picker')).not.toContainText('Star')
  await settle()
  await shot('face-photo')
  await page.getByTestId('action-use-generated-face').click()
  await expect
    .poll(async () => (await rpc('hexbot.bots.get', { name: 'owl' })).bot.face)
    .toEqual({ color: 'yellow', shape: 'star' })
  await expect(page.getByTestId('action-shuffle-face')).toBeVisible()
  await page.getByTestId('management-sheet-back').click()
  await expect(page.getByTestId('fingerprint-soul')).toBeVisible()
  await page.getByTestId('field-title').fill('Unsaved role on my phone')
  await page.getByTestId('fingerprint-memory').click()
  await page.getByTestId('document-mode').getByText('Edit').click()
  await page.getByTestId('document-source').fill('The user prefers jasmine tea.')
  await expect(page.getByTestId('document-source')).toHaveValue('The user prefers jasmine tea.')
  await shot('bot-memory')
  await page.getByTestId('management-sheet-action').click()
  await expect
    .poll(async () => (await rpc('hexbot.memory.bot.get', { bot: 'owl' })).memory_md)
    .toBe('The user prefers jasmine tea.')
  assert.equal((await rpc('hexbot.memory.bot.get', { bot: 'fox' })).memory_md, '')
  // Saving a card opened from the profile returns to the profile.
  await expect(page.getByTestId('fingerprint-memory')).toBeVisible()
  await expect(page.getByTestId('field-title')).toHaveValue('Unsaved role on my phone')
  await page.getByTestId('manage-tools').click()
  await expect(page.getByTestId('tool-files-row')).toBeVisible()
  await settle()
  await shot('profile-tools')
  await page.getByTestId('management-sheet-back').click()
  // The heartbeat card shows a run it started end, and the bot's message lands in its chat.
  await page.getByTestId('manage-heartbeat').click()
  await expect(page.getByTestId('action-run-now')).toBeDisabled()
  await page.getByTestId('field-text').fill('- Is flight BA 286 on Friday delayed?')
  await page.getByTestId('management-sheet-action').click()
  await expect
    .poll(async () => (await rpc('hexbot.heartbeat.status', { bot: 'owl' })).empty)
    .toBe(false)
  await page.getByTestId('manage-heartbeat').click()
  await page.getByTestId('action-run-now').click()
  await expect(page.getByTestId('heartbeat-next')).toContainText('Running now')
  await expect(page.getByText('Posted in your chat. Told them BA 286 is late.')).toBeVisible({
    timeout: 30000
  })
  await expect(page.getByTestId('heartbeat-next')).not.toContainText('Running now')
  await settle()
  await shot('heartbeat')
  await page.getByTestId('management-sheet-back').click()
  await page.getByTestId('management-sheet-close').click()
  await expect(page.getByTestId('management-sheet')).not.toBeVisible()
  await expect(message('Flight BA 286 is two hours late.', { exact: true })).toBeVisible()
  await shot('heartbeat-chat')
  await back()
  // Rooms sit in the same list as chats and open like one.
  await expect(page.getByTestId(`room-row-${launch.id}`)).toBeVisible()
  await page.getByTestId(`room-row-${room.id}`).click()
  await expect(page.getByTestId('chat-title')).toContainText('Our team')
  await page.getByTestId('chat-input').fill('Check our team on mobile')
  await page.getByTestId('chat-send').click()
  await expect(
    message('The mobile room is working. @user your team is ready.', { exact: true })
  ).toBeVisible({ timeout: 30000 })
  await page.screenshot({ path: path.join(artifacts, 'room.png') })
  await page.getByTestId('chat-settings').click()
  await expect(page.getByTestId('main-bot-owl')).toBeVisible()
  await settle()
  await shot('room-settings')
  // Archiving the open room returns to the list, which leaves it out.
  await page.getByTestId('action-archive-room').click()
  await expect(page.getByTestId('management-sheet')).not.toBeVisible()
  await expect(page.getByTestId('home-screen')).toBeVisible()
  await expect(page.getByTestId(`room-row-${room.id}`)).not.toBeVisible()
  await expect(page.getByTestId(`room-row-${launch.id}`)).toBeVisible()
  // All rooms, under Bots & jobs, restores it.
  await page.getByTestId('home-library').click()
  await expect(page.getByTestId('library-rooms')).toContainText('1 archived')
  await page.getByTestId('library-rooms').click()
  await page.getByTestId(`managed-room-${room.id}`).click()
  await page.getByTestId('action-restore-room').click()
  await expect
    .poll(async () => (await rpc('hexbot.rooms.get', { id: room.id })).room.archived_at)
    .toBe(null)
  await expect(page.getByTestId('management-sheet')).not.toBeVisible()
  await expect(page.getByTestId('library-rooms')).not.toContainText('archived')
  await back()
  // A room archived elsewhere while open stays, and restoring it there keeps it open.
  await page.getByTestId(`room-row-${room.id}`).click()
  await expect(page.getByTestId('chat-title')).toContainText('Our team')
  await rpc('hexbot.rooms.archive', { id: room.id })
  await expect(page.getByTestId('chat-archived')).toBeVisible()
  await page.getByTestId('chat-settings').click()
  await page.getByTestId('action-restore-room').click()
  await expect(page.getByTestId('management-sheet')).not.toBeVisible()
  await expect(page.getByTestId('chat-archived')).not.toBeVisible()
  await expect(page.getByTestId('chat-title')).toContainText('Our team')
  await expect(page.getByTestId('chat-input')).toBeVisible()
  await back()
  await page.getByTestId('home-settings').click()
  await shot('settings')
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
    'plugins',
    'passwords',
    'activity',
    'usage',
    'network',
    'devices',
    'connect',
    'updates'
  ]) {
    await page.getByTestId(`daemon-${area}`).click()
    await expect(page.getByTestId('management-loading')).not.toBeVisible({ timeout: 30000 })
    await expect(page.getByTestId('management-error')).not.toBeVisible()
    await settle()
    await shot(`area-${area}`)
    if (area === 'settings') {
      await page.getByTestId('field-room_bot_turns_per_human_turn').fill('')
      await page.getByTestId('management-sheet-action').click()
      await expect
        .poll(async () => (await rpc('hexbot.settings.get')).room_bot_turns_per_human_turn)
        .toBe(null)
      await expect(page.getByTestId('management-sheet')).not.toBeVisible()
      await page.getByTestId('daemon-settings').click()
      await expect(page.getByTestId('management-loading')).not.toBeVisible()
    }
    if (area === 'passwords') {
      // The saved sign-in opens, and its password shows only when asked.
      await page.locator('[data-testid^="password-"]').first().click()
      await expect(page.getByTestId('management-loading')).not.toBeVisible({ timeout: 30000 })
      await expect(page.getByTestId('field-username')).toHaveValue('alex')
      await page.getByTestId('action-show-password').click()
      await expect(page.getByText('mobile-secret-42', { exact: true })).toBeVisible()
      await settle()
      await shot('password')
      await page.getByTestId('management-sheet-back').click()
    }
    if (area === 'plugins') {
      // Gmail's panel says who is signed in, and Disconnect shows it at once.
      await page.getByTestId('plugin-connector:gmail').click()
      await expect(page.getByTestId('management-loading')).not.toBeVisible({ timeout: 30000 })
      await expect(page.getByTestId('manage-connector')).toContainText('Account')
      await page.getByTestId('manage-connector').click()
      await expect(page.getByText('Signed in as alex@example.com', { exact: true })).toBeVisible()
      await settle()
      await shot('google-account')
      page.once('dialog', dialog => void dialog.accept())
      await page.getByTestId('action-disconnect').click()
      await expect(page.getByText('Not connected', { exact: true })).toBeVisible()
      await expect(page.getByTestId('action-disconnect')).toHaveCount(0)
      // Not connected, it offers the account's other connectors to connect
      // with the same sign-in, and the bots that get it.
      await expect(page.getByTestId('account-also-google_calendar-row')).toBeVisible()
      await page.getByTestId('management-sheet-back').click()
      await page.getByTestId('management-sheet-back').click()
      // Microsoft shows its code first, and opens its page only when asked.
      const opened = []
      const popups = popup => {
        opened.push(popup.url())
        void popup.close()
      }
      page.on('popup', popups)
      await page.getByTestId('plugin-connector:outlook').click()
      await expect(page.getByTestId('management-loading')).not.toBeVisible({ timeout: 30000 })
      await expect(page.getByTestId('manage-connector')).toContainText('Connect')
      await page.getByTestId('manage-connector').click()
      await page.getByTestId('account-microsoft-sign-in').click()
      await expect(page.getByTestId('account-code')).toContainText('HXBT-4821')
      await expect(
        page.getByText('Copy the code, then sign in on the Microsoft page.')
      ).toBeVisible()
      await settle()
      assert.deepEqual(opened, [])
      await shot('microsoft-code')
      await page.getByTestId('action-copy-code-and-open-microsoft').click()
      await expect.poll(() => opened.length).toBe(1)
      await page.getByTestId('action-stop-signing-in').click()
      await expect(page.getByTestId('account-code')).toHaveCount(0)
      page.off('popup', popups)
      await page.getByTestId('management-sheet-back').click()
      await page.getByTestId('management-sheet-back').click()
      // One plugin card chooses the bots that get it.
      await page.getByTestId('plugin-skill:github').click()
      await expect(page.getByTestId('management-loading')).not.toBeVisible({ timeout: 30000 })
      await settle()
      await shot('plugin')
      await page.getByTestId('plugin-bot-owl').click()
      await expect
        .poll(async () =>
          (await rpc('hexbot.plugins.list')).skills
            .find(p => p.id === 'github')
            .bots.includes('owl')
        )
        .toBe(false)
      await page.getByTestId('management-sheet-back').click()
      await page.getByTestId('manage-mcp').click()
      await page.getByTestId('field-name').fill('calendar')
      await page.getByTestId('mcp-http').click()
      await page.getByTestId('field-url').fill('https://mcp.example.com')
      await page.getByTestId('field-skill').fill('Check the calendar before you plan a meeting.')
      await settle()
      await shot('mcp')
      await page.getByTestId('management-sheet-action').click()
      // The server's card takes the token it needs.
      await page.getByTestId('plugin-package:calendar').click()
      await expect(page.getByTestId('management-loading')).not.toBeVisible({ timeout: 30000 })
      await page.getByTestId('field-new_key').fill('Authorization')
      await page.getByTestId('field-new_value').fill('Bearer mobile-token-1234')
      await page.getByTestId('action-save-values').click()
      await expect
        .poll(async () =>
          (await rpc('hexbot.plugins.list')).packages.find(p => p.id === 'calendar').server
            .headers
        )
        .toEqual([{ key: 'Authorization', set: true, hint: '…1234' }])
      await settle()
      await shot('plugin-server')
      await page.getByTestId('action-remove-authorization').click()
      await expect
        .poll(async () =>
          (await rpc('hexbot.plugins.list')).packages.find(p => p.id === 'calendar').server
            .headers
        )
        .toEqual([])
      await page.getByTestId('management-sheet-back').click()
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
  await back()
  await page.getByTestId('home-library').click()
  await settle()
  await shot('library')
  await page.getByTestId('library-jobs').click()
  await page.getByTestId('manage-job-create').click()
  await page.getByTestId('field-name').fill('Mobile morning brief')
  await page.getByTestId('field-prompt').fill('Write my brief')
  await page.getByTestId('management-sheet-action').click()
  await expect.poll(async () => (await rpc('hexbot.jobs.list', { bot: 'owl' })).jobs.length).toBe(1)
  const job = (await rpc('hexbot.jobs.list', { bot: 'owl' })).jobs[0]
  // Editing a job keeps its schedule unless the schedule itself changed.
  await page.getByTestId(`job-${job.id}`).click()
  await page.getByTestId('field-schedule').fill('in 30m')
  await page.getByTestId('management-sheet-action').click()
  await expect
    .poll(async () => (await rpc('hexbot.jobs.list', { bot: 'owl' })).jobs[0].schedule.display)
    .toBe('in 30m')
  await page.getByTestId(`job-${job.id}`).click()
  await page.getByTestId('field-name').fill('Mobile brief')
  await page.getByTestId('management-sheet-action').click()
  await expect
    .poll(async () => (await rpc('hexbot.jobs.list', { bot: 'owl' })).jobs[0].name)
    .toBe('Mobile brief')
  const updates = sent.filter(m => m.method === 'hexbot.jobs.update').map(m => m.params)
  assert.equal(updates.length, 2)
  assert.equal(updates[0].schedule, 'in 30m')
  assert(!('schedule' in updates[1]), 'A name change leaves the schedule out')
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
  await back()
  await shot('home')
  await page.getByTestId('home-new').click()
  await expect(page.getByTestId('home-new-menu')).toBeVisible()
  await settle()
  await shot('home-new')
  await page.getByTestId('home-new-bot').click()
  await expect(page.getByTestId('field-name')).toBeVisible()
  await settle()
  await shot('bot-new')
  await page.getByTestId('management-sheet-close').click()
  await expect(page.getByTestId('management-sheet')).not.toBeVisible()
  await page.getByTestId('bot-row-owl').click()
  // The chat opens at its newest message, and the list draws only the
  // messages near it: scroll up to the first reply and the visual.
  const scrolledTo = async locator => {
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 30000 })
    await expect
      .poll(
        async () => {
          if (await locator.isVisible()) return true
          await page.mouse.move(196, 400)
          await page.mouse.wheel(0, -1500)
          return false
        },
        { timeout: 30000 }
      )
      .toBe(true)
  }
  await scrolledTo(
    message('Your daemon received this from mobile. The connection is working.', {
      exact: true
    })
  )
  await scrolledTo(page.locator('[data-testid^="visual-open-"]').first())
  await page.locator('[data-testid^="visual-open-"]').first().click()
  await expect(page.frameLocator('iframe').getByText('42 completed tasks')).toBeVisible()
  await page.getByTestId('visual-sheet-close').click()
  // A reload keeps metadata, but the browser preview intentionally has no persistent secrets.
  // Reconnect the same client by disconnecting and selecting its saved target.
  await back()
  await page.getByTestId('home-settings').click()
  await page.getByTestId('daemon-disconnect').click()
  await expect(page.getByTestId('connection-screen')).toBeVisible()
  await shot('connection-saved')
  await page.locator('[data-testid^="connection-saved-"]').first().click()
  await expect(page.getByTestId('bot-row-owl')).toBeVisible({ timeout: 30000 })
  await page.getByTestId('bot-row-owl').click()
  await expect(
    message('Your daemon received this from mobile. The connection is working.', {
      exact: true
    })
  ).toBeVisible({ timeout: 30000 })
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
      'batched questions, multiple choices and explicit retention of attached files',
      'sandboxed bot visual',
      'attachment-only send delivered to Pi, clears chips after acceptance, and leaves out a file staged by another app',
      'retained paired-app upload keeps its bytes and submits exactly once without the mobile file',
      'approval gates a real file write',
      'email draft card the user edits and sends, with a comma in a name',
      'Gmail and Outlook account panels: disconnect, connect with others, and a code before the page',
      'chat list, and one chat per bot opened from its row',
      'a long press pins a chat and renames it from its face',
      'model menu lists connected providers from their live lists and shows the level the model runs at',
      'tool card',
      'heartbeat checklist, a run the card follows to its end, and its message in the chat',
      'soul editing',
      'a face picked on its page and saved with its picture',
      'isolated bot memory',
      'About you',
      'daemon management panels and unlimited room turn budget',
      'skill creation',
      'rooms in the chat list, archive and restore from All rooms',
      'scheduled jobs, edits that keep the schedule, and pause',
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
  await writeFile(
    path.join(artifacts, 'model-requests.json'),
    JSON.stringify(modelRequests, null, 2) + '\n'
  )
  await writeFile(path.join(artifacts, 'daemon.log'), daemonLog)
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
