// Probe the already-built release daemon. Debug admission failures must fail.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)
export async function assertDevActionAbsent(executable, root, run = exec) {
  const home = join(root, 'dev-action-must-not-create-home')
  const marker = join(root, 'dev-action-must-not-run')
  let failure
  try {
    await run(executable, ['__dev-child', 'release-probe', '--', join(dirname(executable), 'node.exe'), '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'owned')`], {
      env: { ...process.env, HEXBOT_HOME: home }, windowsHide: true, timeout: 10_000
    })
  } catch (error) { failure = error }
  assert(failure, 'Release daemon dispatched the private Dev action')
  assert.equal(failure.code, 1)
  assert.equal(failure.stdout, '')
  assert.equal(failure.stderr.trim(), 'unknown command: __dev-child')
  await assert.rejects(access(home), { code: 'ENOENT' })
  await assert.rejects(access(marker), { code: 'ENOENT' })
}
