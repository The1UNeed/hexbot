import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const desktopRoot = resolve(repositoryRoot, 'apps/desktop')
const args = process.argv.slice(2)
if (!args.some(arg => arg === '--mac' || arg === '--linux'))
  throw new Error('Usage: node scripts/desktop/dist.mjs --mac|--linux [electron-builder options]')

const env = { ...process.env }
if (!env.CSC_LINK && !env.CSC_NAME) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'

await new Promise((resolveRun, reject) => {
  const npm = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: desktopRoot,
    env,
    stdio: 'inherit'
  })
  npm.once('error', reject)
  npm.once('exit', code =>
    code === 0
      ? resolveRun()
      : reject(new Error(`npm run build exited with code ${code ?? 'unknown'}`))
  )
})

const builder = resolve(repositoryRoot, 'node_modules/.bin/electron-builder')
const code = await new Promise((resolveRun, reject) => {
  const child = spawn(builder, [...args, '--publish', 'never'], {
    cwd: desktopRoot,
    env,
    stdio: 'inherit'
  })
  child.once('error', reject)
  child.once('exit', resolveRun)
})
if (code !== 0) process.exitCode = typeof code === 'number' ? code : 1
