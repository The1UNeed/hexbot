import assert from 'node:assert/strict'
import test from 'node:test'
import { win32 } from 'node:path'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodePath } from '../../apps/desktop/src/main/backend/node-path.ts'

test('Node operands retain long DOS/UNC names and Unicode after namespace conversion', () => {
  const dos = String.raw`C:\José state\Node argv π check.mjs`
  const unc = String.raw`\\server\share\José state\pi\launch.mjs`
  for (const [input, expected] of [
    [dos, dos],
    [win32.toNamespacedPath(dos), dos],
    [unc, unc],
    [win32.toNamespacedPath(unc), unc]
  ])
    assert.equal(nodePath(input, 'win32'), expected)
  for (const path of [
    String.raw`\\.\pipe\probe`,
    String.raw`\\?\Volume{device}\probe`,
    String.raw`C:relative`,
    String.raw`\root-relative`,
    'relative.mjs'
  ])
    assert.throws(() => nodePath(path, 'win32'))
  assert.equal(nodePath('/native/Pi π/launch.mjs', 'linux'), '/native/Pi π/launch.mjs')
  assert.equal(nodePath('/native/Pi π/launch.mjs', 'darwin'), '/native/Pi π/launch.mjs')
})

test(
  'native Node loads normalized canonical script operands and preserves argv',
  { skip: process.platform !== 'win32' },
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'hexbot Node José '))
    t.after(() => rm(root, { recursive: true, force: true }))
    const script = join(root, 'Node argv π check.mjs')
    await writeFile(
      script,
      'process.stdout.write(JSON.stringify({execPath:process.execPath,argv:process.argv.slice(2)}))'
    )
    const expected = ['with spaces', 'a&b', 'literal"quote', 'π']
    const canonical = realpathSync.native(script)
    for (const program of [
      process.execPath,
      win32.toNamespacedPath(realpathSync.native(process.execPath))
    ]) {
      for (const input of [canonical, win32.toNamespacedPath(canonical)]) {
        const operand = nodePath(input)
        assert.equal(realpathSync.native(operand), canonical)
        const result = JSON.parse(
          execFileSync(program, [operand, ...expected], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 30_000
          })
        )
        assert.deepEqual(result.argv, expected)
        assert.equal(
          win32.toNamespacedPath(realpathSync.native(result.execPath)),
          win32.toNamespacedPath(realpathSync.native(process.execPath))
        )
      }
    }
  }
)
