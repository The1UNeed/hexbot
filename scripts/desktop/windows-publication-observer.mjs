// Test-only observer. It never renames, retries publication, or retains a
// staged-file/child-process handle before the original failure.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export async function publicationObserver() {
  assert.equal(process.platform, 'win32')
  const system = process.env.SystemRoot
  assert(system && isAbsolute(system))
  const program = join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const info = await lstat(program)
  assert(info.isFile() && !info.isSymbolicLink())
  const worker = spawn(program, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./windows-publication-observer.ps1', import.meta.url))], {
    cwd: tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  })
  const closed = once(worker, 'close')
  closed.catch(() => {})
  let stderr = '', next = 0, pending
  worker.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096) })
  const lines = createInterface({ input: worker.stdout })
  lines.on('line', line => {
    if (line.length > 32768) return pending?.reject(new Error('Observer response too large'))
    try { pending?.resolve(JSON.parse(line)) } catch (error) { pending?.reject(error) }
  })
  worker.on('error', error => pending?.reject(error))
  worker.stdin.on('error', error => pending?.reject(error))
  worker.on('close', code => pending?.reject(new Error(`Observer closed ${code}: ${stderr}`)))
  function response(send) {
    assert(!pending, 'One bounded observer request at a time')
    let timer
    return new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Observer deadline: ${stderr}`)), 8000)
      pending = { resolve, reject }
      send?.()
    }).finally(() => { clearTimeout(timer); pending = undefined })
  }
  // Timer is scoped to each response, including startup. Keep cleanup available
  // even when PowerShell fails to compile its read-only P/Invoke definitions.
  async function close() {
    worker.stdin.end()
    const timer = setTimeout(() => { if (worker.exitCode === null) worker.kill() }, 2000)
    try { await closed } finally { clearTimeout(timer); lines.close() }
  }
  let ready
  try { ready = await response(); assert.equal(ready.ready, true) }
  catch (error) { await close(); throw error }
  return {
    ready: { ...ready, program }, close,
    async observe(staging, destination, probe, error) {
      const failed = { utc: new Date().toISOString(), monotonicMs: performance.now(), code: error.code, errno: error.errno, syscall: error.syscall }
      const id = ++next
      const requested = { utc: new Date().toISOString(), monotonicMs: performance.now() }
      const result = await response(() => worker.stdin.write(JSON.stringify({ id, paths: [staging, destination], pid: probe?.pid ?? 0 }) + '\n'))
      assert.equal(result.id, id)
      return { failure: failed, requested, received: { utc: new Date().toISOString(), monotonicMs: performance.now() }, worker: result }
    }
  }
}
