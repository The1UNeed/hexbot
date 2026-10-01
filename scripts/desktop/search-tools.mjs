// Pi prefers its managed bin directory to PATH. Replace old downloads before
// loading Pi, using only the tools verified by staging or the dev installer.
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function fingerprint(path) {
  const stats = await lstat(path)
  if (!stats.isFile()) return undefined
  return { size: stats.size, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
}

async function matches(path, wanted) {
  const actual = await fingerprint(path).catch(() => undefined)
  return actual?.size === wanted.size && actual.sha256 === wanted.sha256
}

async function onPath(tool, wanted, path = process.env.PATH ?? '') {
  for (const directory of path.split(delimiter).filter(Boolean))
    if (await matches(join(directory, tool), wanted)) return true
  return false
}

export async function prepareSearchTools(source, agentDirectory, log = message => console.error(message)) {
  if (!agentDirectory) throw new Error('PI_CODING_AGENT_DIR is required')
  const bin = join(agentDirectory, 'bin')
  await mkdir(bin, { recursive: true })
  for (const tool of ['rg', 'fd']) {
    const wanted = await fingerprint(join(source, tool))
    if (!wanted) throw new Error(`Verified ${tool} is missing from ${source}`)
    const destination = join(bin, tool)
    if (await matches(destination, wanted)) continue
    const staging = join(bin, `.${tool}-${process.pid}-${Date.now()}`)
    try {
      await copyFile(join(source, tool), staging)
      await chmod(staging, 0o755)
      await rename(staging, destination)
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined)
      // A section must not wait on a copy that failed while Pi can still find
      // the verified tool: another launcher may have copied it, or PATH has it.
      if (await matches(destination, wanted)) continue
      if (!(await onPath(tool, wanted))) throw error
      // Pi takes anything in its bin directory before PATH, so no stale copy may stay.
      await rm(destination, { force: true })
      log(`search tools: ${tool} not copied (${error.message}); using the verified copy on PATH`)
    }
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url)))
  await prepareSearchTools(process.argv[2], process.env.PI_CODING_AGENT_DIR)
