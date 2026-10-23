import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const powershell = process.platform === 'win32'
  ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : process.env.HEXBOT_TEST_POWERSHELL

test('actual protocol predicate only matches exact owned REG_SZ commands', { skip: !powershell }, async () => {
  const source = await readFile('backend/hexbot-installer/src/windows-protocol-binding.ps1', 'utf8')
  const owned = '"C:\\José state\\app.hexbot.client\\HexbotClient.exe" "%1"'
  const cases = [
    [owned, 'String', true], [owned.toLowerCase(), 'String', true],
    [owned, 'ExpandString', false], [owned, 'MultiString', false],
    [owned.replace('client\\', 'client.nightly\\'), 'String', false],
    [owned.replace('HexbotClient.exe', 'Hexbot.exe'), 'String', false],
    [owned.replaceAll('"', ''), 'String', false], [`${owned} extra`, 'String', false],
    [owned.replace('%1', '%L'), 'String', false], [`${owned}\r\n`, 'String', false],
    [owned.replace('José', 'other'), 'String', false], ['x'.repeat(4201), 'String', false],
    [null, 'String', false], [42, 'String', false]
  ]
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);${source}
$data=$env:HEXBOT_PROTOCOL_TEST|ConvertFrom-Json
$result=@(foreach($case in $data.cases){Test-HexbotProtocolBinding $case[0] $case[1] @($data.owned)})
ConvertTo-Json -InputObject $result -Compress`
  const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, HEXBOT_PROTOCOL_TEST: JSON.stringify({ owned, cases }) }, windowsHide: true
  })
  assert.deepEqual(JSON.parse(stdout), cases.map(([, , match]) => match))
})

test('pinned Electron registers at app startup while pinned NSIS has no protocol cleanup hook', async () => {
  const desktop = createRequire(resolve('apps/desktop/package.json'))
  assert.equal(desktop('electron/package.json').version, '41.10.7')
  const builder = createRequire(desktop.resolve('electron-builder'))
  const root = dirname(builder.resolve('app-builder-lib/package.json'))
  const nsis = await readFile(join(root, 'out/targets/nsis/NsisTarget.js'), 'utf8')
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'))).version, '26.16.1')
  assert.doesNotMatch(nsis, /protocols|unregisterProtocol/i)
  assert.match(nsis, /fileAssociations\.length !== 0/)
  assert.match(nsis, /macro\("unregisterFileAssociations", unregisterFileAssociationsScript\)/)
  const index = await readFile('apps/desktop/src/main/index.ts', 'utf8')
  assert.match(index, /if \(app\.isPackaged\) app\.setAsDefaultProtocolClient\('hexbot'\)/)
  // The runtime command format is independently asserted after launching the
  // actual installed GUI in windows_contract.rs, for both editions/tracks.
  const packager = createRequire(builder.resolve('app-builder-lib/out/packager.js'))
  const base = packager('js-yaml').load(await readFile('apps/desktop/electron-builder.base.yml', 'utf8'))
  assert.deepEqual(base.protocols[0].schemes, ['hexbot'])
  assert.equal(base.fileAssociations, undefined)
})
