import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const nsisPath = path => path.replaceAll('\\', '/').replaceAll('$', '$$')

async function compilerFixture(name) {
  const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
  const builderRequire = createRequire(require.resolve('electron-builder'))
  const { getTemplatePath } = builderRequire('app-builder-lib/out/util/pathManager')
  const { getMakeNsisPath, getNsisPluginsPath } = builderRequire('app-builder-lib/out/toolsets/windows')
  const [compiler, plugins] = await Promise.all([getMakeNsisPath(), getNsisPluginsPath()])
  const root = await mkdtemp(join(tmpdir(), `Hexbot NSIS ${name} `))
  await copyFile(getTemplatePath('nsis/include/StdUtils.nsh'), join(root, 'StdUtils.nsh'))
  return { root, compiler, plugins }
}

test('real NSIS accepts Node-quoted and documented raw final /D paths without rewriting other quotes', {
  skip: process.platform !== 'win32', timeout: 180_000
}, async t => {
  const { root, compiler, plugins } = await compilerFixture('arguments')
  t.after(() => rm(root, { recursive: true, force: true }))
  const executable = join(root, 'parameters.exe')
  const source = join(root, 'parameters.nsi')
  await writeFile(source, `Unicode true
!addplugindir "${nsisPath(join(plugins, 'x86-unicode'))}"
!include "LogicLib.nsh"
!include "${nsisPath(join(root, 'StdUtils.nsh'))}"
!include "${nsisPath(fileURLToPath(new URL('../../apps/desktop/build/installer-init.nsh', import.meta.url)))}"
Name "Hexbot argument test"
OutFile "${nsisPath(executable)}"
RequestExecutionLevel user
SilentInstall silent
Section
  !insertmacro GetDParameter $R0
  ReadEnvStr $R1 HEXBOT_TEST_RESULT
  FileOpen $R1 $R1 w
  FileWriteByte $R1 255
  FileWriteByte $R1 254
  FileWriteUTF16LE $R1 $R0
  FileClose $R1
SectionEnd
`)
  await run(compiler.path, ['-V2', source], { env: { ...process.env, ...compiler.env }, timeout: 60_000 })
  const unicode = 'C:\\Users\\用户 A Ω\\Programs\\app.hexbot.desktop'
  const cases = [
    { args: ['/S', `/D=${unicode}`], expected: unicode },
    { args: ['/S', `/D=${unicode}`], raw: true, expected: unicode },
    { args: ['/S', `"/D=${unicode}"`], raw: true, expected: unicode },
    { args: ['/S', `/d=${unicode}`], expected: unicode },
    { args: ['/S', `/D="${unicode}"`], raw: true, expected: `"${unicode}"` },
    { args: ['/S', `--other=x"/D=${unicode}"`], raw: true, expected: `${unicode}"` }
  ]
  for (const [index, fixture] of cases.entries()) {
    const output = join(root, `result-${index}.txt`)
    await run(executable, fixture.args, { env: { ...process.env, HEXBOT_TEST_RESULT: output }, windowsVerbatimArguments: fixture.raw, timeout: 15_000 })
    const bytes = await readFile(output)
    assert.equal(bytes.subarray(0, 2).toString('hex'), 'fffe')
    assert.equal(bytes.subarray(2).toString('utf16le'), fixture.expected, JSON.stringify(fixture))
  }
})

test('real NSIS refuses its active app and leaves a running sibling untouched with an inherited module path', {
  skip: process.platform !== 'win32', timeout: 240_000
}, async t => {
  const { root, compiler, plugins } = await compilerFixture('processes')
  const children = []
  const stop = async child => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) })
    child.kill()
    await exited
  }
  t.after(async () => {
    try { await Promise.all(children.map(stop)) }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  const executable = join(root, 'check-processes.exe')
  const source = join(root, 'check-processes.nsi')
  const directory = join(root, "用户 Ω's Programs", 'app.hexbot.desktop')
  const sibling = `${directory}.nightly`
  const emptyModules = join(root, 'empty-modules')
  await Promise.all([directory, sibling, emptyModules].map(path => mkdir(path, { recursive: true })))
  await Promise.all([directory, sibling].map(path => copyFile(process.execPath, join(path, 'Hexbot.exe'))))
  await writeFile(source, `Unicode true
!addplugindir "${nsisPath(join(plugins, 'x86-unicode'))}"
!define APP_EXECUTABLE_FILENAME "Hexbot.exe"
!define APP_ID "app.hexbot.desktop"
!define APP_GUID "app.hexbot.desktop"
!define SHORTCUT_NAME "Hexbot [alpha]"
!define UNINSTALL_DISPLAY_NAME "Hexbot [alpha]"
!include "${nsisPath(fileURLToPath(new URL('../../apps/desktop/build/installer.nsh', import.meta.url)))}"
Name "Hexbot process test"
OutFile "${nsisPath(executable)}"
RequestExecutionLevel user
SilentInstall silent
Section
  ReadEnvStr $INSTDIR HEXBOT_TEST_INSTALL_DIRECTORY
  !insertmacro customCheckAppRunning
  SetErrorLevel 0
SectionEnd
`)
  await run(compiler.path, ['-V2', source], { env: { ...process.env, ...compiler.env }, timeout: 60_000 })
  const start = async path => {
    const child = spawn(join(path, 'Hexbot.exe'), ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let timer, output = ''
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Copied Node process did not start')), 10_000)
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`Copied Node process exited: ${code}`)))
      child.stdout.on('data', bytes => { output += bytes; if (output === 'ready') resolve() })
    }).finally(() => clearTimeout(timer))
    return child
  }
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
    PSModulePath: emptyModules, HEXBOT_TEST_INSTALL_DIRECTORY: directory
  }
  const siblingProcess = await start(sibling)
  await run(executable, ['/S'], { env, timeout: 30_000 })
  assert.equal(siblingProcess.exitCode, null, 'A sibling with a matching directory prefix must remain alive')
  const targetProcess = await start(directory)
  await assert.rejects(run(executable, ['/S'], { env, timeout: 30_000 }), error => error.code === 2)
  assert.equal(targetProcess.exitCode, null, 'The installer must ask for app exit rather than kill it')
  assert.equal(siblingProcess.exitCode, null, 'The active sibling must survive the refused installation')
  await stop(targetProcess)
  await run(executable, ['/S'], { env, timeout: 30_000 })
  assert.equal(siblingProcess.exitCode, null, 'The sibling must survive a successful check after target exit')
})
