import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app } from 'electron'

export function hexbotHome(): string {
  return process.env.HEXBOT_HOME?.trim() || join(homedir(), '.hexbot')
}

export const runtimeDir = (): string => join(hexbotHome(), 'runtime')
export const nativeDir = (version = app.getVersion()): string => join(runtimeDir(), 'native', version)
export const nativeServiceExecutable = (): string => join(runtimeDir(), 'native-executable')
export const binDir = (): string => join(hexbotHome(), 'bin')

export function repoRoot(): string {
  const appPath = app?.getAppPath?.()
  return appPath
    ? resolve(appPath, '../..')
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
}

// The daemon's working directory.
export function daemonDirectory(): string {
  return app.isPackaged ? runtimeDir() : repoRoot()
}

export function hexbotExecutable(): string {
  if (app.isPackaged) {
    if (process.platform !== 'win32') return nativeServiceExecutable()
    // Windows file links require privileges. The daemon's updater and the app
    // select the same immutable executable through this atomic metadata file.
    const selected = JSON.parse(readFileSync(join(runtimeDir(), 'native-current.json'), 'utf8')) as { executable?: string }
    if (!selected.executable || !existsSync(selected.executable)) throw new Error('Hexbot runtime is missing. Restart the app to repair it.')
    return selected.executable
  }
  const native = process.env.HEXBOT_EXECUTABLE || join(repoRoot(), 'backend', 'hexbot-core', 'target', 'debug', `hexbot${process.platform === 'win32' ? '.exe' : ''}`)
  if (!existsSync(native)) throw new Error('Hexbot daemon is missing. Run pnpm dev --desktop.')
  return native
}
