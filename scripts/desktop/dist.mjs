// Build one desktop package.
//   --mac|--linux        platform (required)
//   --client             the client-only edition (no daemon runtime)
//   --channel <name>     stable | nightly | dev (default dev). See docs/channels.md.
// Remaining arguments go to electron-builder.
import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { productName } from './release-version.mjs'
import { iconOptions, parseBuildArgs } from './build-config.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const desktopRoot = resolve(repositoryRoot, 'apps/desktop')
const { client, channel, builderArgs } = parseBuildArgs(process.argv.slice(2))

// Each channel is the same code with a different name, so users can tell
// builds apart and install them side by side. Artifact names already carry
// the channel through the SemVer prerelease suffix (0.1.5-alpha.1,
// 0.1.5-nightly.20260906.42). Dev also selects its own icon.
const version = JSON.parse(await readFile(resolve(desktopRoot, 'package.json'), 'utf8')).version
if (channel === 'nightly' && !version.includes('-nightly.'))
  throw new Error(
    `A nightly build needs a nightly version, got ${version} (scripts/desktop/set-version.mjs)`
  )
const appId = client ? 'app.hexbot.client' : 'app.hexbot.desktop'
const name = productName(channel, version, client)
const channelArgs = [
  `-c.productName=${name}`,
  // Also written into the packaged package.json so app.name (the About item,
  // the tray menu, notifications) shows the product name, not @hexbot/desktop.
  `-c.extraMetadata.productName=${name}`,
  ...(channel === 'stable' ? [] : [`-c.appId=${appId}.${channel}`])
]
if (!builderArgs.some(arg => arg === '--mac' || arg === '--linux'))
  throw new Error(
    'Usage: node scripts/desktop/dist.mjs --mac|--linux [--client] [--channel stable|nightly|dev] [electron-builder options]'
  )

const env = { ...process.env, HEXBOT_EDITION: client ? 'client' : 'full', HEXBOT_CHANNEL: channel }
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

await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
  'run',
  client ? 'build:client' : 'build'
])
await run(resolve(repositoryRoot, 'node_modules/.bin/electron-builder'), [
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
