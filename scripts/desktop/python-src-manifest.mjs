import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

export const excludedRoots = new Set([
  'apps',
  'backend',
  'web',
  'tests',
  'docs',
  'node_modules',
  'venv',
  '.venv',
  '.git',
  '.github',
  '.hexbot',
  '.t3',
  '.env',
  'HEXBOT_NATIVE_TRANSITION.json',
  'dist'
])

export function includePythonSource(repositoryRoot, source) {
  const path = relative(repositoryRoot, source)
  const parts = path.split(/[\\/]/)
  if (parts.length === 1 && excludedRoots.has(parts[0])) return false
  return !parts.some(
    part =>
      part === '__pycache__' ||
      part === '.venv' ||
      part === 'node_modules' ||
      part === 'dist' ||
      part.endsWith('.pyc')
  )
}

export async function stagePythonSource(repositoryRoot, destination, { nativeTransitionVersion } = {}) {
  if (nativeTransitionVersion !== undefined && !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(nativeTransitionVersion)) {
    throw new Error('Invalid native transition version')
  }
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
  if (nativeTransitionVersion !== undefined) {
    await writeFile(join(destination, 'HEXBOT_NATIVE_TRANSITION.json'), `${JSON.stringify({ version: nativeTransitionVersion })}\n`)
  }
}
