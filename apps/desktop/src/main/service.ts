import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, delimiter } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { binDir, serviceExecutable, hexbotHome } from './backend/paths'
import { launchdPlist, systemdUnit, type ServiceFileOptions } from './service-files'

const exec = promisify(execFile)
const servicePath = (): string =>
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'LaunchAgents', 'app.hexbot.daemon.plist')
    : join(homedir(), '.config', 'systemd', 'user', 'hexbot.service')
const options = (): ServiceFileOptions => ({
  executable: serviceExecutable(),
  home: hexbotHome(),
  path: [binDir(), ...(process.env.PATH ?? '').split(delimiter).filter(path => path !== join(hexbotHome(), 'runtime', 'venv', 'bin'))].join(delimiter),
  node: process.env.APPIMAGE ?? process.execPath, // an AppImage's execPath vanishes when it quits
  logDir: join(hexbotHome(), 'logs')
})

export async function installService(): Promise<void> {
  const file = servicePath()
  await mkdir(dirname(file), { recursive: true })
  await mkdir(join(hexbotHome(), 'logs'), { recursive: true })
  if (process.platform === 'darwin') {
    await writeFile(file, launchdPlist(options()))
    try {
      await exec('launchctl', ['bootstrap', `gui/${process.getuid!()}`, file])
    } catch {
      await exec('launchctl', ['load', '-w', file])
    }
  } else if (process.platform === 'linux') {
    await writeFile(file, systemdUnit(options()))
    await exec('systemctl', ['--user', 'daemon-reload'])
    await exec('systemctl', ['--user', 'enable', '--now', 'hexbot'])
  } else throw new Error(`Services are unsupported on ${process.platform}`)
}

export async function uninstallService(): Promise<void> {
  const file = servicePath()
  if (process.platform === 'darwin') {
    try {
      await exec('launchctl', ['bootout', `gui/${process.getuid!()}`, file])
    } catch {
      try {
        await exec('launchctl', ['unload', '-w', file])
      } catch {}
    }
  } else if (process.platform === 'linux') {
    try {
      await exec('systemctl', ['--user', 'disable', '--now', 'hexbot'])
    } catch {}
    await exec('systemctl', ['--user', 'daemon-reload'])
  }
  await rm(file, { force: true })
}

export async function serviceStatus(): Promise<{ installed: boolean; running: boolean }> {
  try {
    if (process.platform === 'darwin')
      await exec('launchctl', ['print', `gui/${process.getuid!()}/app.hexbot.daemon`])
    else if (process.platform === 'linux')
      await exec('systemctl', ['--user', 'is-active', 'hexbot'])
    else return { installed: false, running: false }
    return { installed: true, running: true }
  } catch {
    const { existsSync } = await import('node:fs')
    return { installed: existsSync(servicePath()), running: false }
  }
}

// Rewrite only the service for this home, once the native bundle is verified.
export async function migrateLegacyService(
  file = servicePath(), targetPlatform = process.platform,
  config = options(), run: (command: string, args: string[]) => Promise<unknown> = exec
): Promise<void> {
  const old = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const legacy = join(config.home, 'runtime', 'venv', 'bin', 'hexbot')
  const escaped = legacy.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const legacyEntry = targetPlatform === 'darwin' ? `<string>${escaped}</string>`
    : `ExecStart="${legacy.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" serve`
  if (!old.includes(legacyEntry)) return
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
