import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)

test('real NSIS accepts Node-quoted and documented raw final /D paths without rewriting other quotes', {
  skip: process.platform !== 'win32', timeout: 180_000
}, async t => {
  const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
  const builderRequire = createRequire(require.resolve('electron-builder'))
  const builderRoot = dirname(builderRequire.resolve('app-builder-lib/package.json'))
  const { getMakeNsisPath, getNsisPluginsPath } = builderRequire('app-builder-lib/out/toolsets/windows')
  const [compiler, plugins] = await Promise.all([getMakeNsisPath(), getNsisPluginsPath()])
  const root = await mkdtemp(join(tmpdir(), 'Hexbot NSIS arguments '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const executable = join(root, 'parameters.exe')
  const source = join(root, 'parameters.nsi')
  const nsisPath = path => path.replaceAll('\\', '/').replaceAll('$', '$$')
  await writeFile(source, `Unicode true
!addplugindir "${nsisPath(join(plugins, 'x86-unicode'))}"
!include "LogicLib.nsh"
!include "${nsisPath(join(builderRoot, 'templates/nsis/include/StdUtils.nsh'))}"
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
