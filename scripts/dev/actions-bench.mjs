// How long the list's actions and a switch to a bot take to show, from the
// click to the painted frame: Pin and Unpin, Rename, Mark as read, and a switch
// to a bot whose chat is not open yet until its message box takes typing.
// Production web bundle + real daemon + pinned Pi + a local model. No live
// Hexbot state.
//
// Build the daemon and web bundle, then run: node scripts/dev/actions-bench.mjs
//
//   BOTS=8          bots in the list
//   ROUNDS=10       times each action runs (Pin and Unpin count once each)
//   RELOADS=3       app restarts, each switching to every other bot once
//   LATENCY_MS=0    added one-way delay on every daemon frame (LAN 2, Tailscale 30, Connect 60)
//   CPU=1           CPU slowdown (4 is a slow laptop)
//   WEB_DIST=…      another web build to measure, such as main's
//   HEXBOT_BIN=…    another daemon build, such as target/release/hexbot
//   BENCH_OUT=…     write every sample as JSON
//   DIAG_OUT=…      write the daemon's diagnostics, with its SQL timings, as JSON
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { chromium } = require('@playwright/test')
const binary = process.env.HEXBOT_BIN ?? path.join(root, 'backend/hexbot-core/target/debug/hexbot')
const pi = path.join(root, 'backend/pi-runtime/node_modules/.bin/pi')
const number = (name, fallback) => Number(process.env[name] ?? fallback)
const BOTS = number('BOTS', 8)
const ROUNDS = number('ROUNDS', 10)
const RELOADS = number('RELOADS', 3)
const LATENCY_MS = number('LATENCY_MS', 0)
const CPU = number('CPU', 1)
const WEB_DIST = process.env.WEB_DIST ?? path.join(root, 'apps/web/dist')
const home = await mkdtemp(path.join(tmpdir(), 'hexbot-actions-bench-'))
const workspace = await mkdtemp(path.join(tmpdir(), 'hexbot-actions-workspace-'))
let daemon, browser, socket
let log = ''

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
const summary = values => ({
  n: values.length,
  p50: Math.round(percentile(values, 50)),
  p95: Math.round(percentile(values, 95)),
  max: Math.round(Math.max(...values))
})

// Answers every turn at once; the bench never waits on a model.
const model = http.createServer(async (request, response) => {
  if (request.url?.endsWith('/models')) {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'test-model' }] }))
    return
  }
  for await (const _ of request);
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const frame = (delta, finish_reason = null) =>
    JSON.stringify({ id: 'bench', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })
  response.write(`data: ${frame({ role: 'assistant', content: 'Bench reply.' })}\n\n`)
  response.write(`data: ${frame({}, 'stop')}\n\n`)
  response.end('data: [DONE]\n\n')
})

// From an action to the painted frame where `check` first holds.
const timeUntil = async (page, action, check, args) =>
  page.evaluate(
    async ({ action, check, args }) => {
      const act = new Function('args', action)
      const holds = new Function('args', check)
      const painted = () =>
        new Promise(resolve =>
          requestAnimationFrame(() => {
            const channel = new MessageChannel()
            channel.port1.onmessage = () => resolve(performance.now())
            channel.port2.postMessage(null)
          })
        )
      const start = performance.now()
      act(args)
      for (;;) {
        const at = await painted()
        if (holds(args)) return at - start
        if (at - start > 20_000) throw new Error(`Never happened: ${check}`)
      }
    },
    { action, check, args }
  )

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
  const env = { ...process.env, HEXBOT_HOME: home, HEXBOT_PI_EXECUTABLE: pi, HEXBOT_WEB_DIST: WEB_DIST }
  await access(path.join(WEB_DIST, 'index.html'))
  daemon = spawn(binary, ['serve', '--host', '127.0.0.1', '--port', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  daemon.stderr.on('data', data => (log += data))
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Daemon readiness: ${log}`)), 30_000)
    daemon.on('exit', code => reject(new Error(`Daemon exited ${code}: ${log}`)))
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
  socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/ws?token=${encodeURIComponent(token)}`)
  const pending = new Map()
  let nextId = 0
  socket.addEventListener('message', event => {
    for (const line of String(event.data).split('\n').filter(Boolean)) {
      const reply = JSON.parse(line)
      pending.get(reply.id)?.(reply)
      pending.delete(reply.id)
    }
  })
  await once(socket, 'open')
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, reply => (reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.result)))
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  await rpc('hexbot.settings.set', {
    patch: { workspace_dir: workspace, dream_enabled: false, approval_mode: 'off', default_model: 'lmstudio/test-model', billing_notice_ack: true }
  })
  const bots = []
  for (let i = 0; i < BOTS; i++) {
    const name = `bench${i}`
    const { section } = await rpc('hexbot.bots.create', {
      name,
      display_name: `Bench ${i}`,
      model: 'test-model',
      provider: 'lmstudio',
      persona: `You are Bench ${i}.`,
      tools: []
    })
    await writeFile(
      path.join(home, `profiles/${name}/config.yaml`),
      `model:\n  provider: lmstudio\n  default: test-model\n  api_key: fixture\n  base_url: ${modelBase}\ntools:\n  enabled_toolsets: []\napproval_mode: off\n`
    )
    bots.push({ name, section: section.id })
  }
  // Every chat sees one turn, so each has history and Mark as read has a finished turn to clear.
  for (const bot of bots) {
    const { section } = await rpc('hexbot.sections.open', { id: bot.section })
    const live = section.live_session_id ?? bot.section
    await rpc('prompt.submit', { session_id: live, text: 'Hello' })
  }
  for (let tries = 0; ; tries++) {
    const { bots: listed } = await rpc('hexbot.bots.list')
    if (listed.every(bot => bot.status === 'idle')) break
    assert(tries < 200, 'seed turns finish')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  // Close every Pi session: a switch then finds the chat as a freshly started app does.
  const closeAll = async () => {
    for (const bot of bots) await rpc('hexbot.sections.close', { id: bot.section }).catch(() => undefined)
  }
  await closeAll()

  const code = /^Pairing code: (\S+)/m.exec((await promisify(execFile)(binary, ['pair'], { env })).stdout)?.[1]
  assert(code)
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
  page.setDefaultTimeout(30_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  if (LATENCY_MS) {
    await page.routeWebSocket(/\/api\/ws\?/, ws => {
      const server = ws.connectToServer()
      ws.onMessage(message => setTimeout(() => server.send(message), LATENCY_MS))
      server.onMessage(message => setTimeout(() => ws.send(message), LATENCY_MS))
    })
  }
  if (CPU > 1) {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })
  }
  await page.goto(`${base}/login?code=${code}`)
  const settle = async bot => {
    await page.goto(`${base}/b/${bot.name}/s/${bot.section}`)
    await page.locator('#conversation-composer:not([disabled])').waitFor()
    // What a fresh window does in the background before the first click.
    await page.waitForTimeout(2000)
  }
  await settle(bots[0])

  const row = name => `[data-roster-id="bot:${name}"]`
  const menu = async (name, item) => {
    await page.locator(row(name)).first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: item, exact: true }).waitFor()
  }
  const clickItem = `[...document.querySelectorAll('[role=menuitem]')].find(n => n.textContent.trim() === args.item).click()`
  const inPinned = `document.querySelector('[data-testid="roster-pinned"] ' + args.row)`

  const pin = []
  const unpin = []
  const rename = []
  const read = []
  for (let round = 0; round < ROUNDS; round++) {
    const bot = bots[1 + (round % (BOTS - 1))]
    await menu(bot.name, 'Pin')
    pin.push(await timeUntil(page, clickItem, `return Boolean(${inPinned})`, { item: 'Pin', row: row(bot.name) }))
    await page.waitForTimeout(300)
    await menu(bot.name, 'Unpin')
    unpin.push(await timeUntil(page, clickItem, `return !${inPinned}`, { item: 'Unpin', row: row(bot.name) }))
    await page.waitForTimeout(300)

    const name = `Bench ${bot.name.slice(5)} r${round}`
    await menu(bot.name, 'Rename…')
    await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name)
    await page.getByRole('button', { name: 'Rename', exact: true }).evaluate(node => node.setAttribute('data-bench', 'rename'))
    rename.push(
      await timeUntil(
        page,
        `document.querySelector('[data-bench=rename]').click()`,
        `return ![...document.querySelectorAll('[role=dialog][data-open]')].some(node => node.textContent.includes('Rename bot')) &&
          document.querySelector(args.row)?.textContent.includes(args.name)`,
        { row: row(bot.name), name }
      )
    )
    await page.waitForTimeout(300)
  }
  // Mark as read: each chat's finished turn, once; it clears as the dot goes.
  for (const bot of bots.slice(1)) {
    if (!(await page.locator(`${row(bot.name)} [data-status="done"]`).count())) continue
    await menu(bot.name, 'Mark as read')
    read.push(
      await timeUntil(page, clickItem, `return !document.querySelector(args.row + ' [data-status="done"]')`, {
        item: 'Mark as read',
        row: row(bot.name)
      })
    )
    await page.waitForTimeout(300)
  }

  // A switch to a bot whose Pi session is not running, as after starting the
  // app: until its message box takes typing, and until its history shows.
  const switchTyping = []
  for (let reload = 0; reload < RELOADS; reload++) {
    await closeAll()
    await settle(bots[0])
    for (const bot of bots.slice(1)) {
      switchTyping.push(
        await timeUntil(
          page,
          `document.querySelector(args.row).click()`,
          `const field = document.getElementById('conversation-composer')
           return Boolean(field && !field.disabled && location.pathname.startsWith('/b/' + args.name + '/'))`,
          { row: row(bot.name), name: bot.name }
        )
      )
      await page.waitForTimeout(400)
    }
  }

  // What the daemon itself spent on each request the actions made.
  const diagnostics = await rpc('hexbot.diagnostics.get')
  if (process.env.DIAG_OUT) await writeFile(process.env.DIAG_OUT, JSON.stringify(diagnostics, null, 2))
  const names = diagnostics.spans?.names ?? []
  const daemonMs = Object.fromEntries(
    names
      .filter(entry =>
        ['hexbot.bots.pin', 'hexbot.bots.update', 'hexbot.bots.list', 'hexbot.sections.mark_read', 'hexbot.sections.open', 'hexbot.sections.list'].includes(entry.name)
      )
      .map(entry => [entry.name, { n: entry.count, avg: Math.round(entry.avg_ms * 10) / 10, p95: Math.round(entry.p95_ms * 10) / 10 }])
  )

  const report = {
    setup: { BOTS, ROUNDS, RELOADS, LATENCY_MS, CPU, WEB_DIST: path.relative(root, WEB_DIST) },
    pin: summary(pin),
    unpin: summary(unpin),
    rename: summary(rename),
    markRead: read.length ? summary(read) : null,
    switchUntilTyping: summary(switchTyping),
    daemonMs,
    errors
  }
  console.log(JSON.stringify(report, null, 2))
  if (process.env.BENCH_OUT) await writeFile(process.env.BENCH_OUT, JSON.stringify({ report, pin, unpin, rename, read, switchTyping }, null, 2))
  process.exitCode = errors.length ? 1 : 0
} finally {
  await browser?.close()
  socket?.close()
  if (daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM')
    await once(daemon, 'exit')
  }
  model.close()
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
}
