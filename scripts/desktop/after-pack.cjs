// electron-builder afterPack hook.
//
// When no Developer ID identity is configured (CSC_LINK / CSC_NAME unset),
// electron-builder skips signing entirely. On Apple Silicon an unsigned
// Mach-O is killed by the kernel at launch, so ad-hoc sign the bundle. Signed
// builds (identity present) are left to electron-builder's own signing and
// notarization.
const { execFileSync } = require('node:child_process')
const { existsSync, lstatSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_LINK || process.env.CSC_NAME) return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const pdf = join(appPath, 'Contents/Resources/hexbot-native/pdf/hexbot-pdf-vm')
  if (existsSync(pdf) && (!lstatSync(pdf).isFile() || !lstatSync(dirname(pdf)).isDirectory()))
    throw new Error('The PDF VM helper must be a regular file inside the app runtime')
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  if (existsSync(pdf)) {
    // Deep ad-hoc signing replaces nested entitlements. Restore only the VM
    // helper's entitlement, then reseal the app without rewriting its contents.
    execFileSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements',
      resolve(__dirname, '../../backend/pdf-runtime/macos/entitlements.plist'), pdf], { stdio: 'inherit' })
    execFileSync('codesign', ['--force', '--sign', '-', appPath], { stdio: 'inherit' })
  }
  console.log(`  • ad-hoc signed ${appPath}`)
}
