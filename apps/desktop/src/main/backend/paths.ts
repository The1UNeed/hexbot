import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app } from 'electron'

export function hexbotHome(): string {
  return process.env.HEXBOT_HOME?.trim() || join(homedir(), '.hexbot')
}

export const runtimeDir = (): string => join(hexbotHome(), 'runtime')
export const venvDir = (): string => join(runtimeDir(), 'venv')
export const binDir = (): string => join(hexbotHome(), 'bin')
export const srcDir = (version: string): string => join(runtimeDir(), 'src', version)

export function repoRoot(): string {
  const appPath = app?.getAppPath?.()
  return appPath ? resolve(appPath, '../..') : resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
}

export function activeSourceDir(version = app.getVersion()): string {
  return app.isPackaged ? srcDir(version) : repoRoot()
}

export function hexbotExecutable(): string {
  if (!app.isPackaged) {
    const developmentExecutable = join(repoRoot(), 'venv', 'bin', 'hexbot')
    if (existsSync(developmentExecutable)) return developmentExecutable
  }
  return join(venvDir(), 'bin', 'hexbot')
}
