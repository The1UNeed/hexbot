// The dev channel: run Hexbot from this checkout (docs/channels.md, "Dev").
//
//   pnpm dev                daemon + web bundle, open the printed sign-in link
//   pnpm dev --desktop      web bundle + Electron app (the app runs the daemon)
//   pnpm dev --home DIR     daemon state somewhere other than <checkout>/.hexbot
//   pnpm dev --port N       fixed daemon port instead of one derived from the path
//
// Like T3 Code's dev runner, state lives inside the checkout (gitignored
// `.hexbot/`), never in ~/.hexbot, and the ports derive from the checkout
// path so two worktrees run side by side. An ambient HEXBOT_HOME is ignored
// on purpose: it is too easy to inherit the live install from a shell.
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { homedir } from 'node:os'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadTool, installTool } from '../../apps/desktop/src/main/backend/tools.ts'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const desktop = args.includes('--desktop')

export function validateDevArgs(args) {
  if (args.some(arg => arg === '--backend' || arg.startsWith('--backend=')))
    throw new Error('--backend was removed; pnpm dev uses the native daemon')
}

export function derivePorts(path) {
  const hash = createHash('sha256').update(path).digest()
  const base = 9200 + (hash.readUInt16BE(0) % 700)
  return { daemon: base, web: base + 1000 }
}

export async function ensurePiRuntime(directory, run = promisify(execFile)) {
  const digest = createHash('sha256').update(await readFile(resolve(directory, 'package-lock.json'))).digest('hex')
  const marker = resolve(directory, 'node_modules/.hexbot-lock-sha256')
  if (existsSync(resolve(directory, 'node_modules/.bin/pi')) &&
      await readFile(marker, 'utf8').catch(() => '') === digest) return
  await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, maxBuffer: 32 * 1024 * 1024 })
  await writeFile(marker, digest)
}

export async function prepareDevRuntime(home, hexbot, pi, overrides = {}) {
  const binDirectory = resolve(home, 'bin')
  const deps = {
    binDirectory, stagingDirectory: resolve(home, 'runtime'),
    platform: process.platform, arch: process.arch,
    exists: existsSync, download: downloadTool, run: promisify(execFile),
    ...overrides
  }
  for (const tool of ['rg', 'fd']) await installTool(tool, deps)
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  const launcher = resolve(home, 'runtime/hexbot-pi')
  await writeFile(launcher, '#!/bin/sh\nset -eu\n' +
    `${quote(process.execPath)} ${quote(resolve(repositoryRoot, 'scripts/desktop/search-tools.mjs'))} ${quote(binDirectory)}\n` +
    `exec ${quote(pi)} "$@"\n`)
  await chmod(launcher, 0o755)
  return { HEXBOT_HOME: home, HEXBOT_EXECUTABLE: hexbot, HEXBOT_PI_EXECUTABLE: launcher,
    PATH: [binDirectory, process.env.PATH ?? ''].join(delimiter) }
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

// `hexbot pair` prints "Pairing code: XXXX-XXXX"; the code signs a browser in once.
export function pairingCode(output) {
  return /^Pairing code: (\S+)/m.exec(output)?.[1]
}

export function printsSignInLink(terminal, env = process.env) {
  return !!terminal && env.HEXBOT_SUPERVISOR === undefined && env.INVOCATION_ID === undefined &&
    (env.XPC_SERVICE_NAME === undefined || env.XPC_SERVICE_NAME === '0')
}

const children = []
function start(label, command, commandArgs, env) {
  // Each child leads its own process group, so stopping it also stops what
  // it spawned (pnpm -> electron-vite -> Electron -> daemon) instead of leaving
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
    validateDevArgs(args)
    const home = resolve(option('--home') ?? resolve(repositoryRoot, '.hexbot'))
    if (home === resolve(homedir(), '.hexbot'))
      throw new Error('Refusing to run a dev daemon against ~/.hexbot, the live install')
    await mkdir(home, { recursive: true })
    const hexbot = resolve(repositoryRoot, 'backend/hexbot-core/target/debug/hexbot')
    const pi = resolve(repositoryRoot, 'backend/pi-runtime/node_modules/.bin/pi')
    console.log('[dev] building the Rust daemon')
    const run = promisify(execFile)
    await run('cargo', ['build', '--locked', '--manifest-path', resolve(repositoryRoot, 'backend/hexbot-core/Cargo.toml'), '--bin', 'hexbot'], { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024 })
    await ensurePiRuntime(resolve(repositoryRoot, 'backend/pi-runtime'), run)
    const runtimeEnv = await prepareDevRuntime(home, hexbot, pi)

    const derived = derivePorts(repositoryRoot)
    const daemonPort = Number(option('--port') ?? (await freePortFrom(derived.daemon)))
    const webPort = await freePortFrom(derived.web)
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

    console.log(`[dev] home ${home}`)
    if (desktop) {
      // The Electron app starts and owns its daemon; it needs the web dev server.
      start('web', pnpm, [
        '--filter',
        './apps/web',
        'run',
        'dev',
        '--port',
        String(webPort),
        '--strictPort'
      ])
      await waitForPort(webPort, 'web bundle')
      console.log(`[dev] web http://localhost:${webPort}`)
      start('desktop', pnpm, ['--filter', './apps/desktop', 'run', 'dev'], {
        ...runtimeEnv,
        HEXBOT_WEB_DEV_URL: `http://localhost:${webPort}`
      })
    } else {
      // This runner supervises the daemon, so the daemon prints no sign-in link of
      // its own; the link below is minted with `hexbot pair` and points at the Vite
      // server, which proxies the daemon so the browser gets its cookie there.
      start('daemon', hexbot, ['serve', '--port', String(daemonPort)], { ...runtimeEnv, HEXBOT_SUPERVISOR: 'dev', HEXBOT_WEB_DEV_URL: `http://localhost:${webPort}` })
      await waitForPort(daemonPort, 'daemon')
      console.log(`[dev] daemon http://127.0.0.1:${daemonPort}`)
      start(
        'web',
        pnpm,
        ['--filter', './apps/web', 'run', 'dev', '--port', String(webPort), '--strictPort'],
        {
          VITE_HEXBOT_ORIGIN: `http://127.0.0.1:${daemonPort}`
        }
      )
      await waitForPort(webPort, 'web bundle')
      if (printsSignInLink(process.stdout.isTTY)) {
        try {
          const code = pairingCode((await run(hexbot, ['pair', '--sign-in'], { env: { ...process.env, ...runtimeEnv } })).stdout)
          if (!code) throw new Error('hexbot pair returned no pairing code')
          console.log(`[dev] sign in: http://localhost:${webPort}/login?code=${code} (works once, expires in 10 minutes)`)
        } catch (error) { console.error(`[dev] sign-in link: ${error.message}`) }
      }
      console.log(`[dev] new code: HEXBOT_HOME=${home} ${hexbot} pair`)
    }
  } catch (error) {
    console.error(`[dev] ${error.message}`)
    stop(1)
  }
}
