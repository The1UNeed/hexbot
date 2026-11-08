import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

// Invoke pnpm without cmd.exe re-parsing product names or CLI arguments.
export async function pnpmCommand() {
  if (process.platform !== 'win32') return { command: 'pnpm', prefix: [] }
  const { stdout } = await promisify(execFile)('where.exe', ['pnpm'])
  const paths = stdout.trim().split(/\r?\n/)
  const executable = paths.find(path => path.toLowerCase().endsWith('.exe'))
  if (executable) return { command: executable, prefix: [] }
  const candidates = paths.flatMap(path => [join(dirname(path), '../pnpm/bin/pnpm.cjs'), join(dirname(path), 'node_modules/pnpm/bin/pnpm.cjs')])
  const entrypoint = candidates.find(existsSync)
  if (!entrypoint) throw new Error('Cannot locate the pnpm JavaScript entrypoint. Install pnpm with npm or pnpm/action-setup.')
  return { command: process.execPath, prefix: [entrypoint] }
}
