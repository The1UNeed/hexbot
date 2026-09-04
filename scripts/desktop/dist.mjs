// Build one desktop package.
//   --mac|--linux        platform (required)
//   --client             the client-only edition (no daemon runtime)
// Remaining arguments go to electron-builder.
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const desktopRoot = resolve(repositoryRoot, 'apps/desktop')
const args = process.argv.slice(2)
const client = args.includes('--client')
const builderArgs = args.filter(arg => arg !== '--client')
if (!builderArgs.some(arg => arg === '--mac' || arg === '--linux'))
  throw new Error(
    'Usage: node scripts/desktop/dist.mjs --mac|--linux [--client] [electron-builder options]'
  )

const env = { ...process.env, HEXBOT_EDITION: client ? 'client' : 'full' }
if (!env.CSC_LINK && !env.CSC_NAME) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'

function run(command, commandArgs) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, commandArgs, { cwd: desktopRoot, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code =>
      code === 0
        ? resolveRun()
        : reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    )
  })
}

await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
  'run',
  client ? 'build:client' : 'build'
])
await run(resolve(repositoryRoot, 'node_modules/.bin/electron-builder'), [
  ...builderArgs,
  ...(client ? ['--config', 'electron-builder.client.yml'] : []),
  '--publish',
  'never'
]).catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
