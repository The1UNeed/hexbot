import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const desktopRoot = join(repositoryRoot, 'apps/desktop')
const destination = join(desktopRoot, 'resources/hexbot-src')
const excludedRoots = new Set(['apps', 'web', 'tests', 'docs', 'node_modules', 'venv', '.venv', '.git', '.github', 'dist'])

function include(source) {
  const path = relative(repositoryRoot, source)
  const parts = path.split(/[\\/]/)
  if (parts.length === 1 && excludedRoots.has(parts[0])) return false
  return !parts.some(part => part === '__pycache__' || part === '.venv' || part === 'node_modules' || part === 'dist' || part.endsWith('.pyc'))
}

const packageJson = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'))
let commit = 'unknown'
try { commit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim() } catch { /* Source archives may not contain Git metadata. */ }

await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
for (const entry of await readdir(repositoryRoot)) {
  if (excludedRoots.has(entry)) continue
  await cp(join(repositoryRoot, entry), join(destination, entry), { recursive: true, filter: include })
}

const webDist = join(repositoryRoot, 'apps/web/dist')
try { await cp(webDist, join(destination, 'apps/web/dist'), { recursive: true }) } catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
await writeFile(join(destination, 'HEXBOT_BUILD.json'), `${JSON.stringify({ version: packageJson.version, commit, date: new Date().toISOString() }, null, 2)}\n`)
console.log(`Staged Hexbot ${packageJson.version} Python source at ${destination}`)
