import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const executable = process.env.HEXBOT_TEST_POWERSHELL ?? (process.platform === 'win32'
  ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : undefined)

test('actual PowerShell task controller stops verified instances independently of a prior state snapshot', { skip: !executable }, async () => {
  assert(isAbsolute(executable))
  assert((await stat(executable)).isFile())
  const control = await readFile('backend/hexbot-core/assets/windows-task-control.ps1', 'utf8')
  const script = `
$ErrorActionPreference='Stop'
$expectedSid='S-1-fixture'; $expectedPowerShell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$expectedArguments='-File "C:\\owned\\daemon.ps1"'; $expectedOwner='Hexbot owned home: "C:\\state"'
$taskName='fixture'; $allowLegacy=$false; $operation='stop'
$env:HEXBOT_WINDOWS_SERVICE_PROBE='0'
function Resolve-HexbotTaskSid($value) { $value }
$action=[pscustomobject]@{Path=$expectedPowerShell;Arguments=$expectedArguments}
$actions=[pscustomobject]@{Count=1;Entry=$action}
$actions|Add-Member ScriptMethod Item {param($index) $this.Entry}
$definition=[pscustomobject]@{Actions=$actions;Principal=[pscustomobject]@{UserId=$expectedSid};RegistrationInfo=[pscustomobject]@{Description=$expectedOwner}}
$script:fixtureTask=[pscustomobject]@{Definition=$definition;State=3}
$script:fixtureTask|Add-Member ScriptMethod Stop {param($flags) $script:stops++;if($flags -ne 0){throw 'Nonzero stop flags'};if($script:stopFailure){throw [Runtime.InteropServices.COMException]::new('fixture stop failure', $script:stopFailure)}}
$script:fixtureFolder=[pscustomobject]@{}
$script:fixtureFolder|Add-Member ScriptMethod GetTask {param($name) if($script:missing){throw [Runtime.InteropServices.COMException]::new('missing fixture', -2147024894)};$script:fixtureTask}
$script:fixtureService=[pscustomobject]@{}
$script:fixtureService|Add-Member ScriptMethod Connect {}
$script:fixtureService|Add-Member ScriptMethod GetFolder {param($path) $script:fixtureFolder}
function New-Object([string]$ComObject) { if($ComObject -cne 'Schedule.Service'){throw 'Unexpected COM object'};$script:fixtureService }
$control=[ScriptBlock]::Create(@'
${control}
'@)
$cases=0
foreach($state in @(0,1,2,3,4)) {
  $script:fixtureTask.State=$state;$script:stops=0;& $control
  if($script:stops -ne 1){throw "Stop skipped for state snapshot $state"};$cases++
}
foreach($failure in @(-2147216629,-2147024891)) {
  $script:stopFailure=$failure;$script:stops=0;$refused=$false
  try { & $control } catch { $refused=$true }
  if($script:stops -ne 1 -or $refused -ne ($failure -eq -2147024891)){throw 'Wrong stop HRESULT policy'};$cases++
}
$script:stopFailure=0
$script:fixtureTask|Add-Member ScriptMethod GetInstances {param($flags) if($flags -ne 0){throw 'Invalid instance flags'};$script:collection}
$operation='instances'
foreach($kind in @('empty','running','zero','overflow')) {
  $script:fixtureTask.State=$(if($kind -eq 'empty'){3}else{4})
  $script:collection=[pscustomobject]@{Count=$(switch($kind){'empty'{0};'overflow'{17};default{2}})}
  $script:collection|Add-Member ScriptMethod Item {param($index) [pscustomobject]@{State=4;EnginePID=$(if($script:zero){0}else{100+$index})}}
  $script:zero=$kind -eq 'zero';$script:stops=0;$refused=$false;$result=$null
  try {$result=(& $control)|ConvertFrom-Json} catch {$refused=$true}
  if($script:stops -ne 0 -or $refused -ne ($kind -in @('zero','overflow'))){throw 'Wrong readonly instance policy'}
  if($kind -eq 'empty' -and @($result.engines).Count -ne 0){throw 'Empty task gained engine identities'}
  if($kind -eq 'running' -and (@($result.engines).Count -ne 2 -or $result.engines[0] -ne 101 -or $result.engines[1] -ne 102)){throw 'Wrong running engine identities'}
  $cases++
}
$operation='stop'
foreach($foreign in @('principal','program','arguments','home','count')) {
  $definition.Principal.UserId=$expectedSid;$action.Path=$expectedPowerShell;$action.Arguments=$expectedArguments;$definition.RegistrationInfo.Description=$expectedOwner;$actions.Count=1
  switch($foreign){'principal'{$definition.Principal.UserId='S-1-foreign'} 'program'{$action.Path='C:\\foreign.exe'} 'arguments'{$action.Arguments='foreign'} 'home'{$definition.RegistrationInfo.Description='foreign'} 'count'{$actions.Count=2}}
  $script:stops=0;$refused=$false;try{& $control}catch{$refused=$true}
  if(-not $refused -or $script:stops -ne 0){throw 'Foreign task was stopped'};$cases++
}
$script:missing=$true;$script:stops=0;& $control
if($script:stops -ne 0){throw 'Missing task stop mutated state'};$cases++
@{cases=$cases;passed=$cases}|ConvertTo-Json -Compress
`
  const output = await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30_000, windowsHide: true })
  assert.deepEqual(JSON.parse(output.stdout), { cases: 17, passed: 17 })
})

test('actual PowerShell timeout diagnostics are bounded and observe processes without controlling them', { skip: !executable }, async t => {
  const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const home = await mkdtemp(join(tmpdir(), 'hexbot-task-diagnostic-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'runtime'))
  await writeFile(join(home, 'native-daemon.lock'), '123')
  await writeFile(join(home, 'runtime/native-running.json'), JSON.stringify({ pid: 123, executable: 'C:\\managed\\hexbot.exe', ignoredSecret: 'must not appear' }))
  const source = await readFile('backend/hexbot-core/assets/windows-task-diagnostic.ps1', 'utf8')
  const script = `
$ErrorActionPreference='Stop'
$diagnosticHome='${home.replaceAll("'", "''")}'
$taskName='fixture';$env:HEXBOT_WINDOWS_SERVICE_PROBE='1';$env:HEXBOT_WINDOWS_EXPECTED_TASK_PID='123'
$task=[pscustomobject]@{State=3;LastTaskResult=0;Xml=('x'*20000)}
$collection=[pscustomobject]@{Count=1}
$collection|Add-Member ScriptMethod Item {param($index) [pscustomobject]@{InstanceGuid='fixture';EnginePID=123;State=4;CurrentAction='action';Path='\\fixture'}}
$script:collection=$collection
$task|Add-Member ScriptMethod GetInstances {param($flags) $script:collection}
function Get-CimInstance {param($ClassName,$Filter,$OperationTimeoutSec) [pscustomobject]@{ProcessId=123;ParentProcessId=456;Name='hexbot.exe';ExecutablePath='C:\\managed\\hexbot.exe';CreationDate='fixture';CommandLine='must not appear'}}
function Invoke-CimMethod {param($InputObject,$MethodName,$OperationTimeoutSec) @{Sid='S-1-fixture'}}
${source}
Get-HexbotTaskDiagnostic
`
  const { stdout } = await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30_000, windowsHide: true })
  const data = JSON.parse(stdout)
  assert.equal(data.state, 3)
  assert.equal(data.lock.pid, 123)
  if (process.platform !== 'darwin') assert.equal(data.lock.state, 'free')
  else {
    // .NET FileStream.Lock is unsupported on macOS. Preserve that explicit
    // error; only native Windows can establish this diagnostic's lock result.
    assert.equal(data.lock.state, 'open-error')
    assert.equal(data.lock.error, -2146233031)
  }
  assert.equal(data.instanceCount, 1)
  assert.equal(data.instances.length, 1)
  assert.equal(data.instances[0].enginePid, 123)
  assert.equal(data.definitionXml.length, 16384)
  assert.deepEqual(data.running, { pid: 123, executable: 'C:\\managed\\hexbot.exe' })
  assert.equal(data.processes.length, 1)
  assert.equal(data.processes[0].sid, 'S-1-fixture')
  assert(!stdout.includes('must not appear'))
})
