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
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { downloadTool, installTool } from '../../apps/desktop/src/main/backend/tools.ts'
import { nodePath } from '../../apps/desktop/src/main/backend/node-path.ts'
import { pnpmCommand } from '../desktop/pnpm-command.mjs'

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

export function devPiEntrypoint(directory, platform = process.platform) {
  return resolve(directory, platform === 'win32'
    ? 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js' : 'node_modules/.bin/pi')
}

// npm.cmd is not an executable. Tool extraction supplies its own system tar,
// ASCII operands and cwd through the shared installer boundary.
export async function devExecFile(command, args, options = {}) {
  if (process.platform === 'win32' && command === 'npm') {
    const npm = join(dirname(await realpath(process.execPath)), 'node_modules/npm/bin/npm-cli.js')
    if (!(await stat(npm)).isFile()) throw new Error('Cannot locate the Node installation npm CLI')
    return promisify(execFile)(process.execPath, [nodePath(npm), ...args], options)
  }
  return promisify(execFile)(command, args, options)
}

export async function ensurePiRuntime(directory, run = devExecFile, platform = process.platform) {
  const digest = createHash('sha256').update(await readFile(resolve(directory, 'package-lock.json'))).digest('hex')
  const marker = resolve(directory, 'node_modules/.hexbot-lock-sha256')
  if (await stat(devPiEntrypoint(directory, platform)).then(info => info.isFile(), () => false) &&
      await readFile(marker, 'utf8').catch(() => '') === digest) return
  await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, maxBuffer: 32 * 1024 * 1024 })
  await writeFile(marker, digest)
}

export async function prepareDevRuntime(home, hexbot, pi, overrides = {}) {
  const binDirectory = resolve(home, 'bin')
  const deps = {
    binDirectory, stagingDirectory: resolve(home, 'runtime'),
    platform: process.platform, arch: process.arch,
    exists: existsSync, download: downloadTool, run: devExecFile,
    ...overrides
  }
  for (const tool of ['rg', 'fd']) await installTool(tool, deps)
  if (deps.platform === 'win32') {
    // PiProcess already supports this Node + sibling pi/launch.mjs layout.
    // Copy the running Node instead of interpreting a shim or requiring symlinks.
    const root = resolve(home, 'runtime/dev-pi')
    const source = await realpath(process.execPath)
    const executable = join(root, 'node.exe')
    await mkdir(join(root, 'pi'), { recursive: true })
    const digest = bytes => createHash('sha256').update(bytes).digest('hex')
    const sourceHash = digest(await readFile(source))
    if (await readFile(executable).then(bytes => digest(bytes), () => '') !== sourceHash) {
      const staging = await mkdtemp(join(root, '.node-'))
      try {
        await copyFile(source, join(staging, 'node.exe'))
        await rename(join(staging, 'node.exe'), executable)
      } finally { await rm(staging, { recursive: true, force: true }) }
    }
    const cli = pathToFileURL(nodePath(await realpath(pi))).href
    const search = new URL('../desktop/search-tools.mjs', import.meta.url).href
    await writeFile(join(root, 'pi/launch.mjs'),
      `import { prepareSearchTools } from ${JSON.stringify(search)};\n` +
      `await prepareSearchTools(${JSON.stringify(binDirectory)}, process.env.PI_CODING_AGENT_DIR);\n` +
      `await import(${JSON.stringify(cli)});\n`)
    return { HEXBOT_HOME: home, HEXBOT_EXECUTABLE: hexbot, HEXBOT_PI_EXECUTABLE: executable,
      PATH: [binDirectory, process.env.PATH ?? ''].join(';') }
  }
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

// Windows web/Electron roots run inside the debug daemon's private job host.
// The direct daemon path keeps its existing lifetime boundary.
export function createDevRunner({ hexbot, platform = process.platform, spawnChild = spawn,
  killGroup = (pid, signal) => process.kill(pid, signal),
  exit = code => process.exit(code), report = message => console.error(message),
  now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const children = []
  let stopping = false
  let primaryCode = 0
  let stopped
  let notifyStopping
  const stoppingSignal = new Promise(resolve => { notifyStopping = resolve })
  const alive = entry => !entry.done
  function start(label, command, commandArgs, env) {
    if (stopping) return
    const hosted = platform === 'win32' && (label === 'web' || label === 'desktop')
    let child
    try {
      child = spawnChild(hosted ? hexbot : command,
        hosted ? ['__dev-child', label, '--', command, ...commandArgs] : commandArgs, {
          cwd: repositoryRoot, detached: platform !== 'win32',
          env: { ...process.env, ...env }, stdio: hosted ? ['pipe', 'inherit', 'inherit'] : 'inherit'
        })
    } catch (error) {
      report(`[dev] ${label}: ${error.message}`)
      void stop(1)
      return
    }
    let finish
    const entry = { child, label, hosted, done: false,
      completion: new Promise(resolve => { finish = resolve }) }
    children.push(entry)
    const complete = code => {
      if (entry.done) return
      entry.done = true
      finish()
      if (!stopping) {
        report(`[dev] ${label} exited with code ${code ?? 'unknown'}`)
        void stop(1)
      } else if (hosted && code !== 0) {
        report(`[dev] cleanup of ${label} was not confirmed (code ${code ?? 'unknown'})`)
        if (!primaryCode) primaryCode = 1
      }
    }
    child.once('error', error => {
      report(`[dev] ${label}: ${error.message}`)
      complete(1)
    })
    child.once('exit', complete)
    // A host can close its input before the runner does. Handle EPIPE without
    // an uncaught stream error; only the host's exit can confirm completion.
    child.stdin?.on('error', () => {})
    return child
  }
  function stop(code = 0) {
    if (code && !primaryCode) primaryCode = code
    if (stopping) return stopped
    stopping = true
    notifyStopping()
    // Defer completion so synchronous fake-child events cannot re-enter stop
    // before its shared promise exists.
    stopped = Promise.resolve().then(async () => {
      if (platform !== 'win32') {
        for (const { child } of children.filter(alive)) {
          try { killGroup(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
        }
        schedule(() => exit(primaryCode), 500).unref?.()
        return
      }
      const deadline = now() + 20_000
      // Close every private input in this turn, before awaiting any child.
      for (const entry of children.filter(alive)) {
        try {
          if (entry.hosted) entry.child.stdin.end()
          else entry.child.kill('SIGTERM')
        } catch (error) {
          report(`[dev] ${entry.label}: ${error.message}`)
          if (!primaryCode) primaryCode = 1
        }
      }
      let timer
      await Promise.race([
        Promise.all(children.map(entry => entry.completion)),
        new Promise(resolve => { timer = schedule(resolve, Math.max(0, deadline - now())) })
      ])
      cancel(timer)
      for (const entry of children.filter(alive)) {
        report(`[dev] cleanup of ${entry.label} was not confirmed`)
        if (!primaryCode) primaryCode = 1
        // The ChildProcess owns this handle. Never use taskkill or a PID lookup.
        try { entry.child.kill('SIGKILL') } catch (error) { report(`[dev] ${entry.label}: ${error.message}`) }
      }
      exit(primaryCode)
    })
    return stopped
  }
  async function ready(port, label, wait = waitForPort) {
    if (stopping) return false
    await Promise.race([wait(port, label), stoppingSignal])
    return !stopping
  }
  return { start, stop, ready, get stopping() { return stopping } }
}

async function main() {
  const hexbot = resolve(repositoryRoot, `backend/hexbot-core/target/debug/hexbot${process.platform === 'win32' ? '.exe' : ''}`)
  const runner = createDevRunner({ hexbot })
  const { start, stop } = runner
  process.on('SIGINT', () => { void stop() })
  process.on('SIGTERM', () => { void stop() })
  try {
    validateDevArgs(args)
    const home = resolve(option('--home') ?? resolve(repositoryRoot, '.hexbot'))
    if (home === resolve(homedir(), '.hexbot'))
      throw new Error('Refusing to run a dev daemon against ~/.hexbot, the live install')
    await mkdir(home, { recursive: true })
    const pi = devPiEntrypoint(resolve(repositoryRoot, 'backend/pi-runtime'))
    console.log('[dev] building the Rust daemon')
    const run = (...args) => {
      if (runner.stopping) throw new Error('Dev runner stopped')
      return devExecFile(...args)
    }
    await run('cargo', ['build', '--locked', '--manifest-path', resolve(repositoryRoot, 'backend/hexbot-core/Cargo.toml'), '--bin', 'hexbot'], { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024 })
    if (runner.stopping) return
    await ensurePiRuntime(resolve(repositoryRoot, 'backend/pi-runtime'), run)
    if (runner.stopping) return
    const runtimeEnv = await prepareDevRuntime(home, hexbot, pi, { run })
    if (runner.stopping) return

    const derived = derivePorts(repositoryRoot)
    const daemonPort = Number(option('--port') ?? (await freePortFrom(derived.daemon)))
    const webPort = await freePortFrom(derived.web)
    if (runner.stopping) return
    const pnpm = await pnpmCommand()

    if (runner.stopping) return
    console.log(`[dev] home ${home}`)
    if (desktop) {
      // The Electron app starts and owns its daemon; it needs the web dev server.
      start('web', pnpm.command, [...pnpm.prefix,
        '--filter',
        './apps/web',
        'run',
        'dev',
        '--port',
        String(webPort),
        '--strictPort'
      ])
      if (!(await runner.ready(webPort, 'web bundle'))) return
      console.log(`[dev] web http://localhost:${webPort}`)
      start('desktop', pnpm.command, [...pnpm.prefix, '--filter', './apps/desktop', 'run', 'dev'], {
        ...runtimeEnv,
        HEXBOT_WEB_DEV_URL: `http://localhost:${webPort}`
      })
    } else {
      // This runner supervises the daemon, so the daemon prints no sign-in link of
      // its own; the link below is minted with `hexbot pair` and points at the Vite
      // server, which proxies the daemon so the browser gets its cookie there.
      start('daemon', hexbot, ['serve', '--port', String(daemonPort)], { ...runtimeEnv, HEXBOT_SUPERVISOR: 'dev', HEXBOT_WEB_DEV_URL: `http://localhost:${webPort}` })
      if (!(await runner.ready(daemonPort, 'daemon'))) return
      console.log(`[dev] daemon http://127.0.0.1:${daemonPort}`)
      start(
        'web',
        pnpm.command,
        [...pnpm.prefix, '--filter', './apps/web', 'run', 'dev', '--port', String(webPort), '--strictPort'],
        {
          VITE_HEXBOT_ORIGIN: `http://127.0.0.1:${daemonPort}`
        }
      )
      if (!(await runner.ready(webPort, 'web bundle'))) return
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
    if (!runner.stopping) {
      console.error(`[dev] ${error.message}`)
      void stop(1)
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
