// Like T3 Code's electron-launcher.mjs, brand a private copy of Electron so
// macOS uses the development name and icon in the Dock and app switcher.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { productName } from '../desktop/release-version.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export async function prepareDevElectron(repositoryRoot = root) {
  const desktop = join(repositoryRoot, 'apps/desktop')
  const require = createRequire(join(desktop, 'package.json'))
  const electron = require('electron')
  if (process.platform !== 'darwin') return electron

  const client = process.env.HEXBOT_EDITION === 'client'
  const name = productName('dev', '', client)
  const checkoutId = createHash('sha256').update(repositoryRoot).digest('hex').slice(0, 12)
  const bundleId = `app.hexbot.${client ? 'client' : 'desktop'}.dev.${checkoutId}`
  const cache = join(desktop, '.electron-runtime', client ? 'client' : 'full')
  const bundle = join(cache, `${name}.app`)
  const binary = join(bundle, 'Contents/MacOS/Electron')
  const source = resolve(electron, '../../..')
  const icon = join(desktop, 'build/icon-dev.icns')
  const metadataPath = join(cache, 'metadata.json')
  const metadata = JSON.stringify({
    launcherVersion: 1, source, bundleId, name,
    electronVersion: require('electron/package.json').version,
    electronMtime: (await stat(electron)).mtimeMs,
    iconHash: createHash('sha256').update(await readFile(icon)).digest('hex')
  })
  const previous = await readFile(metadataPath, 'utf8').catch(() => '')
  if (previous === metadata && await stat(binary).catch(() => false)) return binary

  await mkdir(cache, { recursive: true })
  await rm(bundle, { recursive: true, force: true })
  // Preserve framework symlinks inside the copied bundle.
  await cp(source, bundle, { recursive: true, verbatimSymlinks: true })
  const plist = join(bundle, 'Contents/Info.plist')
  for (const [key, value] of Object.entries({
    CFBundleName: name,
    CFBundleDisplayName: name,
    CFBundleIdentifier: bundleId,
    CFBundleIconFile: 'icon-dev.icns'
  })) {
    execFileSync('plutil', ['-replace', key, '-string', value, plist])
  }
  await copyFile(icon, join(bundle, 'Contents/Resources/icon-dev.icns'))
  // Keep the native executable named Electron so app.isPackaged stays false.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', bundle], {
    stdio: 'pipe'
  })
  await writeFile(metadataPath, metadata)
  return binary
}
