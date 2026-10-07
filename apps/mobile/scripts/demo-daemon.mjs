// A disposable Hexbot daemon for the mobile app: Rust daemon + pinned Pi +
// a local streaming model, seeded with bots, sections and a room. No provider
// credentials needed. State lives in a temp home, never ~/.hexbot.
//
// Build first:  cargo build --manifest-path backend/hexbot-core/Cargo.toml --bin hexbot
//               npm ci --prefix backend/pi-runtime --ignore-scripts
// Usage:        node apps/mobile/scripts/demo-daemon.mjs [--port 9339] [--lan] [--home DIR]
// It prints the address and a pairing code, then keeps running until Ctrl-C.
// With --home the state is kept: a second run reuses the bots and paired
// phones (they reconnect on their own) and skips seeding.
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const port = Number(option('--port') ?? 9339)
const lan = flag('--lan')
const daemonPath = process.env.HEXBOT_DEMO_DAEMON || path.join(root, 'backend/hexbot-core/target/debug/hexbot')
const piPath = process.env.HEXBOT_TEST_PI || path.join(root, 'backend/pi-runtime/node_modules/.bin/pi')
const keep = Boolean(option('--home'))
const home = keep ? path.resolve(option('--home')) : await mkdtemp(path.join(tmpdir(), 'hexbot-mobile-demo-'))
if (path.resolve(home) === path.join(process.env.HOME ?? '', '.hexbot')) throw new Error('Never point the demo daemon at ~/.hexbot.')
const workspace = keep ? path.join(path.dirname(home), `${path.basename(home)}-workspace`) : await mkdtemp(path.join(tmpdir(), 'hexbot-mobile-demo-workspace-'))
await mkdir(home, { recursive: true })
await mkdir(workspace, { recursive: true })
const seeded = await access(path.join(home, 'hexbot.db')).then(() => true, () => false)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function textOf(value) {
  return typeof value === 'string' ? value : Array.isArray(value) ? value.map(block => block.text || '').join('\n') : ''
}

// Replies are keyed off the prompt so a demo reads naturally.
function answerFor(prompt, system) {
  const p = prompt.toLowerCase()
  const bot = /You are (\w+)/.exec(system)?.[1] ?? 'your bot'
  if (prompt.startsWith('Room: ')) {
    if (prompt.includes('Replies to collect:')) return 'Room complete. The plan is ready.'
    return prompt.includes('You are @coach.') ? 'Coach here: keep the sessions short and regular.' : '@coach Can you add a training note?'
  }
  if (p.includes('vpn')) return 'WireGuard is the simplest choice here.\n\n1. Install it on the router\n2. Add a peer for each device\n3. Allow UDP **51820** on the firewall\n\n```sh\nwg genkey | tee privatekey | wg pubkey > publickey\n```'
  if (p.includes('notion')) return 'I added the reading list to your **Notion** inbox and tagged it `later`.'
  if (p.includes('train') || p.includes('run')) return 'A good week: three easy runs, one long run on Sunday, and a rest day after it.'
  if (p.includes('study') || p.includes('exam')) return 'Spaced repetition works best. Review today, then in 2, 5 and 12 days.'
  if (p.includes('research') || p.includes('paper')) return 'I found three recent papers. The 2026 survey is the best place to start; it compares all the methods in one table.'
  if (/\b(hello|hi|hey)\b/.test(p)) return `Hi, I'm ${bot}. What are we working on today?`
  return `Here is a short answer from ${bot}.\n\n- It streams from a local model\n- It renders **Markdown**\n- It keeps the prompt cache warm`
}

// Fixture behaviours for the phone's chat screens, keyed off the prompt:
//   "disk" / "command"  the bot saves `df -h` to a report through bash (Network has a terminal and is
//                       in Manual mode, so an approval card appears first)
//   "dinner" / "ask me" the bot asks a clarify question with three choices
//   "markdown"          a reply with every Markdown block the renderer draws
//   "slow"              a long pause before the reply, to see the live status
//   "fail"              the provider refuses the request, to see the Stopped card
const RICH = [
  '## Weekend checklist',
  '',
  'Here is everything in **one place**, with a little *emphasis* and some `inline code`.',
  '',
  '1. Pack the bags',
  '2. Book the train',
  '   - Window seat',
  '   - Quiet carriage',
  '3. Water the plants',
  '',
  '> Leave before 9 to miss the traffic.',
  '',
  '| Day | Plan | Time |',
  '| --- | --- | --- |',
  '| Sat | Hike | 3h |',
  '| Sun | Museum | 2h |',
  '',
  '```ts',
  "const trip = await plan({ from: 'Auckland', to: 'Wellington', nights: 2 })",
  'console.log(trip.summary)',
  '```',
  '',
  'More at [hexbot.app](https://hexbot.app).'
].join('\n')

function toolReply(name, output) {
  if (name === 'clarify') {
    const choice = String(output).trim() || 'that'
    return `${choice} it is. I will book a table for two at 7 and send you the address.`
  }
  const lines = String(output).split('\n').filter(Boolean)
  return `The disk has plenty of room.\n\n\`\`\`\n${lines.slice(0, 4).join('\n') || 'Filesystem  Size  Used  Avail'}\n\`\`\`\n\nNothing needs cleaning up.`
}

const model = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'demo-model', object: 'model', owned_by: 'local' }] }))
    return
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  const messages = body.messages ?? []
  const last = messages.at(-1)
  const prompt = textOf(messages.findLast(m => m.role === 'user')?.content)
  const system = textOf(messages.find(m => m.role === 'system')?.content)
  const tools = new Set((body.tools ?? []).map(tool => tool.function?.name ?? tool.name))
  const p = prompt.toLowerCase()
  const pace = Number(process.env.HEXBOT_DEMO_PACE_MS ?? 40)
  const frame = (delta, finish_reason = null) => JSON.stringify({ id: 'demo', object: 'chat.completion.chunk', created: 1, model: 'demo-model', choices: [{ index: 0, delta, finish_reason }] })

  if (p.includes('fail') && last?.role === 'user') {
    if (pace) await sleep(1200)
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'The demo model refused this request.', type: 'invalid_request_error' } }))
    return
  }

  let call = null
  if (last?.role === 'user' && pace) {
    if ((p.includes('disk') || p.includes('command')) && tools.has('bash')) call = { name: 'bash', args: { command: 'df -h / | tee disk-report.txt', full_access: true, reason: 'Saves a disk report in the workspace.' } }
    else if ((p.includes('dinner') || p.includes('ask me')) && tools.has('clarify')) call = { name: 'clarify', args: { question: 'Which kind of dinner tonight?', choices: ['Thai (Recommended)', 'Italian', 'Japanese'] } }
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  if (call) {
    await sleep(1500)
    res.write(`data: ${frame({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] })}\n\n`)
    res.write(`data: ${frame({}, 'tool_calls')}\n\n`)
    res.end('data: [DONE]\n\n')
    return
  }

  let answer
  if (last?.role === 'tool') {
    const asked = messages.findLast(m => m.role === 'assistant' && m.tool_calls?.length)
    answer = toolReply(asked?.tool_calls?.[0]?.function?.name, textOf(last.content))
    if (pace) await sleep(900)
  } else if (p.includes('markdown')) {
    answer = RICH
  } else {
    answer = answerFor(prompt, system)
  }
  const slow = p.includes('slow') && last?.role === 'user' && pace
  if (slow) await sleep(7000)
  const words = answer.split(/(?<=\s)/)
  for (let i = 0; i < words.length; i += 3) {
    res.write(`data: ${frame(i === 0 ? { role: 'assistant', content: words.slice(i, i + 3).join('') } : { content: words.slice(i, i + 3).join('') })}\n\n`)
    if (pace) await sleep(slow ? 220 : pace)
  }
  res.write(`data: ${frame({}, 'stop')}\n\n`)
  res.end('data: [DONE]\n\n')
})

let daemon
let log = ''
async function shutdown(code = 0) {
  daemon?.kill('SIGTERM')
  model.close()
  if (!keep) await rm(home, { recursive: true, force: true }).catch(() => {})
  process.exit(code)
}
process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))
process.on('uncaughtException', error => { console.error(error); console.error(log.slice(-4000)); void shutdown(1) })
process.on('unhandledRejection', error => { console.error(error); console.error(log.slice(-4000)); void shutdown(1) })

model.listen(0, '127.0.0.1')
await once(model, 'listening')
const modelBase = `http://127.0.0.1:${model.address().port}/v1`
// Network gets a terminal (and Manual mode), so a command asks for approval.
const profileConfigFor = name => `model:\n  provider: lmstudio\n  default: demo-model\n  api_key: demo-key\n  base_url: ${modelBase}\ntools:\n  enabled_toolsets: [${name === 'network' ? 'terminal' : ''}]\n`
if (!seeded) await writeFile(path.join(home, 'config.yaml'), `model:\n  provider: lmstudio\n  default: demo-model\n  base_url: ${modelBase}\n  api_key: demo-key\n`)
if (!seeded) {
  await mkdir(path.join(home, 'users', 'local'), { recursive: true })
  await writeFile(path.join(home, 'users', 'local', 'user.md'), 'Alex. Builds Hexbot. Likes short answers.')
}
// The model fixture listens on a new port every run; point every profile at it.
async function pointProfilesAtModel() {
  const { readdir } = await import('node:fs/promises')
  await writeFile(path.join(home, 'config.yaml'), `model:\n  provider: lmstudio\n  default: demo-model\n  base_url: ${modelBase}\n  api_key: demo-key\n`)
  for (const name of await readdir(path.join(home, 'profiles')).catch(() => [])) {
    await writeFile(path.join(home, `profiles/${name}/config.yaml`), profileConfigFor(name)).catch(() => {})
  }
}
if (seeded) await pointProfilesAtModel()

const env = { ...process.env, HEXBOT_HOME: home, HEXBOT_PI_EXECUTABLE: piPath }
daemon = spawn(daemonPath, ['serve', '--host', lan ? '0.0.0.0' : '127.0.0.1', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
daemon.stderr.on('data', d => { log += d })
daemon.on('exit', code => { daemon = null; console.error(`Daemon exited (${code}).\n${log.slice(-2000)}`); void shutdown(1) })
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Daemon readiness timed out: ${log}`)), 30_000)
  daemon.stdout.on('data', d => { log += d; if (/HERMES_BACKEND_READY port=\d+/.test(log)) { clearTimeout(timer); resolve() } })
})

const token = (await readFile(path.join(home, 'local-device.token'), 'utf8')).trim()
const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}`)
const pending = new Map()
const listeners = new Set()
let nextId = 0
socket.addEventListener('message', event => {
  for (const line of String(event.data).split('\n').filter(Boolean)) {
    const frame = JSON.parse(line)
    if (frame.method === 'event') { for (const fn of listeners) fn(frame.params); continue }
    const done = pending.get(frame.id)
    if (done) { pending.delete(frame.id); done(frame) }
  }
})
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 60_000)
  pending.set(id, frame => { clearTimeout(timer); frame.error ? reject(new Error(`${method}: ${JSON.stringify(frame.error)}`)) : resolve(frame.result) })
  socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})
const turnDone = sessionId => new Promise(resolve => {
  const fn = params => { if (params.session_id === sessionId && params.type === 'message.complete') { listeners.delete(fn); resolve() } }
  listeners.add(fn)
})

if (!seeded) {
await rpc('hexbot.settings.set', { patch: { workspace_dir: workspace, dream_enabled: false, default_model: 'lmstudio/demo-model', billing_notice_ack: true } })

// Oldest first, so the newest activity ends up on top like a real roster.
const bots = [
  { name: 'network', display_name: 'Network', prompt: 'Why is the office network slow?' },
  { name: 'railway', display_name: 'Railway', prompt: 'Find me the fastest train to Wellington' },
  { name: 'study', display_name: 'Study', prompt: 'How should I study for the exam?' },
  { name: 'school', display_name: 'School', title: 'School', prompt: 'What homework is due this week?' },
  { name: 'coach', display_name: 'Coach', prompt: 'Plan my training week' },
  { name: 'notion', display_name: 'Notion', prompt: 'Save this to Notion: reading list' },
  { name: 'vpn', display_name: 'VPN', title: 'Research', prompt: 'Set up a VPN for the house' },
  { name: 'research', display_name: 'Research', title: 'Research', prompt: 'Research recent papers on prompt caching' }
]
const pace = process.env.HEXBOT_DEMO_PACE_MS
process.env.HEXBOT_DEMO_PACE_MS = '0'
for (const bot of bots) {
  const { section } = await rpc('hexbot.bots.create', { name: bot.name, display_name: bot.display_name, title: bot.title, model: 'demo-model', provider: 'lmstudio', persona: `You are ${bot.display_name}.`, tools: [] })
  await writeFile(path.join(home, `profiles/${bot.name}/config.yaml`), profileConfigFor(bot.name))
  const opened = await rpc('hexbot.sections.open', { id: section.id })
  const sessionId = opened.section.live_session_id
  const done = turnDone(sessionId)
  await rpc('prompt.submit', { session_id: sessionId, text: bot.prompt })
  await done
  await rpc('hexbot.sections.mark_read', { id: section.id }).catch(() => {})
}
await rpc('hexbot.bots.update', { name: 'network', approval_mode: 'manual' })
await rpc('hexbot.rooms.create', { name: 'Weekend plan', members: ['coach', 'study'], main_bot: 'coach' })
if (pace === undefined) delete process.env.HEXBOT_DEMO_PACE_MS; else process.env.HEXBOT_DEMO_PACE_MS = pace
}
socket.close()

const { stdout } = await promisify(execFile)(daemonPath, ['pair'], { env })
const code = /^Pairing code: (\S+)/m.exec(stdout)?.[1]
const lanAddress = Object.values(networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address
await writeFile(path.join(tmpdir(), 'hexbot-mobile-demo.json'), JSON.stringify({ home, port, code, daemonPid: daemon.pid, scriptPid: process.pid }, null, 2))
console.log(`
Hexbot demo daemon is running.
  Home:     ${home}
  Address:  127.0.0.1:${port}  (iOS Simulator)${lan && lanAddress ? `\n            ${lanAddress}:${port}  (a phone on this network)` : ''}
  Code:     ${code}
  Link:     hexbot://pair?host=127.0.0.1&port=${port}#code=${code}
Run \`HEXBOT_HOME=${home} ${path.relative(process.cwd(), daemonPath)} pair\` for another code. ${keep ? 'Ctrl-C stops it; the home is kept.' : 'Ctrl-C stops it and deletes the home.'}
`)
