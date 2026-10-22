// Real Windows standalone runtime, Node/Pi RPC and user task, all in temp state.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)
assert.equal(process.platform, 'win32', 'This probe must run on native Windows')
const bundle = resolve('apps/desktop/resources/hexbot-native')
const root = await mkdtemp(join(tmpdir(), 'hexbot Windows runtime '))
const home = join(root, 'state'); await mkdir(home)
const env = { ...process.env, HEXBOT_HOME: home, HOME: root, USERPROFILE: root, HEXBOT_SERVICE_ROOT: root }
const run = (exe, args) => exec(exe, args, { env, timeout: 300_000, windowsHide: true })
let daemon, selected
async function waitForFile(path, timeout = 30_000) {
  let watcher
  await new Promise((done, reject) => {
    const timer = setTimeout(() => { watcher?.close(); reject(new Error(`Timed out waiting for ${path}`)) }, timeout)
    const check = () => readFile(path).then(() => { clearTimeout(timer); watcher?.close(); done() }).catch(() => {})
    watcher = watch(dirname(path), check); check()
  })
}
try {
  await run(join(bundle, 'hexbot.exe'), ['setup', '--activate', '--json'])
  selected = JSON.parse(await readFile(join(home, 'runtime/native-current.json'), 'utf8')).executable
  assert(selected.endsWith('hexbot.exe'))
  assert.equal((await run(selected, ['version'])).stdout.trim(), JSON.parse(await readFile(join(bundle, 'manifest.json'))).version)
  const directory = dirname(selected)
  assert.equal((await run(join(directory, 'node.exe'), [join(directory, 'pi/launch.mjs'), '--version'])).stdout.trim(), '1.0.1')
  const agent = join(root, 'pi-agent'); await mkdir(agent)
  const pi = spawn(join(directory, 'node.exe'), [join(directory, 'pi/launch.mjs'), '--mode', 'rpc', '--no-approve'], { env: { ...env, PI_CODING_AGENT_DIR: agent }, cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const reply = new Promise((done, reject) => {
    const timer = setTimeout(() => { pi.kill(); reject(new Error('Pi RPC timed out')) }, 30_000)
    let output = ''
    pi.stdout.on('data', chunk => { output += chunk; if (output.includes('contract-state')) { clearTimeout(timer); done() } })
    pi.once('error', error => { clearTimeout(timer); reject(error) })
  })
  pi.stdin.write(`${JSON.stringify({ id: 'contract-state', type: 'get_state' })}\n`)
  try { await reply } finally { pi.kill(); await once(pi, 'exit') }
  const python = join(home, 'runtime/tools/code-python/Scripts/python.exe')
  assert.equal((await run(python, ['-c', 'print(6 * 7)'])).stdout.trim(), '42')
  // Task creation uses the actual user's SID while its files and daemon state
  // are isolated. The hosted runner is disposable, not a standard-user claim.
  await run(selected, ['service', 'install'])
  await waitForFile(join(home, 'serve-state.json'))
  const state = JSON.parse(await readFile(join(home, 'serve-state.json'), 'utf8'))
  const page = await fetch(`http://127.0.0.1:${state.port}/`, { signal: AbortSignal.timeout(10_000) })
  assert.equal(page.status, 200)
  assert.equal(JSON.parse((await run(selected, ['service', 'status', '--json'])).stdout).running, true)
  await run(selected, ['service', 'stop'])
  await run(selected, ['service', 'uninstall'])
  console.log('Windows standalone setup, real Node/Pi RPC, Python, web and user task passed')
} finally {
  if (selected) await run(selected, ['service', 'uninstall']).catch(() => {})
  daemon?.kill()
  await rm(root, { recursive: true, force: true })
}
