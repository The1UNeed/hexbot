// How long switching between bots takes, from the click to the other chat on
// screen. Production web bundle + real daemon + pinned Pi + a local model, with
// bots whose chats are as long as real ones. No live Hexbot state.
//
// Build the daemon and web bundle, then run: node scripts/dev/switch-bench.mjs
//
//   BOTS=8          bots to switch between
//   TURNS=25        turns seeded in each chat, 8 rows each
//   ROW_KB=12       average tool result in KB (real chats here: about 3.5 MB at 25 turns and ROW_KB=40)
//   SWITCHES=120    measured switches after every bot was opened once
//   LATENCY_MS=0    added one-way delay on every daemon frame (LAN 2, Tailscale 30, Connect 60)
//   CPU=1           CPU slowdown (4 is a slow laptop)
//   BUDGET_MS=100   p99 to pass
//   WEB_DIST=…      another web build to measure, such as main's
//   PROFILE=1       print where switching spends CPU (build with --minify false for names)
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { chromium } = require('@playwright/test')
const binary = path.join(root, 'backend/hexbot-core/target/debug/hexbot')
const pi = path.join(root, 'backend/pi-runtime/node_modules/.bin/pi')
const number = (name, fallback) => Number(process.env[name] ?? fallback)
const BOTS = number('BOTS', 8)
const TURNS = number('TURNS', 25)
const ROW_KB = number('ROW_KB', 12)
const SWITCHES = number('SWITCHES', 120)
const LATENCY_MS = number('LATENCY_MS', 0)
const CPU = number('CPU', 1)
const BUDGET_MS = number('BUDGET_MS', 100)
// Another build of the web bundle, such as main's, to compare against.
const WEB_DIST = process.env.WEB_DIST ?? path.join(root, 'apps/web/dist')
const home = await mkdtemp(path.join(tmpdir(), 'hexbot-switch-bench-'))
const workspace = await mkdtemp(path.join(tmpdir(), 'hexbot-switch-workspace-'))
let daemon, browser, socket
let log = ''

// Deterministic filler, so runs compare.
let seed = 7
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const words = 'the bot reads a page and keeps what matters for later when you ask again about it'
  .split(' ')
const prose = length => {
  let text = ''
  while (text.length < length) text += words[Math.floor(random() * words.length)] + ' '
  return text.slice(0, length)
}
const answer = (bot, turn, last) =>
  [
    `## Turn ${turn}`,
    prose(300),
    '',
    `- ${prose(80)}`,
    `- ${prose(80)}`,
    `- **${prose(20)}** ${prose(60)}`,
    '',
    '```ts',
    `export function step${turn}(input: string): string {`,
    `  return input.trim() // ${prose(40)}`,
    '}',
    '```',
    '',
    '| Option | Notes |',
    '| --- | --- |',
    `| A | ${prose(40)} |`,
    `| B | ${prose(40)} |`,
    '',
    prose(400),
    last ? `\nSwitch marker ${bot}.` : ''
  ].join('\n')

function seedHistory(database, bot, section) {
  const insert = database.prepare(
    'INSERT INTO native_messages(session_id, seq, message_json) VALUES (?, ?, ?)'
  )
  let seq = 0
  let at = Date.now() / 1000 - TURNS * 600
  const row = message => {
    at += 5
    insert.run(section, ++seq, JSON.stringify({ timestamp: at, row_id: `${section}-${seq}`, ...message }))
  }
  for (let turn = 1; turn <= TURNS; turn++) {
    const turnId = `${section}-turn-${turn}`
    const text = prose(300)
    row({ role: 'user', display_kind: 'normal', text, content: [{ type: 'text', text }], turn_id: turnId })
    for (let call = 0; call < 3; call++) {
      const id = `functions.web_search:${turn}-${call}`
      row({
        role: 'assistant',
        turn_id: turnId,
        reasoning: prose(800),
        text: call ? '' : prose(180),
        stop_reason: 'toolUse',
        tool_calls: [
          {
            id,
            type: 'function',
            function: { name: 'web_search', arguments: JSON.stringify({ query: prose(60), limit: 8 }) }
          }
        ]
      })
      const result = prose(Math.round(ROW_KB * 1024 * (0.3 + random() * 1.4)))
      row({
        role: 'tool',
        turn_id: turnId,
        name: 'web_search',
        tool_name: 'web_search',
        tool_id: id,
        tool_call_id: id,
        context: prose(60),
        is_error: false,
        nested_calls: { calls: null },
        text: result,
        content: [{ type: 'text', text: result }]
      })
    }
    row({ role: 'assistant', turn_id: turnId, reasoning: prose(500), stop_reason: 'stop', text: answer(bot, turn, turn === TURNS) })
  }
  return seq
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
const summary = values => ({
  n: values.length,
  p50: Math.round(percentile(values, 50)),
  p95: Math.round(percentile(values, 95)),
  p99: Math.round(percentile(values, 99)),
  max: Math.round(Math.max(...values))
})

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
  const database = new DatabaseSync(path.join(home, 'hexbot-runtime.db'))
  database.exec('PRAGMA busy_timeout = 10000')
  let bytes = 0
  for (const bot of bots) {
    seedHistory(database, bot.name, bot.section)
    bytes += database.prepare('SELECT SUM(LENGTH(message_json)) AS n FROM native_messages WHERE session_id = ?').get(bot.section).n
  }
  database.close()
  // The history really reads back, so the seed matches what the app gets.
  const opened = await rpc('hexbot.sections.open', { id: bots[0].section })
  assert(opened.messages.at(-1).text.includes(`Switch marker ${bots[0].name}.`), 'seeded history reads back')
  console.log(`${BOTS} bots, ${opened.messages.length} rows and ${(bytes / BOTS / 1024 / 1024).toFixed(1)} MB a chat`)

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
  await page.goto(`${base}/b/${bots[0].name}/s/${bots[0].section}`)
  await page.getByTestId('bot-message').filter({ hasText: `Switch marker ${bots[0].name}.` }).waitFor()
  await page.locator('#conversation-composer:not([disabled])').waitFor()
  // What a fresh window does in the background before the first click.
  await page.waitForTimeout(3000)

  // From the click to the frame that paints the other chat's last message, and
  // to its composer taking input. Long tasks in the second after count as jank.
  const measure = name =>
    page.evaluate(async name => {
      const marker = `Switch marker ${name}.`
      const row = document.querySelector(`[data-roster-id="bot:${name}"]`)
      if (!row) throw new Error(`No roster row for ${name}`)
      const longTasks = []
      const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)))
      try {
        observer.observe({ type: 'longtask', buffered: false })
      } catch {}
      const painted = () =>
        new Promise(resolve => requestAnimationFrame(() => {
          const channel = new MessageChannel()
          channel.port1.onmessage = () => resolve(performance.now())
          channel.port2.postMessage(null)
        }))
      const shown = () =>
        [...document.querySelectorAll('[data-testid="bot-message"]')].some(node =>
          node.textContent.includes(marker)
        )
      const composerReady = () => {
        const composer = document.getElementById('conversation-composer')
        return composer && !composer.disabled && location.pathname.startsWith(`/b/${name}/`)
      }
      const start = performance.now()
      row.click()
      let visible, ready
      while (visible === undefined || ready === undefined) {
        const at = await painted()
        if (visible === undefined && shown()) visible = at - start
        if (ready === undefined && composerReady()) ready = at - start
        if (at - start > 20_000) throw new Error(`Switch to ${name} never finished`)
      }
      // A later history read that redraws the chat is jank the user sees.
      await new Promise(resolve => setTimeout(resolve, 1000))
      observer.disconnect()
      return { visible, ready, jank: longTasks.reduce((sum, d) => sum + d, 0), longest: Math.max(0, ...longTasks) }
    }, name)

  let profiler
  if (process.env.PROFILE) {
    profiler = await page.context().newCDPSession(page)
    await profiler.send('Profiler.enable')
    await profiler.send('Profiler.setSamplingInterval', { interval: 200 })
  }
  const cold = []
  for (const bot of bots.slice(1)) cold.push(await measure(bot.name))
  const warm = []
  let current = bots.at(-1).name
  if (profiler) await profiler.send('Profiler.start')
  for (let i = 0; i < SWITCHES; i++) {
    let next
    do next = bots[Math.floor(random() * bots.length)].name
    while (next === current)
    warm.push(await measure(next))
    current = next
  }
  // A restarted app: what the disk kept shows, and the background read catches up.
  await page.reload()
  await page.getByTestId('bot-message').filter({ hasText: `Switch marker ${current}.` }).waitFor()
  await page.waitForTimeout(3000)
  const reloaded = []
  for (const bot of bots.filter(bot => bot.name !== current)) reloaded.push(await measure(bot.name))
  if (profiler) {
    const { profile } = await profiler.send('Profiler.stop')
    const self = new Map()
    const byId = new Map(profile.nodes.map(node => [node.id, node]))
    const dt = new Map()
    profile.samples.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)))
    for (const [id, time] of dt) {
      const { functionName, url, lineNumber } = byId.get(id).callFrame
      const key = `${functionName || '(anon)'} ${url.split('/').pop()}:${lineNumber}`
      self.set(key, (self.get(key) ?? 0) + time / 1000)
    }
    const total = [...self.values()].reduce((a, b) => a + b, 0)
    console.log('profile self time (ms per switch):')
    for (const [key, time] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 40))
      console.log((time / SWITCHES).toFixed(1).padStart(7), key)
    console.log('total', (total / SWITCHES).toFixed(1))
    if (process.env.PROFILE_OUT) await writeFile(process.env.PROFILE_OUT, JSON.stringify(profile))
  }
  const report = {
    setup: { BOTS, TURNS, ROW_KB, LATENCY_MS, CPU },
    firstOpen: { visible: summary(cold.map(r => r.visible)), ready: summary(cold.map(r => r.ready)) },
    afterReload: { visible: summary(reloaded.map(r => r.visible)), ready: summary(reloaded.map(r => r.ready)) },
    switches: {
      visible: summary(warm.map(r => r.visible)),
      ready: summary(warm.map(r => r.ready)),
      longTaskMsPerSwitch: summary(warm.map(r => r.jank)),
      longestTask: summary(warm.map(r => r.longest))
    },
    errors
  }
  console.log(JSON.stringify(report, null, 2))
  if (process.env.BENCH_OUT) await writeFile(process.env.BENCH_OUT, JSON.stringify({ report, cold, warm, reloaded }, null, 2))
  const p99 = Math.max(report.switches.visible.p99, report.firstOpen.visible.p99, report.afterReload.visible.p99)
  console.log(p99 <= BUDGET_MS ? `PASS p99 ${p99} ms <= ${BUDGET_MS} ms` : `FAIL p99 ${p99} ms > ${BUDGET_MS} ms`)
  process.exitCode = p99 <= BUDGET_MS && !errors.length ? 0 : 1
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
