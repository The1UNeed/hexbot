// electron-builder afterPack hook.
//
// When no Developer ID identity is configured (CSC_LINK / CSC_NAME unset),
// electron-builder skips signing entirely. On Apple Silicon an unsigned
// Mach-O is killed by the kernel at launch, so ad-hoc sign the bundle. Signed
// builds (identity present) are left to electron-builder's own signing and
// notarization.
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { existsSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { readFile, writeFile } = require('node:fs/promises')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') {
    // electron-builder signs the app and unpacked ASAR, but extraResources
    // binaries need an explicit pass before the NSIS payload is created.
    const runtime = join(context.appOutDir, 'resources', 'hexbot-native')
    if (!existsSync(join(runtime, 'manifest.json'))) return
    for (const file of ['hexbot.exe', 'node.exe', 'bin/rg.exe', 'bin/fd.exe'])
      await context.packager.signIf(join(runtime, file))
    const manifest = JSON.parse(await readFile(join(runtime, 'manifest.json'), 'utf8'))
    for (const file of Object.keys(manifest.files))
      manifest.files[file] = createHash('sha256').update(await readFile(join(runtime, file))).digest('hex')
    await writeFile(join(runtime, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    return
  }
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_LINK || process.env.CSC_NAME) return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed ${appPath}`)
}
