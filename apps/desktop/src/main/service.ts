import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, delimiter } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { binDir, hexbotExecutable, hexbotHome } from './backend/paths'
import { launchdPlist, systemdUnit, windowsServiceScript, windowsTaskXmlBytes, type ServiceFileOptions } from './service-files'

const exec = promisify(execFile)
export const servicePath = (targetPlatform = process.platform, home = homedir()): string => {
  if (targetPlatform === 'darwin') return join(home, 'Library', 'LaunchAgents', 'app.hexbot.daemon.plist')
  if (targetPlatform === 'win32') return join(home, 'AppData', 'Local', 'Hexbot', 'hexbot-service.cmd')
  return join(home, '.config', 'systemd', 'user', 'hexbot.service')
}
const taskXmlPath = (file: string): string => file.replace(/\.cmd$/i, '.xml')
const options = (): ServiceFileOptions => ({
  executable: hexbotExecutable(),
  home: hexbotHome(),
  path: [binDir(), process.env.PATH ?? ''].join(delimiter),
  logDir: join(hexbotHome(), 'logs')
})

export async function installService(
  file = servicePath(), targetPlatform = process.platform,
  config = options(), run: (command: string, args: string[]) => Promise<unknown> = exec
): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await mkdir(join(config.home, 'logs'), { recursive: true })
  if (targetPlatform === 'darwin') {
    await writeFile(file, launchdPlist(config))
    try {
      await run('launchctl', ['bootstrap', `gui/${process.getuid!()}`, file])
    } catch {
      await run('launchctl', ['load', '-w', file])
    }
  } else if (targetPlatform === 'linux') {
    await writeFile(file, systemdUnit(config))
    await run('systemctl', ['--user', 'daemon-reload'])
    await run('systemctl', ['--user', 'enable', '--now', 'hexbot'])
  } else if (targetPlatform === 'win32') {
    await writeFile(file, windowsServiceScript(config))
    const xml = taskXmlPath(file)
    await writeFile(xml, windowsTaskXmlBytes(file))
    await run('schtasks', ['/Create', '/TN', 'Hexbot', '/XML', xml, '/F'])
    await run('schtasks', ['/Run', '/TN', 'Hexbot'])
  } else throw new Error(`Services are unsupported on ${targetPlatform}`)
}

const launchdDomains = (): string[] => [`gui/${process.getuid!()}`, `user/${process.getuid!()}`]

export async function uninstallService(
  file = servicePath(), targetPlatform = process.platform,
  run: (command: string, args: string[]) => Promise<unknown> = exec
): Promise<void> {
  if (targetPlatform === 'darwin') {
    let stopped = false
    for (const domain of launchdDomains()) {
      try {
        await run('launchctl', ['bootout', domain, file])
        stopped = true
      } catch {}
    }
    if (!stopped) {
      try { await run('launchctl', ['unload', '-w', file]) } catch {}
    }
  } else if (targetPlatform === 'linux') {
    try {
      await run('systemctl', ['--user', 'disable', '--now', 'hexbot'])
    } catch {}
    await run('systemctl', ['--user', 'daemon-reload'])
  } else if (targetPlatform === 'win32') {
    try { await run('schtasks', ['/End', '/TN', 'Hexbot']) } catch {}
    try { await run('schtasks', ['/Delete', '/TN', 'Hexbot', '/F']) } catch {}
    await rm(taskXmlPath(file), { force: true })
  }
  await rm(file, { force: true })
}

export async function serviceStatus(
  file = servicePath(), targetPlatform = process.platform,
  run: (command: string, args: string[]) => Promise<unknown> = exec
): Promise<{ installed: boolean; running: boolean }> {
  if (targetPlatform === 'darwin') {
    const content = await readFile(file, 'utf8').catch(() => '')
    const homes = [...content.matchAll(/<key>HEXBOT_HOME<\/key>\s*<string>([^<]*)<\/string>/g)]
    const owner = homes[0]?.[1]?.replaceAll('&quot;', '"').replaceAll('&apos;', "'")
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
    if (homes.length !== 1 || owner !== hexbotHome()) return { installed: false, running: false }
    for (const domain of launchdDomains()) {
      try {
        const output = await run('launchctl', ['print', `${domain}/app.hexbot.daemon`]) as { stdout?: string }
        if (output?.stdout?.split('\n').some(line => line.trim() === 'state = running'))
          return { installed: true, running: true }
      } catch {}
    }
  } else if (targetPlatform === 'linux') {
    const content = await readFile(file, 'utf8').catch(() => '')
    const homes = [...content.matchAll(/^Environment=HEXBOT_HOME=(.*)$/gm)]
    const value = homes[0]?.[1]?.match(/^"((?:[^"\\%\r\n]|\\[\\"]|%%)*)"$/)?.[1]
    const owner = value?.replace(/\\([\\"])|%%/g, (_match, escaped: string | undefined) => escaped ?? '%')
    if (homes.length !== 1 || owner !== hexbotHome()) return { installed: false, running: false }
    try {
      await run('systemctl', ['--user', 'is-active', 'hexbot'])
      return { installed: true, running: true }
    } catch {}
  } else if (targetPlatform === 'win32') {
    const content = await readFile(file, 'utf8').catch(() => '')
    const homes = [...content.matchAll(/^set "HEXBOT_HOME=(.*)"$/gm)]
    if (!content.includes('rem HEXBOT_SERVICE_SCRIPT') || homes.length !== 1 || homes[0]?.[1] !== hexbotHome())
      return { installed: false, running: false }
    try {
      const output = await run('schtasks', ['/Query', '/TN', 'Hexbot', '/FO', 'LIST', '/V']) as { stdout?: string }
      return { installed: true, running: /Status:\s+Running/i.test(output?.stdout ?? '') }
    } catch {
      return { installed: true, running: false }
    }
  } else return { installed: false, running: false }
  const { existsSync } = await import('node:fs')
  return { installed: existsSync(file), running: false }
}

// The Python runtime from earlier versions is unused once no service points at
// it. A pending transition marker means the daemon still owns that cleanup. The
// daemon keeps a forwarding script in venv/bin/hexbot because launchd may run
// the old path until its next reload; that one stays.
async function removeLegacyRuntime(home: string): Promise<void> {
  const runtime = join(home, 'runtime')
  if (!(await lstat(runtime).catch(() => undefined))?.isDirectory()) return
  if (await lstat(join(runtime, 'native-transition-pending')).catch(() => undefined)) return
  const shim = (await readFile(join(runtime, 'venv/bin/hexbot'), 'utf8').catch(() => '')).startsWith('#!/bin/sh\n')
  for (const name of await readdir(runtime))
    if ((name === 'venv' && !shim) || ['src', 'ripgrep-extract', 'uv-install.sh'].includes(name) || /^ripgrep-.+\.tar\.gz$/.test(name))
      await rm(join(runtime, name), { recursive: true, force: true })
}

// Rewrite only the service for this home, once the native bundle is verified.
export async function migrateLegacyService(
  file = servicePath(), targetPlatform = process.platform,
  config = options(), run: (command: string, args: string[]) => Promise<unknown> = exec
): Promise<void> {
  if (targetPlatform === 'win32') return removeLegacyRuntime(config.home)
  const old = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const legacy = join(config.home, 'runtime', 'venv', 'bin', 'hexbot')
  const escaped = legacy.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const legacyEntry = targetPlatform === 'darwin' ? `<string>${escaped}</string>`
    : `ExecStart="${legacy.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" serve`
  if (!old.includes(legacyEntry)) return removeLegacyRuntime(config.home)
  const content = targetPlatform === 'darwin' ? launchdPlist(config) : systemdUnit(config)
  const temporary = `${file}.native-${process.pid}`
  const running = await run(targetPlatform === 'darwin' ? 'launchctl' : 'systemctl',
    targetPlatform === 'darwin' ? ['print', `gui/${process.getuid!()}/app.hexbot.daemon`] : ['--user', 'is-active', 'hexbot'])
    .then(() => true, () => false)
  const stop = (): Promise<unknown> => targetPlatform === 'darwin'
    ? run('launchctl', ['bootout', `gui/${process.getuid!()}`, file])
    : run('systemctl', ['--user', 'stop', 'hexbot'])
  const start = async (): Promise<void> => {
    if (targetPlatform === 'linux') await run('systemctl', ['--user', 'daemon-reload'])
    if (!running) return
    if (targetPlatform === 'darwin') await run('launchctl', ['bootstrap', `gui/${process.getuid!()}`, file])
    else await run('systemctl', ['--user', 'start', 'hexbot'])
  }
  try {
    await writeFile(temporary, content, { mode: 0o600 })
    if (running) await stop()
    await rename(temporary, file)
    // The new service definition no longer needs the old forwarding script.
    await mkdir(join(config.home, 'runtime'), { recursive: true })
    await writeFile(join(config.home, 'runtime/native-transition-pending'), 'remove-shim')
    try { await start() } catch (error) {
      await rm(join(config.home, 'runtime/native-transition-pending'), { force: true })
      await writeFile(temporary, old, { mode: 0o600 })
      await rename(temporary, file)
      await start().catch(() => undefined)
      throw error
    }
  } finally { await rm(temporary, { force: true }) }
}
