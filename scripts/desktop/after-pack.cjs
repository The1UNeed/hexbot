// electron-builder afterPack hook.
//
// When no Developer ID identity is configured (CSC_LINK / CSC_NAME unset),
// electron-builder skips signing entirely. On Apple Silicon an unsigned
// Mach-O is killed by the kernel at launch, so ad-hoc sign the bundle. Signed
// builds (identity present) are left to electron-builder's own signing and
// notarization.
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_LINK || process.env.CSC_NAME) return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed ${appPath}`)
}
