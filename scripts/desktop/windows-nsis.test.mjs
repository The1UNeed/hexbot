import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

test('known NSIS identities match the pinned builder GUIDs and current-user registry semantics', async () => {
  const desktop = createRequire(resolve('apps/desktop/package.json'))
  const builder = createRequire(desktop.resolve('electron-builder'))
  const packager = createRequire(builder.resolve('app-builder-lib/out/packager.js'))
  const { UUID } = packager('builder-util-runtime')
  const root = dirname(builder.resolve('app-builder-lib/package.json'))
  assert.equal(packager('./../package.json').version, '26.16.1')
  const rust = await readFile('backend/hexbot-installer/src/windows_nsis.rs', 'utf8')
  const identities = [...rust.matchAll(/"(app\.hexbot\.(?:desktop|client)(?:\.nightly)?)",\s*"([a-f0-9-]{36})"/g)]
  assert.equal(identities.length, 4)
  for (const [, id, guid] of identities) assert.equal(UUID.v5(id, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')), guid)
  const source = await readFile(join(root, 'out/targets/nsis/NsisTarget.js'), 'utf8')
  assert.match(source, /options\.guid \|\| builder_util_runtime_1\.UUID\.v5\(appInfo\.id, ELECTRON_BUILDER_NS_UUID\)/)
  const templates = join(root, 'templates/nsis')
  const init = await readFile(join(templates, 'assistedInstaller.nsh'), 'utf8')
  assert.match(init, /GetOptions.*"\/currentuser"[\s\S]*StrCpy \$hasPerMachineInstallation "0"[\s\S]*StrCpy \$hasPerUserInstallation "1"/)
  assert.match(await readFile(join(templates, 'common.nsh'), 'utf8'), /SetRegView 64/)
  const install = await readFile(join(templates, 'installSection.nsh'), 'utf8')
  assert.match(install, /uninstallOldVersion SHELL_CONTEXT/)
  const registry = await readFile(join(templates, 'multiUser.nsh'), 'utf8')
  assert.match(registry, /INSTALL_REGISTRY_KEY "Software\\\$\{APP_GUID\}"/)
  assert.match(registry, /UNINSTALL_REGISTRY_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\$\{UNINSTALL_APP_KEY\}"/)
})
