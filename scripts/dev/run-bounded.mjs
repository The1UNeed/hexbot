// Bound integration commands and clean up only their own process trees.
import { spawn } from 'node:child_process'

const [duration, command, ...args] = process.argv.slice(2)
const timeout = Number(duration)
if (!Number.isSafeInteger(timeout) || timeout < 1 || !command)
  throw new Error('Usage: node run-bounded.mjs TIMEOUT_MS COMMAND [ARGS...]')
const child = spawn(command, args, { stdio: 'inherit', detached: process.platform !== 'win32', windowsHide: true })
let finished = false
function stop() {
  if (finished || !child.pid) return
  if (process.platform === 'win32') {
    const cleanup = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'inherit', windowsHide: true })
    cleanup.once('error', () => child.kill('SIGKILL'))
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
}
const timer = setTimeout(() => {
  console.error(`Command exceeded ${timeout}ms: ${command}`)
  process.exitCode = 1
  stop()
}, timeout)
child.once('error', error => { clearTimeout(timer); console.error(error.message); process.exitCode = 1 })
child.once('close', code => { finished = true; clearTimeout(timer); process.exitCode ||= code ?? 1 })
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
