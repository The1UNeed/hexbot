import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app } from 'electron'

export function hexbotHome(): string {
  return process.env.HEXBOT_HOME?.trim() || join(homedir(), '.hexbot')
}

export const runtimeDir = (): string => join(hexbotHome(), 'runtime')
export const nativeDir = (version = app.getVersion()): string => join(runtimeDir(), 'native', version)
export function nativeServiceExecutable(platform = process.platform): string {
  if (platform !== 'win32') return join(runtimeDir(), 'native-executable')
  const selected = JSON.parse(readFileSync(join(runtimeDir(), 'native-current.json'), 'utf8')) as { executable: string }
  const executable = realpathSync(selected.executable)
  const root = realpathSync(join(runtimeDir(), 'native'))
  const relativePath = relative(root, executable)
  if (relativePath.startsWith('..') || isAbsolute(relativePath) || basename(executable) !== 'hexbot.exe')
    throw new Error('Invalid Windows runtime selection')
  return executable
}
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
  if (app.isPackaged) return nativeServiceExecutable()
  const native = process.env.HEXBOT_EXECUTABLE || join(repoRoot(), 'backend', 'hexbot-core', 'target', 'debug', process.platform === 'win32' ? 'hexbot.exe' : 'hexbot')
  if (!existsSync(native)) throw new Error('Hexbot daemon is missing. Run pnpm dev --desktop.')
  return native
}
