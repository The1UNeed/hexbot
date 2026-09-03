import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stagePythonSource } from '../desktop/python-src-manifest.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const destination = join(repositoryRoot, 'docker/hexbot/context')
const temporary = await mkdtemp(join(tmpdir(), 'hexbot-docker-context-'))

try {
  await stagePythonSource(repositoryRoot, temporary)
  await rm(destination, { recursive: true, force: true })
  await cp(temporary, destination, { recursive: true })
} finally {
  await rm(temporary, { recursive: true, force: true })
}
console.log(`Staged Docker context at ${destination}`)
