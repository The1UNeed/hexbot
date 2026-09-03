import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'

export const excludedRoots = new Set([
  'apps',
  'web',
  'tests',
  'docs',
  'node_modules',
  'venv',
  '.venv',
  '.git',
  '.github',
  'dist'
])

export function includePythonSource(repositoryRoot, source) {
  const path = relative(repositoryRoot, source)
  const parts = path.split(/[\\/]/)
  if (parts.length === 1 && excludedRoots.has(parts[0])) return false
  if (parts.join('/') === 'docker/hexbot/context') return false
  return !parts.some(
    part =>
      part === '__pycache__' ||
      part === '.venv' ||
      part === 'node_modules' ||
      part === 'dist' ||
      part.endsWith('.pyc')
  )
}

export async function stagePythonSource(repositoryRoot, destination) {
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(repositoryRoot)) {
    if (excludedRoots.has(entry)) continue
    await cp(join(repositoryRoot, entry), join(destination, entry), {
      recursive: true,
      filter: source => includePythonSource(repositoryRoot, source)
    })
  }

  try {
    await cp(join(repositoryRoot, 'apps/web/dist'), join(destination, 'apps/web/dist'), {
      recursive: true
    })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
