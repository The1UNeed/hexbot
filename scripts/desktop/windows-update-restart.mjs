// Native restart boundary: two debug fixture versions, signed ZIP, real task job.
// The existing public test key is trusted only by debug builds. No release keys.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { makeNativeUpdate } from './make-native-update.mjs'
import { setVersion } from './set-version.mjs'
import { signature, testKey } from './update-signing.mjs'
import { waitForRuntimeJson as waitJson } from './runtime-file.mjs'
const exec = promisify(execFile)
assert.equal(process.platform, 'win32')
assert.equal(resolve(process.env.HEXBOT_WINDOWS_PROBE_SOURCE ?? ''), process.cwd(), 'Only run in the helper-created disposable worktree')
assert(!(await readFile('backend/hexbot-core/src/lib.rs', 'utf8')).includes('compile_error!("The Hexbot daemon supports macOS and Linux only");'))
const root = await mkdtemp(join(tmpdir(), 'hexbot signed Windows restart '))
const user = join(root, 'Jos\u00e9 user'); await mkdir(user)
const home = join(user, 'state'); await mkdir(home)
const env = { ...process.env, HEXBOT_HOME: home, HOME: user, USERPROFILE: user, HEXBOT_SERVICE_ROOT: user, HEXBOT_CLI_NO_PATH: '1' }
const run = (exe, args) => exec(exe, args, { env, windowsHide: true, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })
const packagePath = resolve('apps/desktop/package.json')
const originalPackage = await readFile(packagePath)
const bundle = resolve('apps/desktop/resources/hexbot-native')
const originalManifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'))
const nextVersion = '999.0.0-windows.contract'
const debugExe = resolve('backend/hexbot-core/target/debug/hexbot.exe')
const files = new Map()
const server = createServer((request, response) => {
  const bytes = files.get(request.url?.slice(1))
  if (!bytes) { response.writeHead(404); response.end(); return }
  response.writeHead(200, { 'Content-Length': bytes.length }); response.end(bytes)
})
let selected, socket

const runningPath = join(home, 'runtime/native-running.json')
const statePath = join(home, 'serve-state.json')
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
async function lockState() {
  const script = "$f = [IO.File]::Open((Join-Path $env:HEXBOT_HOME 'native-daemon.lock'), 'Open', 'ReadWrite', 'ReadWrite,Delete'); try { try { $f.Lock(0,1); $f.Unlock(0,1); 'free' } catch [IO.IOException] { 'held' } } finally { $f.Dispose() }"
  return (await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script])).stdout.trim()
}
function alive(pid) { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
try {
  const initial = join(root, 'initial-runtime')
  const next = join(root, 'next-runtime')
  await cp(bundle, initial, { recursive: true })
  await cp(debugExe, join(initial, 'hexbot.exe'))
  const firstManifest = { ...originalManifest, files: { ...originalManifest.files, 'hexbot.exe': createHash('sha256').update(await readFile(debugExe)).digest('hex') } }
  await writeFile(join(initial, 'manifest.json'), JSON.stringify(firstManifest))
  // Generate a second real daemon version using the repository's version tool,
  // only in this disposable fixture source, then restore exact original bytes.
  try {
    await setVersion(nextVersion)
    await exec('cargo', ['build', '--locked', '--manifest-path', 'backend/hexbot-core/Cargo.toml', '--bin', 'hexbot'], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    await cp(initial, next, { recursive: true })
    await cp(debugExe, join(next, 'hexbot.exe'))
    await writeFile(join(next, 'manifest.json'), JSON.stringify({ ...firstManifest, version: nextVersion, builtAt: firstManifest.builtAt + 1, files: { ...firstManifest.files, 'hexbot.exe': createHash('sha256').update(await readFile(debugExe)).digest('hex') } }))
  } finally { await writeFile(packagePath, originalPackage) }
  const output = join(root, 'updates')
  const update = await makeNativeUpdate(next, output)
  const metadata = Buffer.from(JSON.stringify(update.manifest))
  const manifestPath = `daemon/native/${nextVersion}/windows-x86_64/manifest.json`
  files.set(manifestPath, metadata)
  files.set(`${manifestPath}.sig`, Buffer.from(signature(testKey(), metadata)))
  files.set(update.manifest.path, await readFile(join(output, update.manifest.path)))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  await writeFile(join(home, 'config.yaml'), `updates:\n  base_url: ${base}\n`)
  await run(join(initial, 'hexbot.exe'), ['setup', '--activate', '--no-code-tools', '--json'])
  selected = JSON.parse(await readFile(join(home, 'runtime/native-current.json'), 'utf8')).executable
  await run(selected, ['service', 'install'])
  let state = await waitJson(statePath, value => value.port)
  const first = JSON.parse(await readFile(runningPath, 'utf8'))
  assert.equal(await lockState(), 'held')
  // /End must release the old daemon's home lock before /Run starts a new job.
  await run(selected, ['service', 'restart'])
  const restarted = await waitJson(runningPath, value => value.pid !== first.pid)
  assert.equal(alive(first.pid), false)
  state = await waitJson(statePath, value => value.port)
  const token = (await readFile(join(home, 'local-device.token'), 'utf8')).trim()
  const ticket = await fetch(`http://127.0.0.1:${state.port}/api/auth/ws-ticket`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
  assert.equal(ticket.status, 200)
  socket = new WebSocket(`ws://127.0.0.1:${state.port}/api/ws?ticket=${encodeURIComponent((await ticket.json()).ticket)}`)
  await once(socket, 'open')
  const accepted = new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Update request timed out')), 30_000)
    socket.addEventListener('message', event => {
      const frame = JSON.parse(event.data)
      if (frame.id === 'native-restart') { clearTimeout(timer); if (frame.error) reject(new Error(JSON.stringify(frame.error))); else done(frame.result) }
    })
  })
  socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'native-restart', method: 'hexbot.update.request', params: { version: nextVersion } }))
  await accepted
  const upgraded = await waitJson(runningPath, value => value.pid !== restarted.pid)
  assert.equal(alive(restarted.pid), false)
  selected = JSON.parse(await readFile(join(home, 'runtime/native-current.json'), 'utf8')).executable
  assert.equal((await run(selected, ['version'])).stdout.trim(), nextVersion)
  assert.equal(await lockState(), 'held')
  await run(selected, ['service', 'stop'])
  assert.equal(await lockState(), 'free')
  assert.equal(alive(upgraded.pid), false, 'updated daemon must remain in the task job ended by /End')
  assert.equal(JSON.parse((await run(selected, ['service', 'status', '--json'])).stdout).running, false)
  await run(selected, ['service', 'uninstall'])

  // Exercise the installer engine's actual Headless update path, which calls
  // service install rather than service restart. Reuse the two verified
  // versions in a fresh state, preserving the self-update evidence above.
  const installHome = join(user, 'installer update state')
  await mkdir(installHome)
  env.HEXBOT_HOME = installHome
  env.HEXBOT_UPDATE_URL = base
  await run(join(initial, 'hexbot.exe'), ['setup', '--activate', '--json'])
  selected = JSON.parse(await readFile(join(installHome, 'runtime/native-current.json'), 'utf8')).executable
  await run(selected, ['service', 'install'])
  const installerRunning = join(installHome, 'runtime/native-running.json')
  const old = await waitJson(installerRunning, value => value.pid)
  assert.equal((await run(selected, ['version'])).stdout.trim(), originalManifest.version)
  const installManifest = Buffer.from(JSON.stringify({ schema: 1, channel: 'stable', version: nextVersion, minInstaller: '0.1.5-0',
    targets: { 'windows-x86_64': { headless: { url: `${base}/${update.manifest.path}`, path: update.manifest.path,
      sha256: update.manifest.sha256, size: update.manifest.size, format: 'zip', manifest: manifestPath } } } }))
  files.set('install/stable.json', installManifest)
  files.set('install/stable.json.sig', Buffer.from(signature(testKey(), installManifest)))
  await exec('cargo', ['build', '--locked', '--manifest-path', 'backend/hexbot-installer/Cargo.toml', '--bin', 'hexbot-install'], { timeout: 300_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
  const installOutput = await run(resolve('backend/hexbot-installer/target/debug/hexbot-install.exe'), ['--headless', '--stable', '--yes', '--json'])
  console.log(installOutput.stdout)
  const installed = await waitJson(installerRunning, value => value.pid !== old.pid)
  assert.equal(alive(old.pid), false, 'Headless installer update must stop the previous owned task instance')
  selected = JSON.parse(await readFile(join(installHome, 'runtime/native-current.json'), 'utf8')).executable
  assert.equal((await run(selected, ['version'])).stdout.trim(), nextVersion)
  assert.equal(installed.executable, selected)
  assert.equal(await lockState(), 'held')
  const repairOutput = await run(resolve('backend/hexbot-installer/target/debug/hexbot-install.exe'), ['--repair', '--yes', '--json'])
  console.log(repairOutput.stdout)
  const repaired = await waitJson(installerRunning, value => value.pid !== installed.pid)
  assert.equal(alive(installed.pid), false, 'Headless repair must replace the running owned task instance')
  assert.equal(repaired.executable, selected)
  await run(selected, ['service', 'stop'])
  assert.equal(alive(repaired.pid), false)
  assert.equal(await lockState(), 'free')
  await run(selected, ['service', 'uninstall'])
  console.log('Real Headless installer version update and repair changed PID and reaped the old task instance')
  console.log('Real version-changing signed ZIP update, old-process exit, task restart and updated job termination passed')
} finally {
  socket?.close()
  if (selected) await run(selected, ['service', 'uninstall']).catch(error => console.error(`Task cleanup: ${error.message}`))
  await writeFile(packagePath, originalPackage)
  await new Promise(done => server.close(done))
  await rm(root, { recursive: true, force: true })
}
