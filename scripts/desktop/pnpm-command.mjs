import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

// Invoke pnpm without cmd.exe re-parsing product names or CLI arguments.
export async function pnpmCommand() {
  if (process.platform !== 'win32') return { command: 'pnpm', prefix: [] }
  const { stdout } = await promisify(execFile)('where.exe', ['pnpm'])
  return windowsPnpmCommand(stdout.trim().split(/\r?\n/))
}

export function windowsPnpmCommand(paths, node = process.execPath) {
  const regular = path => { try { return statSync(path).isFile() } catch { return false } }
  const executable = paths.find(path => path.toLowerCase().endsWith('.exe') && regular(path))
  if (executable) return { command: executable, prefix: [] }
  const candidates = paths.flatMap(path => [join(dirname(path), '../pnpm/bin/pnpm.cjs'), join(dirname(path), 'node_modules/pnpm/bin/pnpm.cjs'), join(dirname(path), 'node_modules/corepack/dist/pnpm.js')])
  const entrypoint = candidates.find(regular)
  if (!entrypoint) throw new Error('Cannot locate the pnpm JavaScript entrypoint. Install pnpm with Corepack, npm or pnpm/action-setup.')
  return { command: node, prefix: [entrypoint] }
}
