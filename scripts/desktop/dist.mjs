// Build one desktop package.
//   --mac|--linux|--win        platform (required)
//   --client             the client-only edition (no daemon runtime)
//   --channel <name>     stable | nightly | dev (default dev). See docs/channels.md.
// Remaining arguments go to electron-builder.
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { nativeBuildEnvironment } from './native-build.mjs'
import { appId, productName } from './release-version.mjs'
import { iconOptions, parseBuildArgs } from './build-config.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const desktopRoot = resolve(repositoryRoot, 'apps/desktop')
const rawArgs = process.argv.slice(2)
const { client, channel, builderArgs } = parseBuildArgs(rawArgs)

// Each channel is the same code with a different name, so users can tell
// builds apart and install them side by side. Artifact names already carry
// the channel through the SemVer prerelease suffix (0.1.5-alpha.1,
// 0.1.5-nightly.20260906.42). Dev also selects its own icon.
const version = JSON.parse(await readFile(resolve(desktopRoot, 'package.json'), 'utf8')).version
if (channel === 'nightly' && !version.includes('-nightly.'))
  throw new Error(
    `A nightly build needs a nightly version, got ${version} (scripts/desktop/set-version.mjs)`
  )
const name = productName(channel, version, client)
const channelArgs = [
  `-c.productName=${name}`,
  // Also written into the packaged package.json so app.name (the About item,
  // the tray menu, notifications) shows the product name, not @hexbot/desktop.
  `-c.extraMetadata.productName=${name}`,
  ...(channel === 'stable' ? [] : [`-c.appId=${appId(channel, client)}`])
]
if (!builderArgs.some(arg => arg === '--mac' || arg === '--linux' || arg === '--win'))
  throw new Error(
    'Usage: node scripts/desktop/dist.mjs --mac|--linux|--win [--client] [--channel stable|nightly|dev] [electron-builder options]'
  )

const env = { ...process.env, HEXBOT_EDITION: client ? 'client' : 'full', HEXBOT_CHANNEL: channel }
if (!client) Object.assign(env, nativeBuildEnvironment(builderArgs))
if (!env.CSC_LINK && !env.CSC_NAME) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'

// Xcode 26 compiles the channel's Icon Composer source into a layered macOS
// icon. Older machines use its committed ICNS fallback.
async function iconComposerAvailable() {
  if (process.platform !== 'darwin' || !builderArgs.includes('--mac')) return false
  try {
    const { stdout } = await promisify(execFile)('actool', ['--version'])
    const version = /short-bundle-version<\/key>\s*<string>(\d+)/.exec(stdout)?.[1]
    return Number(version) >= 26
  } catch {
    return false
  }
}
const iconArgs = iconOptions(channel, await iconComposerAvailable())

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

// Execute pnpm's JS entrypoint on Windows so product names containing spaces
// stay single arguments. cmd.exe would expand and split the builder options.
let pnpm = 'pnpm'
let pnpmPrefix = []
if (process.platform === 'win32') {
  const { stdout } = await promisify(execFile)('where.exe', ['pnpm'])
  const paths = stdout.trim().split(/\r?\n/)
  const executable = paths.find(path => path.toLowerCase().endsWith('.exe'))
  if (executable) pnpm = executable
  else {
    const candidates = paths.flatMap(path => [join(dirname(path), '../pnpm/bin/pnpm.cjs'), join(dirname(path), 'node_modules/pnpm/bin/pnpm.cjs')])
    const entrypoint = candidates.find(existsSync)
    if (!entrypoint) throw new Error('Cannot locate the pnpm JavaScript entrypoint. Install pnpm with npm or pnpm/action-setup.')
    pnpm = process.execPath
    pnpmPrefix = [entrypoint]
  }
}
await run(pnpm, [...pnpmPrefix, 'run', client ? 'build:client' : 'build'])
// Through pnpm so electron-builder detects pnpm. Its Windows fallback finds
// the root package.json workspaces field when its Unix `pwd` probe cannot run.
// Keep that declaration in sync with pnpm-workspace.yaml.
await run(pnpm, [
  ...pnpmPrefix,
  'exec',
  'electron-builder',
  ...builderArgs,
  ...channelArgs,
  ...iconArgs,
  ...(client ? ['--config', 'electron-builder.client.yml'] : []),
  '--publish',
  'never'
]).catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
