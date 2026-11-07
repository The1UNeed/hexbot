import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { waitForRuntimeJson } from './runtime-file.mjs'
import { nodePath } from '../../apps/desktop/src/main/backend/node-path.ts'
const exec = promisify(execFile)

test('runtime readiness canonicalizes the directory and reads creation/replacement notifications', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot watcher '))
  try {
    const directory = join(root, 'José long directory'); await mkdir(directory)
    const alias = join(root, 'alias'); await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
    let watched, notify, closed
    for (const revision of [1, 2]) {
      const waiting = waitForRuntimeJson(join(alias, 'serve-state.json'), value => value.revision === revision, 5000,
        (path, listener) => {
          watched = path; notify = listener; closed = false
          return Object.assign(new EventEmitter(), { close() { closed = true } })
        })
      await writeFile(join(directory, 'temporary.json'), JSON.stringify({ revision }))
      await rename(join(directory, 'temporary.json'), join(directory, 'serve-state.json'))
      notify()
      assert.deepEqual(await waiting, { revision })
      assert.equal(watched, nodePath(realpathSync.native(directory)))
      assert.equal(closed, true)
    }
    assert.throws(() => waitForRuntimeJson(join(root, 'absent', 'state.json'), () => true), /ENOENT/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('native pinned Node reproduces the short-path assertion; canonical watch completes with exit zero',
  { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'hexbot 8dot3 watcher '))
    try {
      const directory = join(root, 'long directory with spaces'); await mkdir(directory)
      const ps = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
      const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public class HexbotShortPath {[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern uint GetShortPathName(string path,StringBuilder output,uint size);}';$s=[Text.StringBuilder]::new(32768);if([HexbotShortPath]::GetShortPathName('${directory.replaceAll("'", "''")}',$s,32768) -eq 0){throw 'GetShortPathName failed'};$s.ToString()`
      const short = (await exec(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })).stdout.trim()
      const long = nodePath(realpathSync.native(directory))
      assert.notEqual(short.toLowerCase(), long.toLowerCase(), 'Native fixture requires an actual 8.3 alias')
      console.error('Native watcher paths:', JSON.stringify({ short, long, node: process.version, uv: process.versions.uv }))
      const fixture = `
        import { watch } from 'node:fs';
        import { writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        import { waitForRuntimeJson } from ${JSON.stringify(new URL('./runtime-file.mjs', import.meta.url).href)};
        const [mode, alias, file] = process.argv.slice(1);
        if (mode === 'legacy') {
          const timer = setTimeout(() => { throw new Error('Legacy watch produced no event') }, 5000);
          const watcher = watch(alias, () => { watcher.close(); clearTimeout(timer) });
          await writeFile(file, '{"ready":true}');
        } else {
          const waiting = waitForRuntimeJson(join(alias, 'serve-state.json'), v => v.ready, 5000);
          await writeFile(file, '{"ready":true}');
          if (!(await waiting).ready) throw new Error('Readiness missing');
        }
      `
      const file = join(long, 'serve-state.json')
      await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', fixture, 'legacy', short, file], { windowsHide: true, timeout: 10_000 }),
        error => { assert.match(error.stderr, /Assertion failed: !_wcsnicmp\(filename, dir, dirlen\).*fs-event\.c/s); return true })
      await rm(file, { force: true })
      await exec(process.execPath, ['--input-type=module', '-e', fixture, 'fixed', short, file], { windowsHide: true, timeout: 10_000 })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
