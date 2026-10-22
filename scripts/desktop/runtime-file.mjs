import { realpathSync, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { nodePath } from '../../apps/desktop/src/main/backend/node-path.ts'

// Windows notifications use long paths, even when TEMP used an 8.3 alias.
// Older libuv asserts on that mismatch before JavaScript can catch an error.
export function waitForRuntimeJson(path, predicate, timeout = 30_000, watchDirectory = watch) {
  const directory = nodePath(realpathSync.native(dirname(path)))
  const file = join(directory, basename(path))
  console.error('Runtime watcher:', JSON.stringify({ node: process.versions.node, uv: process.versions.uv,
    input: dirname(path), directory, file }))
  return new Promise((resolve, reject) => {
    let settled = false
    let watcher, timer
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      watcher?.close()
      if (error) reject(error)
      else resolve(value)
    }
    const check = async () => {
      try {
        const value = JSON.parse(await readFile(file, 'utf8'))
        if (predicate(value)) finish(undefined, value)
      } catch (error) {
        // Atomic replacement can briefly remove a file; a fixture can also be
        // observed before its JSON write finishes. Other I/O errors must fail.
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) finish(error)
      }
    }
    try {
      watcher = watchDirectory(directory, check)
      watcher.once('error', finish)
      timer = setTimeout(() => finish(new Error(`Timed out waiting for ${file}`)), timeout)
      void check()
    } catch (error) { finish(error) }
  })
}
