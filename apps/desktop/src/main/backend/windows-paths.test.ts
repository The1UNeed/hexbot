import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { nativeServiceExecutable } from './paths'
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' } }))
const exec = promisify(execFile)

it.skipIf(process.platform !== 'win32')('selects the same canonical EXE through verbatim, junction and SUBST paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot Jos\u00e9 path '))
  const home = join(root, 'home')
  const native = join(home, 'runtime/native')
  const directory = join(native, 'selected')
  const outside = join(root, 'outside')
  const alias = join(root, 'home junction')
  const previous = process.env.HEXBOT_HOME
  let drive: string | undefined
  const subst = join(process.env.SystemRoot!, 'System32/subst.exe')
  try {
    await mkdir(directory, { recursive: true }); await mkdir(outside)
    const exe = join(directory, 'hexbot.exe')
    await writeFile(exe, 'MZ')
    await writeFile(join(outside, 'hexbot.exe'), 'MZ')
    const canonical = win32.toNamespacedPath(realpathSync.native(exe))
    await writeFile(join(home, 'runtime/native-current.json'), JSON.stringify({ executable: canonical }))
    const selected = (): void => expect(win32.toNamespacedPath(realpathSync.native(nativeServiceExecutable()))).toBe(canonical)
    process.env.HEXBOT_HOME = home; selected()
    await symlink(home, alias, 'junction')
    process.env.HEXBOT_HOME = alias; selected()
    for (const letter of ['Z', 'Y', 'X', 'W', 'V', 'U']) {
      try { await exec(subst, [`${letter}:`, root]); drive = `${letter}:`; break } catch { /* Never remove an existing mapping. */ }
    }
    if (!drive) throw new Error('No free test SUBST drive')
    process.env.HEXBOT_HOME = `${drive}\\home`; selected()
    await symlink(outside, join(native, 'linked-build'), 'junction')
    await writeFile(join(home, 'runtime/native-current.json'), JSON.stringify({ executable: join(native, 'linked-build/hexbot.exe') }))
    expect(() => nativeServiceExecutable()).toThrow('Invalid Windows runtime selection')
  } finally {
    if (drive) await exec(subst, [drive, '/D'])
    if (previous === undefined) delete process.env.HEXBOT_HOME; else process.env.HEXBOT_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
