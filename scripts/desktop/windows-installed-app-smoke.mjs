// Run the actual NSIS-installed app before the engine repairs/uninstalls it.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { waitForRuntimeJson } from './runtime-file.mjs'
import { captureInstalledApp, formatStartupDiagnostic, installedStartupFiles, startupRedactor } from './installed-app-startup.mjs'
import { quitInstalledApp, startInstalledOwned, verifyInstalledDaemon } from './installed-app-lifecycle.mjs'
import { nodePath } from '../../apps/desktop/src/main/backend/node-path.ts'
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const { _electron: electron } = require('@playwright/test')
const [executable, edition, root, repairInvocation] = process.argv.slice(2)
assert.equal(process.platform, 'win32')
assert(isAbsolute(executable) && isAbsolute(root))
assert(['client', 'full'].includes(edition))
const home = join(root, 'state')
for (const directory of [home, join(root, 'roaming'), join(root, 'local')]) await mkdir(directory, { recursive: true })
const state = () => waitForRuntimeJson(join(home, 'serve-state.json'), value => value.port, 300_000)

async function assertStopped(pid) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'Packaged Full left its owned daemon alive')
  await assertHomeStopped()
}
async function assertHomeStopped() {
  await assert.rejects(readFile(join(home, 'serve-state.json')), { code: 'ENOENT' })
  try { await lstat(join(home, 'native-daemon.lock')) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  await assertHomeLock('free')
}
async function assertHomeLock(expected) {
  const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const output = await promisify(execFile)(ps, ['-NoProfile', '-NonInteractive', '-Command', "$f=[IO.File]::Open((Join-Path $env:HEXBOT_HOME 'native-daemon.lock'),'Open','ReadWrite','ReadWrite,Delete'); try {try {$f.Lock(0,1);$f.Unlock(0,1);'free'} catch [IO.IOException] {'held'}} finally {$f.Dispose()}"], {env: {...process.env, HEXBOT_HOME: home}, windowsHide: true, timeout: 30_000})
  assert.equal(output.stdout.trim(), expected)
}
let app, ownedPid, servicePid, stoppedTaskPid, selected, serviceAttempted = false, taskInstalled = false
const managerStatus = () => window.evaluate(() => window.hexbot.daemon.status())
const selection = async () => {
  selected = JSON.parse(await readFile(join(home, 'runtime/native-current.json'), 'utf8')).executable
  return selected
}
const startOwned = (previousPid, timeout = 30_000) => startInstalledOwned({
  home, selected: selection, previousPid, timeout, status: managerStatus,
  start: () => window.evaluate(() => window.hexbot.daemon.start())
})
const verify = async (expectedState, previousPid, expectedPid) => verifyInstalledDaemon({
  home, selected: selection, previousPid, expectedPid,
  status: await managerStatus(), expectedState
})
async function verifyTask(previousPid, expectedPid) {
  const ready = await verifyInstalledDaemon({ home, selected: selection, previousPid, expectedPid })
  const status = JSON.parse((await native(selected, ['service', 'status', '--json'], nativeOptions)).stdout)
  assert.equal(status.installed, true)
  assert.equal(status.running, true)
  await assertHomeLock('held')
  return ready
}
async function closeApp() {
  if (!app) return
  const closing = app
  const child = closing.process()
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve([child.exitCode, child.signalCode]) : once(child, 'exit')
  void exited.catch(() => undefined)
  try {
    await closing.close()
    assert.deepEqual(await exited, [0, null])
  } finally {
    app = undefined
  }
}
const redact = startupRedactor()
const captures = []
let initialIdentity, window, primaryFailure
// Diagnostics are bounded independently and never replace the test failure.
async function diagnostic(action) {
  let timer
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Startup diagnostic did not complete within 2000 ms')), 2000)
    })])
  } catch (error) { return { error: String(error) } }
  finally { clearTimeout(timer) }
}
async function startupStatus() {
  if (!window) return { window: 'unavailable' }
  return diagnostic(() => window.evaluate(async () => {
    const status = await window.hexbot.daemon.status()
    return {
      edition: window.hexbot.edition, version: window.hexbot.version, isPackaged: window.hexbot.isPackaged,
      route: location.pathname,
      onboarding: ['onboarding-get-started', 'onboarding-next', 'onboarding-choice-local']
        .filter(id => document.querySelector(`[data-testid="${id}"]`)),
      status: { state: status.state, pid: status.pid, port: status.port, lastError: status.lastError == null ? status.lastError : String(status.lastError).slice(0, 1024) },
      progress: globalThis.installedStartupProgress?.events
    }
  }))
}
const native = promisify(execFile)
const nativeOptions = { env: { ...process.env, HEXBOT_HOME: home, USERPROFILE: root, HOME: root, HEXBOT_SERVICE_ROOT: root }, windowsHide: true, timeout: 30_000 }
// Test-only observer retains the actual Process.Handle before Quit. It only
// waits/queries that handle; it never terminates a daemon by a recorded PID.
async function retainDaemon(pid, executable) {
  const ps = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$p=[Diagnostics.Process]::GetProcessById([int]$env:HEXBOT_TEST_WAIT_PID)
try {
  $null=$p.Handle
  $identity=@{pid=$p.Id;created=$p.StartTime.ToUniversalTime().Ticks.ToString();executable=$p.MainModule.FileName;alive=(-not $p.WaitForExit(0))}
  [Console]::WriteLine((ConvertTo-Json -Compress -InputObject $identity));[Console]::Out.Flush()
  $null=[Console]::ReadLine()
  $done=$p.WaitForExit(0)
  $record=@{pid=$identity.pid;created=$identity.created;signalled=$done}
  if($done){$record.exitCode=$p.ExitCode}
  [Console]::WriteLine((ConvertTo-Json -Compress -InputObject $record))
} finally {$p.Dispose()}`
  const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
    ...nativeOptions, env: { ...nativeOptions.env, HEXBOT_TEST_WAIT_PID: String(pid) }, stdio: ['pipe', 'pipe', 'pipe']
  })
  const completed = once(child, 'close')
  void completed.catch(() => undefined)
  let stderr = ''
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096) })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let identity
  try {
    const first = await lines.next()
    assert(!first.done, stderr)
    identity = JSON.parse(first.value)
    console.log('Quit handoff retained daemon:', JSON.stringify(identity))
    assert.equal(identity.pid, pid)
    assert.equal(identity.alive, true)
    assert.equal(await realpath(identity.executable), await realpath(executable))
  } catch (error) {
    child.stdin.end()
    await completed.catch(() => undefined)
    throw error
  }
  return async () => {
    child.stdin.end('inspect\n')
    const last = await lines.next()
    const status = await completed
    assert(!last.done, stderr)
    const record = JSON.parse(last.value)
    console.log('Quit handoff kernel completion:', JSON.stringify({ record, status, stderr }))
    assert.deepEqual(status, [0, null])
    assert.equal(record.created, identity.created)
    assert.equal(record.signalled, true, 'Quit returned before its actual retained daemon handle signalled')
    assert.equal(record.exitCode, 0)
  }
}

async function openApp() {
  app = await electron.launch({ executablePath: executable, timeout: 300_000, env: {
    ...process.env, HOME: root, USERPROFILE: root, HEXBOT_HOME: home, HERMES_HOME: home,
    APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local'), HEXBOT_SERVICE_ROOT: root, HEXBOT_CLI_NO_PATH: '1',
  } })
  captures.push(captureInstalledApp(app.process(), redact))
  const identity = await app.evaluate(({ app }) => ({
    isPackaged: app.isPackaged, version: app.getVersion(), appPath: app.getAppPath(),
    userData: app.getPath('userData'), resourcesPath: process.resourcesPath, executable: process.execPath,
    home: process.env.HEXBOT_HOME, node: process.versions.node
  }))
  initialIdentity ??= identity
  console.log('Installed app identity:', formatStartupDiagnostic(identity, redact))
  assert.equal(identity.isPackaged, true)
  window = await app.firstWindow({ timeout: 300_000 })
  await window.waitForLoadState('domcontentloaded')
  assert(await window.locator('body').isVisible())
  return window
}
try {
  window = await openApp()
  const repair = JSON.parse(repairInvocation)
  assert(isAbsolute(repair.program))
  const beforeReceipt = await readFile(join(repair.env.HEXBOT_HOME, 'install.json'))
  await assert.rejects(native(nodePath(repair.program), ['--repair', '--yes', '--json'], {
    env: { ...process.env, ...repair.env }, windowsHide: true, timeout: 120_000,
  }), error => {
    assert.equal(error.code, 1)
    assert.match(error.stdout, /Quit the Windows app/)
    assert(!error.stdout.includes('Running the Windows app installer'))
    return true
  })
  assert(beforeReceipt.equals(await readFile(join(repair.env.HEXBOT_HOME, 'install.json'))))
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  console.log('Actual running installed app refused Repair before NSIS; original app and receipt retained')
  if (edition === 'full') {
    const [baseline, files] = await Promise.all([startupStatus(), diagnostic(() =>
      installedStartupFiles(home, join(dirname(executable), 'resources/hexbot-native')))])
    console.log('Installed Full before initial start:', formatStartupDiagnostic({ baseline, files }, redact))
    await window.evaluate(() => {
      const events = []
      const off = window.hexbot.daemon.onProgress(event => {
        events.push({ stage: String(event.stage).slice(0, 64), message: String(event.message).slice(0, 1024), percent: event.percent })
        if (events.length > 32) events.shift()
      })
      globalThis.installedStartupProgress = { events, off }
    })
    // A fresh profile waits on onboarding. Request the normal product path
    // once; bootstrap and the first real readiness record share the old budget.
    const running = await startOwned(undefined, 300_000)
    console.log('Installed Full initial startup:', formatStartupDiagnostic(await startupStatus(), redact))
    await diagnostic(() => window.evaluate(() => globalThis.installedStartupProgress?.off()))
    ownedPid = running.pid
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
    ownedPid = undefined
    const restarted = await startOwned(oldPid, 300_000)
    ownedPid = restarted.pid
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
      ownedPid = undefined
      await assert.rejects(window.evaluate(() => window.hexbot.service.install()), /another installation|ownership/i)
      const restored = await verify('running', failedPid)
      ownedPid = restored.pid
      assert.throws(() => process.kill(failedPid, 0), { code: 'ESRCH' })
      assert.equal((await window.evaluate(() => window.hexbot.daemon.status())).state, 'running')
      const restoredState = await state()
      assert.equal((await fetch(`http://127.0.0.1:${restoredState.port}/api/daemon/identity`)).status, 200)
      await assertHomeLock('held')
      const beforeFailedRemoval = ownedPid
      ownedPid = undefined
      await assert.rejects(window.evaluate(() => window.hexbot.service.uninstall()), /another installation|ownership/i)
      ownedPid = (await verify('running', beforeFailedRemoval)).pid
      assert.throws(() => process.kill(beforeFailedRemoval, 0), { code: 'ESRCH' })
      assert.equal((await window.evaluate(() => window.hexbot.daemon.status())).state, 'running')
      await assertHomeLock('held')
    } finally {
      await native(ps, ['-NoProfile', '-NonInteractive', '-Command', taskContext + "$t=$f.GetTask($name);$d=$t.Definition;if($d.RegistrationInfo.Description -cne 'Hexbot foreign IPC fixture' -or $d.Actions.Count -ne 1 -or $d.Actions.Item(1).Path -ine $cmd -or $d.Actions.Item(1).Arguments -cne '/D /C exit 0'){throw 'Foreign fixture was changed; refusing cleanup'};$f.DeleteTask($name,0)"], nativeOptions)
    }
    const beforeHandoff = ownedPid
    serviceAttempted = true
    ownedPid = undefined
    await window.evaluate(() => window.hexbot.service.install())
    taskInstalled = true
    servicePid = (await verify('external', beforeHandoff)).pid
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
    stoppedTaskPid = servicePid
    servicePid = undefined
    ownedPid = (await startOwned(stoppedTaskPid)).pid
    const beforeRemoval = ownedPid
    assert.equal((await window.evaluate(() => window.hexbot.daemon.status())).state, 'running')
    await window.evaluate(() => window.hexbot.service.uninstall())
    taskInstalled = false
    ownedPid = undefined
    ownedPid = (await verify('running', beforeRemoval)).pid
    assert.throws(() => process.kill(beforeRemoval, 0), { code: 'ESRCH' })
    assert.deepEqual(await window.evaluate(() => window.hexbot.service.status()), { installed: false, running: false })
    await assertHomeLock('held')
    const beforeReinstall = ownedPid
    ownedPid = undefined
    await window.evaluate(() => window.hexbot.service.install())
    taskInstalled = true
    servicePid = (await verify('external', beforeReinstall)).pid
    assert.throws(() => process.kill(beforeReinstall, 0), { code: 'ESRCH' })
    ownedPid = undefined

    // A task remains enabled while stopped or after its script is lost. Full
    // temporarily owns the daemon, then Quit must repair/start the same task.
    for (const missingScript of [false, true]) {
      await native(selected, ['service', 'stop'], nativeOptions)
      await assertStopped(servicePid)
      stoppedTaskPid = servicePid
      servicePid = undefined
      const serviceScript = join(root, 'AppData/Local/Hexbot/daemon.ps1')
      const script = await readFile(serviceScript)
      if (missingScript) await (await import('node:fs/promises')).unlink(serviceScript)
      ownedPid = (await startOwned(stoppedTaskPid)).pid
      assert.equal((await window.evaluate(() => window.hexbot.daemon.status())).state, 'running')
      const completed = await retainDaemon(ownedPid, selected)
      const appExit = once(app.process(), 'exit')
      void appExit.catch(() => undefined)
      let quitError
      try {
        await app.close(); app = undefined
        assert.deepEqual(await appExit, [0, null])
      } catch (error) { quitError = error }
      try { await completed() }
      catch (error) { if (quitError) throw new AggregateError([quitError, error], 'Quit and retained-handle check failed'); throw error }
      if (quitError) throw quitError
      const beforeQuit = ownedPid
      ownedPid = undefined
      const newTask = await verifyTask(beforeQuit)
      servicePid = newTask.pid
      assert.equal(await realpath(newTask.executable), await realpath(selected))
      assert.equal(JSON.parse((await native(selected, ['service', 'status', '--json'], nativeOptions)).stdout).running, true)
      assert.equal((await fetch(`http://127.0.0.1:${(await state()).port}/api/daemon/identity`).then(response => response.json())).pid, servicePid)
      await assertHomeLock('held')
      assert.deepEqual(await readFile(serviceScript), script)
      window = await openApp()
      await window.evaluate(() => window.hexbot.daemon.start())
      await verify('external', undefined, servicePid)
      console.log('Packaged Full Quit handed owned daemon to installed task:', JSON.stringify({ beforeQuit, servicePid, missingScript }))
    }

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
    await verifyInstalledDaemon({ home, selected: olderExe, expectedPid: oldTask.pid, previousPid: servicePid })
    servicePid = oldTask.pid
    assert.equal(await realpath(oldTask.executable), await realpath(olderExe))
    const serviceScript = join(root, 'AppData/Local/Hexbot/daemon.ps1')
    const expectedScript = await readFile(serviceScript)
    const { unlink } = await import('node:fs/promises')
    await unlink(serviceScript)
    window = await openApp()
    await window.evaluate(() => window.hexbot.daemon.start())
    const upgradedTask = await verify('external', oldTask.pid)
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
    await verify('external', undefined, servicePid)
    console.log('Installed Full service toggles, failure recovery and bundled activation/task relaunch passed')

  } else {
    await assert.rejects(window.evaluate(() => window.hexbot.service.install()), /client-only/i)
    await assert.rejects(window.evaluate(() => window.hexbot.service.uninstall()), /client-only/i)
    await assert.rejects(readFile(join(home, 'runtime/native-current.json')), { code: 'ENOENT' })
  }
  console.log(`Installed ${edition} app opened its real packaged window${edition === 'full' ? ' and activated its verified native daemon' : ''}`)
} catch (error) {
  primaryFailure = error
  const [status, files] = await Promise.all([startupStatus(), diagnostic(() =>
    installedStartupFiles(home, join(dirname(executable), 'resources/hexbot-native')))])
  console.error('Installed app failure evidence:', formatStartupDiagnostic({
    identity: initialIdentity, status, output: captures.map(capture => capture.snapshot()), files
  }, redact))
  throw error
} finally {
  await diagnostic(() => window?.evaluate(() => globalThis.installedStartupProgress?.off()))
  for (const capture of captures) capture.dispose()
  try {
    // Keep task installation knowledge while a stopped task's PID is cleared.
    // A partial service operation must pass the strict CLI ownership gate too.
    let taskStatusError
    if (serviceAttempted) {
      try {
        const status = JSON.parse((await native(selected, ['service', 'status', '--json'], nativeOptions)).stdout)
        assert.equal(typeof status.installed, 'boolean')
        assert.equal(typeof status.running, 'boolean')
        assert(!status.running || status.installed)
        if (taskInstalled) assert.equal(status.installed, true, 'Installed task disappeared before Quit')
        taskInstalled = status.installed
      } catch (error) { taskStatusError = error }
    }
    await quitInstalledApp({
      ownedPid: app ? ownedPid : undefined, taskInstalled,
      retain: pid => retainDaemon(pid, selected), quit: closeApp,
      verifyTask: async () => {
        if (taskStatusError) throw taskStatusError
        const task = await verifyTask(ownedPid ?? (servicePid ? undefined : stoppedTaskPid), servicePid)
        servicePid = task.pid
        return task
      },
      uninstallTask: async () => {
        await native(selected, ['service', 'uninstall'], nativeOptions)
        taskInstalled = false
      },
      assertStopped,
      assertHomeStopped: () => edition === 'full' ? assertHomeStopped() : undefined
    })
    if (taskStatusError) throw taskStatusError
  } catch (error) {
    if (!primaryFailure) throw error
    console.error('Installed app cleanup also failed:', formatStartupDiagnostic({ error: String(error) }, redact))
    throw primaryFailure
  }
}
