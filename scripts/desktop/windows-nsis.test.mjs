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
  assert.equal(base.nsis.perMachine, false, 'process fallback contract is per-user')
  assert.equal(base.nsis.allowElevation, false, 'outer install must not silently elevate')
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

test('actual registration producer emits literal null for absent values and preserves registry kinds', async t => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const powershell = process.platform === 'win32'
    ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : process.env.HEXBOT_TEST_POWERSHELL
  if (!powershell) return t.skip('requires PowerShell for the actual registration producer')
  const source = await readFile('backend/hexbot-installer/src/windows-nsis-registration.ps1', 'utf8')
  const functions = source.slice(source.indexOf('function Read-String'), source.indexOf('$entries=@('))
  const record = source.split('        @{scope=')[1].split('\n    } finally')[0]
  assert(functions.startsWith('function Read-String') && record)
  // Only the registry-key API is substituted. Both functions and the complete
  // serialized entry expression come from production, as in the native Rust control.
  const script = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false,$true)
${functions}
function Fixture-Key($kind) {
    $key=[pscustomobject]@{Kind=$kind;Value='%HEXBOT_LITERAL%'}
    $key | Add-Member ScriptMethod GetValueNames {if($null -ne $this.Kind){'InstallLocation';'UninstallString'}}
    $key | Add-Member ScriptMethod GetValueKind {param($name) return [Microsoft.Win32.RegistryValueKind]$this.Kind}
    $key | Add-Member ScriptMethod GetValue {
        param($name,$default,$options)
        if($options -ne [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames){throw 'Expansion was allowed'}
        return $this.Value
    }
    return $key
}
$entry={@{scope=${record}}
$hive=[Microsoft.Win32.RegistryHive]::CurrentUser
$results=@(foreach($kind in @('AbsentKey','AbsentValue','String','ExpandString','DWord','MultiString')) {
    $install=$null
    if($kind -eq 'AbsentValue'){$install=Fixture-Key $null}
    elseif($kind -ne 'AbsentKey'){$install=Fixture-Key $kind}
    $uninstall=$install
    & $entry
})
ConvertTo-Json -InputObject $results -Compress`
  const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 15000, maxBuffer: 65536
  })
  const raw = JSON.parse(stdout)
  assert.deepEqual(raw, [null, null, 'String', 'ExpandString', 'DWord', 'MultiString'].map((kind, index) => ({
    scope: 'CurrentUser', view: 'Registry64', install: index !== 0, uninstall: index !== 0,
    location: kind === 'String' ? '%HEXBOT_LITERAL%' : null,
    command: kind === 'String' ? '%HEXBOT_LITERAL%' : null,
    locationType: kind, commandType: kind
  })))
})

test('composed CIM query uses the schema executable path even without a Path alias', async t => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const powershell = process.platform === 'win32'
    ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : process.env.HEXBOT_TEST_POWERSHELL
  if (!powershell) return t.skip('requires PowerShell for the composed CIM query')
  const policy = await readFile('backend/hexbot-installer/src/windows-nsis-process-policy.ps1', 'utf8')
  const query = await readFile('backend/hexbot-installer/src/windows-nsis-process-query.ps1', 'utf8')
  // Only CIM enumeration is substituted. No Path alias exists on the first
  // record; a misleading alias on the external record must not create a match.
  const script = `${policy}
function Get-CimInstance {
    [pscustomobject]@{ProcessId=101;ExecutablePath='C:\\apps\\stable.nightly\\worker.exe';CreationDate=[DateTime]::UtcNow}
    [pscustomobject]@{ProcessId=102;ExecutablePath='C:\\external\\hexbot.exe';Path='C:\\apps\\stable\\false.exe';CreationDate=[DateTime]::UtcNow}
}
${query}`
  const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-C', script], {
    env: { ...process.env, HEXBOT_NSIS_DESTINATIONS: JSON.stringify(['C:\\apps\\stable']), HEXBOT_NSIS_IMAGE: 'Hexbot.exe', HEXBOT_NSIS_AVAILABLE: '1' },
    windowsHide: true, timeout: 15000, maxBuffer: 32768
  })
  const result = JSON.parse(stdout)
  assert.equal(result.complete, true)
  assert.equal(result.branch, 'prefix')
  assert.equal(result.enumerated, 2)
  assert.equal(result.matchCount, 1)
  assert.deepEqual(result.shown.map(({ pid, path }) => ({ pid, path })), [{ pid: 101, path: 'C:\\apps\\stable.nightly\\worker.exe' }])
})

test('native CIM prefix preflight finds an owned non-app executable and preserves external processes', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const { spawn, execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { cp, mkdir, mkdtemp, realpath, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { once } = await import('node:events')
  const root = await mkdtemp(join(tmpdir(), 'hexbot-cim-π-'))
  let child, exited
  try {
    const destination = join(root, 'stable')
    const sibling = `${destination}.nightly`
    await mkdir(sibling)
    const program = join(sibling, 'owned-worker.exe')
    await cp(process.execPath, program)
    child = spawn(program, ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.stdout.write('ready\\n')"], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    exited = once(child, 'exit')
    child.stderr.resume()
    // Capture completion before any request. Readiness is emitted by this exact
    // child; there is no PID discovery or name-based cleanup authority.
    const first = await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) })
    assert.equal(first[0].toString(), 'ready\n')
    const policy = await readFile('backend/hexbot-installer/src/windows-nsis-process-policy.ps1', 'utf8')
    const query = await readFile('backend/hexbot-installer/src/windows-nsis-process-query.ps1', 'utf8')
    for (const directory of ['System32', 'SysWOW64']) {
      const powershell = join(process.env.SystemRoot, directory, 'WindowsPowerShell/v1.0/powershell.exe')
      const invoke = script => promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-C', script], {
        env: { ...process.env, HEXBOT_NSIS_DESTINATIONS: JSON.stringify([destination]), HEXBOT_NSIS_IMAGE: 'Hexbot.exe', HEXBOT_NSIS_AVAILABLE: '1', HEXBOT_CIM_FIXTURE_PID: String(child.pid) },
        windowsHide: true, timeout: 15000, maxBuffer: 32768
      })
      // Observe the real host's alias separately. Production reads only the
      // documented schema field; this diagnostic makes no alias assumption.
      const properties = JSON.parse((await invoke(`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$p=Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId='+$env:HEXBOT_CIM_FIXTURE_PID);if(!$p){throw 'Owned child disappeared'};ConvertTo-Json -Compress -InputObject @{pid=$p.ProcessId;created=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;path=$p.Path;pathMemberType=[string]$p.PSObject.Properties['Path'].MemberType}`)).stdout)
      const result = JSON.parse((await invoke(`${policy}\n${query}`)).stdout)
      console.log('Native CIM schema/prefix control:', JSON.stringify({ directory, properties, result }))
      assert.equal(properties.pid, child.pid)
      assert.equal((await realpath(properties.executable)).toLowerCase(), (await realpath(program)).toLowerCase())
      assert.equal(result.complete, true)
      assert.equal(result.branch, 'prefix')
      assert.equal(result.matchCount, 1)
      assert.equal(result.shown[0].pid, child.pid)
      assert.equal((await realpath(result.shown[0].path)).toLowerCase(), (await realpath(program)).toLowerCase())
      assert(!result.shown.some(item => item.pid === process.pid), 'external test process must be untouched')
      assert.equal(child.exitCode, null)
      process.kill(process.pid, 0)
    }
    child.stdin.end()
    assert.deepEqual(await exited, [0, null])
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill()
      await exited
    }
    await rm(root, { recursive: true, force: true })
  }
})
