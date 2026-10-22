// Run the actual NSIS-installed app before the engine repairs/uninstalls it.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { waitForRuntimeJson } from './runtime-file.mjs'
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const { _electron: electron } = require('@playwright/test')
const [executable, edition, root] = process.argv.slice(2)
assert.equal(process.platform, 'win32')
assert(isAbsolute(executable) && isAbsolute(root))
assert(['client', 'full'].includes(edition))
const home = join(root, 'state')
for (const directory of [home, join(root, 'roaming'), join(root, 'local')]) await mkdir(directory, { recursive: true })
const state = () => waitForRuntimeJson(join(home, 'serve-state.json'), value => value.port, 300_000)

async function assertStopped(pid) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'Packaged Full left its owned daemon alive')
  await assert.rejects(readFile(join(home, 'serve-state.json')), { code: 'ENOENT' })
  await assertHomeLock('free')
}
async function assertHomeLock(expected) {
  const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const output = await promisify(execFile)(ps, ['-NoProfile', '-NonInteractive', '-Command', "$f=[IO.File]::Open((Join-Path $env:HEXBOT_HOME 'native-daemon.lock'),'Open','ReadWrite','ReadWrite,Delete'); try {try {$f.Lock(0,1);$f.Unlock(0,1);'free'} catch [IO.IOException] {'held'}} finally {$f.Dispose()}"], {env: {...process.env, HEXBOT_HOME: home}, windowsHide: true, timeout: 30_000})
  assert.equal(output.stdout.trim(), expected)
}
let app, ownedPid, servicePid, selected, serviceAttempted = false
const native = promisify(execFile)
const nativeOptions = { env: { ...process.env, HEXBOT_HOME: home, USERPROFILE: root, HOME: root, HEXBOT_SERVICE_ROOT: root }, windowsHide: true, timeout: 30_000 }
async function openApp() {
  app = await electron.launch({ executablePath: executable, timeout: 300_000, env: {
    ...process.env, HOME: root, USERPROFILE: root, HEXBOT_HOME: home, HERMES_HOME: home,
    APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local'), HEXBOT_SERVICE_ROOT: root, HEXBOT_CLI_NO_PATH: '1',
  } })
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  const window = await app.firstWindow({ timeout: 300_000 })
  await window.waitForLoadState('domcontentloaded')
  assert(await window.locator('body').isVisible())
  return window
}
try {
  let window = await openApp()
  if (edition === 'full') {
    const running = await state()
    ownedPid = JSON.parse(await readFile(join(home, 'runtime/native-running.json'), 'utf8')).pid
    assert(Number.isSafeInteger(ownedPid))
    selected = JSON.parse(await readFile(join(home, 'runtime/native-current.json'), 'utf8')).executable
    const path = relative(await realpath(join(home, 'runtime/native')), await realpath(selected))
    assert(path && !path.startsWith(`..${sep}`) && !isAbsolute(path))
    assert(selected.endsWith('hexbot.exe'))
    const response = await fetch(`http://127.0.0.1:${running.port}/`, { signal: AbortSignal.timeout(10_000) })
    assert.equal(response.status, 200)
    const oldPid = ownedPid
    const stopped = await window.evaluate(() => window.hexbot.daemon.stop())
    assert.equal(stopped.state, 'stopped')
    await assertStopped(oldPid)
    await window.evaluate(() => window.hexbot.daemon.start())
    const restarted = await state()
    ownedPid = JSON.parse(await readFile(join(home, 'runtime/native-running.json'), 'utf8')).pid
    assert.notEqual(ownedPid, oldPid, 'Packaged Full did not start a new owned daemon')
    assert.equal((await fetch(`http://127.0.0.1:${restarted.port}/`, {signal: AbortSignal.timeout(10_000)})).status, 200)
    console.log('Packaged Full stop/start waited for cleanup and started a new owned process')
    const ps = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const taskContext = "$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$f=$s.GetFolder('\\');$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$name='Hexbot-daemon-'+$sid;$cmd=Join-Path ([Environment]::GetFolderPath('System')) 'cmd.exe';"
    // Explicitly register only this disposable user's inert foreign-action
    // fixture. Repair must refuse it and restore the app's original ownership.
    await native(ps, ['-NoProfile', '-NonInteractive', '-Command', taskContext + "try{$null=$f.GetTask($name);throw 'Expected no existing task'}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};if($e.HResult -ne -2147024894){throw}};$t=$s.NewTask(0);$t.Principal.UserId=$sid;$t.Principal.LogonType=3;$t.RegistrationInfo.Description='Hexbot foreign IPC fixture';$a=$t.Actions.Create(0);$a.Path=$cmd;$a.Arguments='/D /C exit 0';$null=$f.RegisterTaskDefinition($name,$t,2,$null,$null,3)"], nativeOptions)
    try {
      const failedPid = ownedPid
      await assert.rejects(window.evaluate(() => window.hexbot.service.install()), /another installation|ownership/i)
      const restored = await waitForRuntimeJson(join(home, 'runtime/native-running.json'), value => value.pid && value.pid !== failedPid)
      ownedPid = restored.pid
      assert.throws(() => process.kill(failedPid, 0), { code: 'ESRCH' })
      assert.equal((await window.evaluate(() => window.hexbot.daemon.status())).state, 'running')
      const restoredState = await state()
      assert.equal((await fetch(`http://127.0.0.1:${restoredState.port}/api/daemon/identity`)).status, 200)
      await assertHomeLock('held')
      const beforeFailedRemoval = ownedPid
      await assert.rejects(window.evaluate(() => window.hexbot.service.uninstall()), /another installation|ownership/i)
      ownedPid = (await waitForRuntimeJson(join(home, 'runtime/native-running.json'), value => value.pid && value.pid !== beforeFailedRemoval)).pid
      assert.throws(() => process.kill(beforeFailedRemoval, 0), { code: 'ESRCH' })
      assert.equal((await window.evaluate(() => window.hexbot.daemon.status())).state, 'running')
      await assertHomeLock('held')
    } finally {
      await native(ps, ['-NoProfile', '-NonInteractive', '-Command', taskContext + "$t=$f.GetTask($name);$d=$t.Definition;if($d.RegistrationInfo.Description -cne 'Hexbot foreign IPC fixture' -or $d.Actions.Count -ne 1 -or $d.Actions.Item(1).Path -ine $cmd -or $d.Actions.Item(1).Arguments -cne '/D /C exit 0'){throw 'Foreign fixture was changed; refusing cleanup'};$f.DeleteTask($name,0)"], nativeOptions)
    }
    const beforeHandoff = ownedPid
    serviceAttempted = true
    await window.evaluate(() => window.hexbot.service.install())
    servicePid = JSON.parse(await readFile(join(home, 'runtime/native-running.json'), 'utf8')).pid
    assert.notEqual(servicePid, beforeHandoff, 'Task must replace the app-owned daemon')
    assert.throws(() => process.kill(beforeHandoff, 0), { code: 'ESRCH' })
    assert.equal((await window.evaluate(() => window.hexbot.daemon.status())).state, 'external')
    assert.deepEqual(await window.evaluate(() => window.hexbot.service.status()), { installed: true, running: true })
    await assert.rejects(readFile(join(home, 'native-daemon.lock')), { code: 'EBUSY' })
    assert.equal((await fetch(`http://127.0.0.1:${(await state()).port}/api/daemon/identity`).then(response => response.json())).pid, servicePid)
    await assertHomeLock('held')
    // Stop and Quit must leave the task owner alive after the successful IPC.
    assert.equal((await window.evaluate(() => window.hexbot.daemon.stop())).state, 'external')
    process.kill(servicePid, 0)
    ownedPid = undefined
    console.log(`Packaged Full service IPC handed off daemon ${beforeHandoff} to task PID ${servicePid}`)
    // A stopped task can coexist with an app-owned daemon. Toggle off must
    // hand off that owned process before task removal, then restart it once.
    await native(selected, ['service', 'stop'], nativeOptions)
    await assertStopped(servicePid)
    servicePid = undefined
    await window.evaluate(() => window.hexbot.daemon.start())
    ownedPid = (await waitForRuntimeJson(join(home, 'runtime/native-running.json'), value => value.pid)).pid
    const beforeRemoval = ownedPid
    assert.equal((await window.evaluate(() => window.hexbot.daemon.status())).state, 'running')
    await window.evaluate(() => window.hexbot.service.uninstall())
    ownedPid = (await waitForRuntimeJson(join(home, 'runtime/native-running.json'), value => value.pid && value.pid !== beforeRemoval)).pid
    assert.throws(() => process.kill(beforeRemoval, 0), { code: 'ESRCH' })
    assert.deepEqual(await window.evaluate(() => window.hexbot.service.status()), { installed: false, running: false })
    await assertHomeLock('held')
    await window.evaluate(() => window.hexbot.service.install())
    servicePid = (await waitForRuntimeJson(join(home, 'runtime/native-running.json'), value => value.pid && value.pid !== ownedPid)).pid
    assert.throws(() => process.kill(ownedPid, 0), { code: 'ESRCH' })
    ownedPid = undefined

    // Real installed Full relaunch: the task starts a distinct immutable older
    // build of the same binary version. Bundled chronology advances selection;
    // startup must replace the task process before returning daemon:start.
    await app.close(); app = undefined
    await native(selected, ['service', 'stop'], nativeOptions)
    await assertStopped(servicePid)
    const current = JSON.parse(await readFile(join(home, 'runtime/native-current.json'), 'utf8'))
    const older = join(home, 'runtime/native/older-task-relaunch')
    await cp(dirname(selected), older, { recursive: true })
    const manifest = JSON.parse(await readFile(join(older, 'manifest.json'), 'utf8'))
    assert(manifest.builtAt > 1)
    manifest.builtAt--
    await writeFile(join(older, 'manifest.json'), JSON.stringify(manifest))
    const olderExe = join(older, 'hexbot.exe')
    await writeFile(join(home, 'runtime/native-current.json'), JSON.stringify({ ...current, executable: olderExe, builtAt: manifest.builtAt }))
    await native(olderExe, ['service', 'start'], nativeOptions)
    const oldTask = await waitForRuntimeJson(join(home, 'runtime/native-running.json'), value => value.pid && value.pid !== servicePid)
    servicePid = oldTask.pid
    assert.equal(await realpath(oldTask.executable), await realpath(olderExe))
    const serviceScript = join(root, 'AppData/Local/Hexbot/daemon.ps1')
    const expectedScript = await readFile(serviceScript)
    const { unlink } = await import('node:fs/promises')
    await unlink(serviceScript)
    window = await openApp()
    await window.evaluate(() => window.hexbot.daemon.start())
    const upgradedTask = await waitForRuntimeJson(join(home, 'runtime/native-running.json'), value => value.pid && value.pid !== oldTask.pid)
    servicePid = upgradedTask.pid
    selected = JSON.parse(await readFile(join(home, 'runtime/native-current.json'), 'utf8')).executable
    assert.notEqual(await realpath(selected), await realpath(olderExe))
    assert.equal(await realpath(upgradedTask.executable), await realpath(selected))
    assert.equal((await native(selected, ['version'], nativeOptions)).stdout.trim(), manifest.version)
    assert.throws(() => process.kill(oldTask.pid, 0), { code: 'ESRCH' })
    assert.equal((await window.evaluate(() => window.hexbot.daemon.status())).state, 'external')
    assert.deepEqual(await readFile(serviceScript), expectedScript, 'Full did not restore the exact owned service script')
    assert.deepEqual(await window.evaluate(() => window.hexbot.service.status()), { installed: true, running: true })
    await assertHomeLock('held')
    // A second ordinary launch must attach to the same verified task instance.
    await app.close(); app = undefined
    window = await openApp()
    await window.evaluate(() => window.hexbot.daemon.start())
    assert.equal(JSON.parse(await readFile(join(home, 'runtime/native-running.json'), 'utf8')).pid, servicePid)
    console.log('Installed Full service toggles, failure recovery and bundled activation/task relaunch passed')

  } else {
    await assert.rejects(window.evaluate(() => window.hexbot.service.install()), /client-only/i)
    await assert.rejects(window.evaluate(() => window.hexbot.service.uninstall()), /client-only/i)
    await assert.rejects(readFile(join(home, 'runtime/native-current.json')), { code: 'ENOENT' })
  }
  console.log(`Installed ${edition} app opened its real packaged window${edition === 'full' ? ' and activated its verified native daemon' : ''}`)
} finally {
  try {
    if (app) await app.close()
    if (ownedPid) {
      await assertStopped(ownedPid)
      console.log('Packaged Full quit completed graceful cleanup and released its home lock')
    }
    if (servicePid) {
      process.kill(servicePid, 0)
      const status = JSON.parse((await native(selected, ['service', 'status', '--json'], nativeOptions)).stdout)
      assert.equal(status.running, true, 'Quitting Full must retain the task daemon')
      await assertHomeLock('held')
      const state = await waitForRuntimeJson(join(home, 'serve-state.json'), value => value.port)
      assert.equal((await fetch(`http://127.0.0.1:${state.port}/api/daemon/identity`)).status, 200)
    }
  } finally {
    if (serviceAttempted) await native(selected, ['service', 'uninstall'], nativeOptions)
  }
  if (servicePid) await assertStopped(servicePid)
}
