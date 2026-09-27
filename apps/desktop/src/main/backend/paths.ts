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
export const venvDir = (): string => join(runtimeDir(), 'venv')
export const binDir = (): string => join(hexbotHome(), 'bin')
export const srcDir = (version: string): string => join(runtimeDir(), 'src', version)

export function repoRoot(): string {
  const appPath = app?.getAppPath?.()
  return appPath
    ? resolve(appPath, '../..')
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
}

function packagedNative(): boolean {
  return app.isPackaged && Boolean(process.resourcesPath && existsSync(join(process.resourcesPath, 'hexbot-native', 'manifest.json')))
}

export function activeSourceDir(version = app.getVersion()): string {
  if (packagedNative()) return nativeDir(version)
  return app.isPackaged ? srcDir(version) : repoRoot()
}

export function hexbotExecutable(): string {
  if (packagedNative()) return nativeExecutable()
  if (!app.isPackaged) {
    const backend = process.env.HEXBOT_BACKEND || 'rust'
    if (!['rust', 'python'].includes(backend)) throw new Error('HEXBOT_BACKEND must be rust or python')
    if (backend === 'rust') {
      const native = process.env.HEXBOT_EXECUTABLE || join(repoRoot(), 'backend', 'hexbot-core', 'target', 'debug', 'hexbot')
      if (!existsSync(native)) throw new Error('Rust daemon is missing. Run pnpm dev --desktop.')
      return native
    }
    const developmentExecutable = join(repoRoot(), 'venv', 'bin', 'hexbot')
    if (existsSync(developmentExecutable)) return developmentExecutable
  }
  return join(venvDir(), 'bin', 'hexbot')
}

export function serviceExecutable(): string {
  return packagedNative() ? nativeServiceExecutable() : hexbotExecutable()
}
