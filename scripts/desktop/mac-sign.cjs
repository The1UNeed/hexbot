const { join, resolve } = require('node:path')

// Keep Node's Intel V8 exception out of Electron and the client-only edition.
exports.default = async function sign(options, packager) {
  const optionsForFile = options.optionsForFile
  const node = join(options.app, 'Contents/Resources/hexbot-native/node')
  const pdf = join(options.app, 'Contents/Resources/hexbot-native/pdf/hexbot-pdf-vm')
  await packager.doSign({
    ...options,
    optionsForFile: file => ({
      ...optionsForFile(file),
      ...(file === node ? { entitlements: resolve(__dirname, '../../apps/desktop/entitlements.node.plist') } : {}),
      ...(file === pdf ? { entitlements: resolve(__dirname, '../../backend/pdf-runtime/macos/entitlements.plist') } : {})
    })
  }, { ...packager.platformSpecificBuildOptions, sign: null }, { name: options.identity })
}
