// Compile a channel's Icon Composer bundle (apps/desktop/build/icon-<channel>.icon)
// with Apple's renderer into the ICNS and PNG fallbacks used by machines
// without Xcode 26 and by Linux. Commit the outputs with the source.
//   node scripts/desktop/make-channel-icons.mjs [dev|nightly ...]   (default: both)
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const desktop = join(root, 'apps/desktop')
const channels = process.argv.slice(2)
if (channels.length === 0) channels.push('dev', 'nightly')
for (const channel of channels)
  if (!['dev', 'nightly'].includes(channel))
    throw new Error(`Unknown channel "${channel}". Use dev or nightly; stable uses make-icons.py.`)

for (const channel of channels) {
  const name = `icon-${channel}`
  const temporary = await mkdtemp(join(tmpdir(), `hexbot-${name}-`))
  try {
    execFileSync('xcrun', [
      'actool', join(desktop, 'build', `${name}.icon`), '--compile', temporary,
      '--output-partial-info-plist', join(temporary, 'info.plist'),
      '--app-icon', name, '--include-all-app-icons',
      '--target-device', 'mac', '--minimum-deployment-target', '26.0',
      '--platform', 'macosx'
    ], { stdio: 'inherit' })
    const icon = join(temporary, `${name}.icns`)
    const iconset = join(temporary, `${channel}.iconset`)
    execFileSync('iconutil', ['-c', 'iconset', icon, '-o', iconset])
    await mkdir(join(desktop, 'build'), { recursive: true })
    await mkdir(join(desktop, 'resources'), { recursive: true })
    await copyFile(icon, join(desktop, 'build', `${name}.icns`))
    await copyFile(
      // actool emits a 256px fallback; larger native renditions live in Assets.car.
      join(iconset, 'icon_128x128@2x.png'),
      join(desktop, 'resources', `${name}.png`)
    )
    console.log(`Wrote build/${name}.icns and resources/${name}.png`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
