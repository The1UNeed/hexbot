import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { appId, productName } from './release-version.mjs'

test('actual pinned AppInfo and NSIS use executable-based uninstall names for all four release identities', async () => {
  const desktop = createRequire(resolve('apps/desktop/package.json'))
  const builder = createRequire(desktop.resolve('electron-builder'))
  const packager = createRequire(builder.resolve('app-builder-lib/out/packager.js'))
  const { AppInfo } = packager('./appInfo.js')
  const { load } = packager('js-yaml')
  const base = load(await readFile('apps/desktop/electron-builder.base.yml', 'utf8'))
  const clientConfig = load(await readFile('apps/desktop/electron-builder.client.yml', 'utf8'))
  const metadata = JSON.parse(await readFile('apps/desktop/package.json', 'utf8'))
  const rust = await readFile('backend/hexbot-installer/src/windows_nsis.rs', 'utf8')
  const names = [...rust.split('fn uninstaller_filename')[1].split('pub(crate) fn uninstaller_name')[0].matchAll(/"(Uninstall [^"\n]+\.exe)"/g)].map(match => match[1])
  assert.equal(names.length, 2)
  for (const client of [false, true]) for (const channel of ['stable', 'nightly']) {
    const version = channel === 'stable' ? metadata.version : '0.1.5-nightly.20990101.1'
    const edition = client ? clientConfig : {}
    const info = new AppInfo({ metadata: { ...metadata, version }, config: {
      ...base, ...edition, appId: appId(channel, client), productName: productName(channel, version, client)
    } }, null, { ...base.win, ...edition.win })
    assert.equal(`Uninstall ${info.productFilename}.exe`, names[client ? 0 : 1], info.id)
  }
  const templates = join(dirname(builder.resolve('app-builder-lib/package.json')), 'templates/nsis')
  const common = await readFile(join(templates, 'common.nsh'), 'utf8')
  const registry = await readFile(join(templates, 'include/installer.nsh'), 'utf8')
  assert.match(common, /!define UNINSTALL_FILENAME "Uninstall \$\{PRODUCT_FILENAME\}\.exe"/)
  assert.match(registry, /StrCpy \$2 "\$INSTDIR\\\$\{UNINSTALL_FILENAME\}"/)
  assert.match(registry, /WriteRegStr SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" UninstallString '"\$2" \$0'/)
  assert.match(registry, /StrCpy \$0 "\/currentuser"/)
})

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

test('pinned NSIS kill policy is raw prefix or same-user edition image, with unchanged availability probes', async () => {
  const desktop = createRequire(resolve('apps/desktop/package.json'))
  const builder = createRequire(desktop.resolve('electron-builder'))
  const templates = join(dirname(builder.resolve('app-builder-lib/package.json')), 'templates/nsis')
  const macro = await readFile(join(templates, 'include/allowOnlyOneInstallerInstance.nsh'), 'utf8')
  const target = await readFile(join(dirname(builder.resolve('app-builder-lib/package.json')), 'out/targets/nsis/NsisTarget.js'), 'utf8')
  assert.match(target, /const pluginArch = this.isUnicodeEnabled \? "x86-unicode" : "x86-ansi"/)
  const { readdir } = await import('node:fs/promises')
  for (const file of await readdir(templates, { recursive: true })) {
    if (!/\.ns[hi]$/.test(file)) continue
    assert.doesNotMatch(await readFile(join(templates, file), 'utf8'), /Wow64DisableWow64FsRedirection|DisableX64FSRedirection/i)
  }
  const rust = await readFile('backend/hexbot-installer/src/windows_nsis_process.rs', 'utf8')
  for (const symbol of ['AVAILABLE_PROBE', 'POLICY_PROBE']) {
    const script = rust.match(new RegExp(`const ${symbol}: &str =\\s*"([^"]+)"`))?.[1]
    assert(script)
    assert(macro.includes(script), `${symbol} must mirror pinned NSIS`)
  }
  assert.match(macro, /Path\.StartsWith\('\$INSTDIR', 'CurrentCultureIgnoreCase'\)/)
  assert.match(macro, /FIND_PROCESS "\$\{APP_EXECUTABLE_FILENAME\}"/)
  assert.match(macro, /USERNAME eq %USERNAME%/)
  assert.match(macro, /taskkill \$0 \/IM "\$\{_FILE\}"/)
  assert.match(macro, /\/SD IDOK IDOK doStopProcess/)
  assert.doesNotMatch(rust, /"-ExecutionPolicy"|PSExecutionPolicyPreference/)
  const util = await readFile(join(templates, 'include/installUtil.nsh'), 'utf8')
  assert.match(util, /Uninstall was not successful\. Not able to launch uninstaller![\s\S]*?Return/)
})

test('actual shared process predicates preserve external daemons and refuse sibling prefixes/fallback aliases', async t => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const powershell = process.platform === 'win32'
    ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : process.env.HEXBOT_TEST_POWERSHELL
  if (!powershell) return t.skip('requires PowerShell for the actual .NET predicates')
  const policy = await readFile('backend/hexbot-installer/src/windows-nsis-process-policy.ps1', 'utf8')
  const script = `${policy}
$d='C:\\apps\\app.hexbot.desktop'
$prefix=Test-HexbotNsisPrefix ($d+'.nightly\\Hexbot.exe') @($d)
$proper=($d+'.nightly\\Hexbot.exe').StartsWith($d+'\\','CurrentCultureIgnoreCase')
$external=Test-HexbotNsisPrefix 'C:\\external\\runtime\\native\\build\\hexbot.exe' @($d)
$fallback=Test-HexbotNsisImage 'hexbot.exe' 'Hexbot.exe' 'José' 'José' 'S-1-5-21-1' 'S-1-5-21-1' 'S-1-5-21-1'
$client=Test-HexbotNsisImage 'hexbot.exe' 'HexbotClient.exe' 'José' 'José' 'S-1-5-21-1' 'S-1-5-21-1' 'S-1-5-21-1'
$uncertain=$false;try {Test-HexbotNsisImage 'Hexbot.exe' 'Hexbot.exe' 'José' 'José' '' '' 'S-1-5-21-1' >$null} catch {$uncertain=$true}
ConvertTo-Json -Compress -InputObject @($prefix,$proper,$external,$fallback,$client,$uncertain)`
  const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
  assert.deepEqual(JSON.parse(stdout), [true, false, false, true, false, true])
})
