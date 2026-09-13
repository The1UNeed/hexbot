// The dev channel: run Hexbot from this checkout (docs/channels.md, "Dev").
//
//   npm run dev                daemon + web bundle, open the printed URL
//   npm run dev -- --desktop   web bundle + Electron app (the app runs the daemon)
//   npm run dev -- --home DIR  daemon state somewhere other than <checkout>/.hexbot
//   npm run dev -- --port N    fixed daemon port instead of one derived from the path
//
// Like T3 Code's dev runner, state lives inside the checkout (gitignored
// `.hexbot/`), never in ~/.hexbot, and the ports derive from the checkout
// path so two worktrees run side by side. An ambient HEXBOT_HOME is ignored
// on purpose: it is too easy to inherit the live install from a shell.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const desktop = args.includes('--desktop')

export function derivePorts(path) {
  const hash = createHash('sha256').update(path).digest()
  const base = 9200 + (hash.readUInt16BE(0) % 700)
  return { daemon: base, web: base + 1000 }
}

// Vite binds "localhost", which is ::1 on most machines; the daemon binds
// 127.0.0.1. A port is free only when both are.
const hosts = ['127.0.0.1', '::1']

function canListen(port, host) {
  return new Promise(done => {
    const server = net.createServer()
    // No IPv6 on this machine counts as free on that family.
    server.once('error', error => done(host === '::1' && error.code === 'EADDRNOTAVAIL'))
    server.listen(port, host, () => server.close(() => done(true)))
  })
}

async function portFree(port) {
  for (const host of hosts) if (!(await canListen(port, host))) return false
  return true
}

async function freePortFrom(port) {
  for (let candidate = port; candidate < port + 50; candidate++)
    if (await portFree(candidate)) return candidate
  throw new Error(`No free port between ${port} and ${port + 50}`)
}

function waitForPort(port, label, timeoutMs = 60_000) {
  const started = Date.now()
  let attempts = 0
  return new Promise((done, fail) => {
    const attempt = () => {
      const socket = net.connect(port, hosts[attempts++ % hosts.length])
      socket.once('connect', () => {
        socket.destroy()
        done()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() - started > timeoutMs) fail(new Error(`${label} did not open port ${port}`))
        else setTimeout(attempt, 250)
      })
    }
    attempt()
  })
}

const children = []
function start(label, command, commandArgs, env) {
  // Each child leads its own process group, so stopping it also stops what
  // it spawned (npm -> electron-vite -> Electron -> daemon) instead of leaving
  // an orphaned app holding the single-instance lock.
  const child = spawn(command, commandArgs, {
    cwd: repositoryRoot,
    detached: process.platform !== 'win32',
    env: { ...process.env, ...env },
    stdio: 'inherit'
  })
  children.push(child)
  child.once('exit', code => {
    if (!stopping) {
      console.error(`[dev] ${label} exited with code ${code ?? 'unknown'}`)
      stop(1)
    }
  })
  return child
}
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  // Kill only the PIDs we started (AGENTS.md, "Killing by pattern").
  for (const child of children) {
    if (child.exitCode !== null) continue
    try {
      if (process.platform === 'win32') child.kill('SIGTERM')
      else process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  setTimeout(() => process.exit(code), 500).unref()
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const home = resolve(option('--home') ?? resolve(repositoryRoot, '.hexbot'))
    if (home === resolve(homedir(), '.hexbot'))
      throw new Error('Refusing to run a dev daemon against ~/.hexbot, the live install')
    await mkdir(home, { recursive: true })
    const hexbot = resolve(repositoryRoot, 'venv/bin/hexbot')
    if (!existsSync(hexbot))
      throw new Error('venv/bin/hexbot is missing. Run the uv commands in AGENTS.md first.')

    const derived = derivePorts(repositoryRoot)
    const daemonPort = Number(option('--port') ?? (await freePortFrom(derived.daemon)))
    const webPort = await freePortFrom(derived.web)
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

    console.log(`[dev] home ${home}`)
    if (desktop) {
      // The Electron app starts and owns its daemon; it needs the web dev server.
      start('web', npm, [
        'run',
        'dev',
        '-w',
        'apps/web',
        '--',
        '--port',
        String(webPort),
        '--strictPort'
      ])
      await waitForPort(webPort, 'web bundle')
      console.log(`[dev] web http://localhost:${webPort}`)
      start('desktop', npm, ['run', 'dev', '-w', 'apps/desktop'], {
        HEXBOT_HOME: home,
        HEXBOT_WEB_DEV_URL: `http://localhost:${webPort}`
      })
    } else {
      start('daemon', hexbot, ['serve', '--port', String(daemonPort)], { HEXBOT_HOME: home })
      await waitForPort(daemonPort, 'daemon')
      console.log(`[dev] daemon http://127.0.0.1:${daemonPort}`)
      start(
        'web',
        npm,
        ['run', 'dev', '-w', 'apps/web', '--', '--port', String(webPort), '--strictPort'],
        {
          VITE_HEXBOT_ORIGIN: `http://127.0.0.1:${daemonPort}`
        }
      )
      await waitForPort(webPort, 'web bundle')
      console.log(`[dev] open http://localhost:${webPort} (loopback, no pairing needed)`)
    }
  } catch (error) {
    console.error(`[dev] ${error.message}`)
    stop(1)
  }
}
