import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, delimiter } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { binDir, hexbotExecutable, hexbotHome, venvDir } from './backend/paths'
import { launchdPlist, systemdUnit, type ServiceFileOptions } from './service-files'

const exec = promisify(execFile)
const servicePath = (): string =>
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'LaunchAgents', 'app.hexbot.daemon.plist')
    : join(homedir(), '.config', 'systemd', 'user', 'hexbot.service')
const options = (): ServiceFileOptions => ({
  executable: hexbotExecutable(),
  home: hexbotHome(),
  path: [binDir(), join(venvDir(), 'bin'), process.env.PATH ?? ''].join(delimiter),
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
