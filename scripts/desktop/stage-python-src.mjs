import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { stagePythonSource } from './python-src-manifest.mjs'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const desktopRoot = join(repositoryRoot, 'apps/desktop')
const destination = join(desktopRoot, 'resources/hexbot-src')
const packageJson = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'))
let commit = 'unknown'
try {
  commit = (
    await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })
  ).stdout.trim()
} catch {
  /* Source archives may not contain Git metadata. */
}

await stagePythonSource(repositoryRoot, destination)
await writeFile(
  join(destination, 'HEXBOT_BUILD.json'),
  `${JSON.stringify({ version: packageJson.version, commit, date: new Date().toISOString() }, null, 2)}\n`
)
console.log(`Staged Hexbot ${packageJson.version} Python source at ${destination}`)
