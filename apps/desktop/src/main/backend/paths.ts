import { existsSync } from 'node:fs'
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
export const nativeExecutable = (version = app.getVersion()): string => join(nativeDir(version), 'hexbot')
export const binDir = (): string => join(hexbotHome(), 'bin')

export function repoRoot(): string {
  const appPath = app?.getAppPath?.()
  return appPath
    ? resolve(appPath, '../..')
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
}

export function activeSourceDir(): string {
  return app.isPackaged ? runtimeDir() : repoRoot()
}

export function hexbotExecutable(): string {
  if (app.isPackaged) return nativeServiceExecutable()
  const native = process.env.HEXBOT_EXECUTABLE || join(repoRoot(), 'backend', 'hexbot-core', 'target', 'debug', 'hexbot')
  if (!existsSync(native)) throw new Error('Hexbot daemon is missing. Run pnpm dev --desktop.')
  return native
}

export function serviceExecutable(): string {
  return hexbotExecutable()
}
