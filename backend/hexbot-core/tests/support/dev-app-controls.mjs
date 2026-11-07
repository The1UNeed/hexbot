// Native test driver. Production runner, real Dev provisioning and literal pnpm.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import net from 'node:net'
import { pathToFileURL } from 'node:url'
import { startDevRuntime, remainingStartup, assertSurvivingDesktop } from './dev-app-harness.mjs'
const [repo, hexbot, home, mode, monitor, startupDeadline] = process.argv.slice(2)
const remaining = () => remainingStartup(Number(startupDeadline))
const { createDevRunner, ensurePiRuntime, prepareDevRuntime, devPiEntrypoint, devExecFile } = await import(pathToFileURL(join(repo, 'scripts/dev/run.mjs')))
const { pnpmCommand } = await import(pathToFileURL(join(repo, 'scripts/desktop/pnpm-command.mjs')))
const { waitForRuntimeJson } = await import(pathToFileURL(join(repo, 'scripts/desktop/runtime-file.mjs')))
const socket = net.connect(Number(monitor), '127.0.0.1')
await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
const commands = createInterface({ input: socket })[Symbol.asyncIterator]()
const report = event => socket.write(JSON.stringify(event) + '\n')
const children = {}, exits = {}, kills = [], diagnostics = []
const abort = new AbortController()
let browser
let devtoolsResolve
const devtools = new Promise(resolve => { devtoolsResolve = resolve })
const runner = createDevRunner({ hexbot,
  spawnChild: (command, args, options) => {
    const label = args[1]
    const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
    children[label] = child
    let stderr = ''
    child.stdout.on('data', bytes => process.stdout.write(bytes))
    child.stderr.on('data', bytes => {
      process.stderr.write(bytes)
      stderr = (stderr + bytes).slice(-8192)
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)
      if (label === 'desktop' && match) devtoolsResolve(match[1])
    })
    const kill = child.kill.bind(child)
    child.kill = signal => { kills.push({ label, signal }); return kill(signal) }
    child.once('exit', code => { exits[label] = code })
    return child
  },
  report: message => { diagnostics.push(message); console.error(message) },
  exit: code => {
    // Keep the driver alive until Rust checks retained descendant handles.
    const completion = { role: 'completion', code, exits, kills, diagnostics }
    if (mode === 'sibling') {
      try { assertSurvivingDesktop(completion) } catch (error) { report({ role: 'failure', message: String(error) }); process.exit(1); return }
    }
    report(completion)
    void commands.next().then(command => {
      assert(!command.done && JSON.parse(command.value).action === 'verified')
      socket.end(() => process.exit(code))
    }).catch(error => { console.error(error); process.exit(1) })
  }
})
socket.once('end', () => { abort.abort(); void runner.stop(1) })
const direct = mode.startsWith('direct')
const freePort = () => new Promise(resolve => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
})
let webPort, ownedPid, daemonState
try {
  await mkdir(home, { recursive: true })
  const pnpm = await pnpmCommand()
  const identity = await startDevRuntime({
    provision: async () => {
      // Uses the already-built debug binary. Never invoke Cargo from Cargo tests.
      const run = (command, args, options) => devExecFile(command, args, { ...options, timeout: remaining(), signal: abort.signal })
      await ensurePiRuntime(join(repo, 'backend/pi-runtime'), run)
      const env = await prepareDevRuntime(home, hexbot, devPiEntrypoint(join(repo, 'backend/pi-runtime')), { run })
      return { ...env, HEXBOT_HOME: home, HEXBOT_EXECUTABLE: hexbot, HEXBOT_CHANNEL: 'dev', HEXBOT_EDITION: 'full' }
    },
    startClients: async env => {
      webPort = await freePort()
      runner.start('web', pnpm.command, [...pnpm.prefix, '--filter', './apps/web', 'run', 'dev', '--port', String(webPort), '--strictPort'], env)
      if (!(await runner.ready(webPort, 'native Vite'))) throw new Error('Vite stopped before readiness')
      if (!direct) runner.start('desktop', pnpm.command, [...pnpm.prefix, '--filter', './apps/desktop', 'run', 'dev'], {
        ...env, HEXBOT_WEB_DEV_URL: `http://localhost:${webPort}`, REMOTE_DEBUGGING_PORT: '0'
      })
    },
    startOwnedDaemon: async env => {
      if (direct) {
        // Rust creates the direct daemon and retains its actual child handle
        // before permitting this driver to publish any readiness record.
        report({ role: 'direct-start', env })
        const command = await commands.next()
        assert(!command.done)
        const value = JSON.parse(command.value)
        assert.equal(value.action, 'direct-started')
        ownedPid = value.pid
        return
      }
      const require = createRequire(join(repo, 'apps/desktop/package.json'))
      const { chromium } = require('@playwright/test')
      browser = await chromium.connectOverCDP(await devtools, { timeout: remaining() })
      const context = browser.contexts()[0]
      const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: remaining() })
      await page.waitForFunction(() => typeof window.hexbot?.daemon?.start === 'function', undefined, { timeout: remaining() })
      const status = await page.evaluate(() => window.hexbot.daemon.start())
      assert(['starting', 'running'].includes(status.state), `Unexpected Dev bridge state: ${status.state}`)
      ownedPid = status.pid
      // An owned Dev status may omit pid; authenticate it via the actual API
      // and require the desktop host ancestry in Rust before shutdown.
      return status
    },
    ready: () => waitForRuntimeJson(join(home, 'serve-state.json'), state => state.port, remaining(), undefined, { signal: abort.signal }),
    handshake: async (state, owned) => {
      daemonState = state
      const response = await fetch(`http://127.0.0.1:${state.port}/api/daemon/identity`, { signal: AbortSignal.timeout(remaining()), redirect: 'error' })
      assert.equal(response.status, 200)
      const identity = await response.json()
      assert.equal(identity.install_id, (await readFile(join(home, 'install_id'), 'utf8')).trim())
      if (ownedPid !== undefined) assert.equal(identity.pid, ownedPid)
      if (!direct) assert.equal(owned.port, state.port)
      return identity
    }
  })
  await browser?.close() // disconnect the observer, leave the actual app running
  report({ role: mode === 'direct-readiness-failure' ? 'injected-readiness-failure' : 'apps', pid: process.pid,
    hosts: Object.fromEntries(Object.entries(children).map(([label, child]) => [label, child.pid])),
    daemon: daemonState, identity, webPort })
  const command = await commands.next()
  assert(!command.done)
  if (JSON.parse(command.value).action === 'fail-web') children.web.kill('SIGKILL')
  else await runner.stop()
} catch (error) {
  report({ role: 'failure', message: String(error) })
  await runner.stop(1)
}
