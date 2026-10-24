// Native test driver. Uses the production runner and literal pnpm selection.
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import net from 'node:net'
import { pathToFileURL } from 'node:url'
const [repo, hexbot, home, mode, monitor] = process.argv.slice(2)
const { createDevRunner } = await import(pathToFileURL(join(repo, 'scripts/dev/run.mjs')))
const { pnpmCommand } = await import(pathToFileURL(join(repo, 'scripts/desktop/pnpm-command.mjs')))
const pnpm = await pnpmCommand()
const socket = net.connect(Number(monitor), '127.0.0.1')
await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
const report = event => socket.write(JSON.stringify(event) + '\n')
const children = []
const runner = createDevRunner({ hexbot,
  spawnChild: (...args) => { const child = spawn(...args); children.push(child); return child },
  report: message => console.error(message),
  exit: code => { report({ role: 'done', code }); socket.end(); process.exit(code) }
})
// The host's parent death must be independently observable while Rust keeps the
// driver's input writer open. Host inputs are otherwise production pipe stdio.
process.stdin.resume()
const env = { HEXBOT_HOME: home, HEXBOT_EXECUTABLE: hexbot, HEXBOT_CHANNEL: 'dev', HEXBOT_EDITION: 'full' }
await mkdir(home, { recursive: true })
const port = await new Promise(resolve => {
  const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
})
runner.start('web', pnpm.command, [...pnpm.prefix, '--filter', './apps/web', 'run', 'dev', '--port', String(port), '--strictPort'], env)
if (!(await runner.ready(port, 'native Vite'))) throw new Error('Vite stopped before readiness')
const state = join(home, 'serve-state.json')
const ready = new Promise((resolve, reject) => {
  const watcher = watch(dirname(state), async () => {
    try { const value = JSON.parse(await readFile(state, 'utf8')); watcher.close(); resolve(value) } catch {}
  })
  watcher.once('error', reject)
})
if (mode === 'direct') {
  runner.start('daemon', hexbot, ['serve', '--host', '127.0.0.1', '--port', '0'], { ...env, HEXBOT_SUPERVISOR: 'dev' })
} else {
  runner.start('desktop', pnpm.command, [...pnpm.prefix, '--filter', './apps/desktop', 'run', 'dev'], { ...env, HEXBOT_WEB_DEV_URL: `http://localhost:${port}` })
}
const daemon = await ready
if (!(await runner.ready(daemon.port, 'native daemon'))) throw new Error('daemon stopped before readiness')
report({ role: 'apps', pid: process.pid, hosts: children.map(child => child.pid), daemon })
// Rust retains all witnessed descendants before triggering one of these paths.
socket.once('data', bytes => {
  if (bytes[0] === 2) children[0].kill('SIGKILL') // real sibling failure
  else void runner.stop()
})
