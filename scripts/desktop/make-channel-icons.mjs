// Compile the uploaded Icon Composer source with Apple's renderer. Commit the
// fallbacks so development and packaging also work without Xcode 26.
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const temporary = await mkdtemp(join(tmpdir(), 'hexbot-dev-icon-'))
try {
  execFileSync('xcrun', [
    'actool', join(root, 'icon-dev.icon'), '--compile', temporary,
    '--output-partial-info-plist', join(temporary, 'info.plist'),
    '--app-icon', 'icon-dev', '--include-all-app-icons',
    '--target-device', 'mac', '--minimum-deployment-target', '26.0',
    '--platform', 'macosx'
  ], { stdio: 'inherit' })
  const icon = join(temporary, 'icon-dev.icns')
  const iconset = join(temporary, 'dev.iconset')
  execFileSync('iconutil', ['-c', 'iconset', icon, '-o', iconset])
  await mkdir(join(root, 'apps/desktop/build'), { recursive: true })
  await mkdir(join(root, 'apps/desktop/resources'), { recursive: true })
  await copyFile(icon, join(root, 'apps/desktop/build/icon-dev.icns'))
  await copyFile(
    // actool emits a 256px fallback; larger native renditions live in Assets.car.
    join(iconset, 'icon_128x128@2x.png'),
    join(root, 'apps/desktop/resources/icon-dev.png')
  )
  console.log('Wrote build/icon-dev.icns and resources/icon-dev.png')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
