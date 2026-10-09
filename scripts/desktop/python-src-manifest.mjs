import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Explicit files keep tests, caches and unrelated source out of the service feed.
export const handoffFiles = [
  'pyproject.toml',
  'uv.lock',
  'hexbot/__init__.py',
  'hexbot/cli.py',
  'hexbot/native_transition.py',
  'hexbot/update_signature.py'
]

export async function stagePythonSource(repositoryRoot, destination, { nativeTransitionVersion } = {}) {
  if (typeof nativeTransitionVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(nativeTransitionVersion)) {
    throw new Error('Invalid native transition version')
  }
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  for (const file of handoffFiles) {
    const target = join(destination, file)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(repositoryRoot, 'backend/python-handoff', file), target)
  }
  await writeFile(join(destination, 'HEXBOT_NATIVE_TRANSITION.json'), `${JSON.stringify({ version: nativeTransitionVersion })}\n`)
}
