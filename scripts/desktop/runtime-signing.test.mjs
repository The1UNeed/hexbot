import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
const run = promisify(execFile)

test('bundled Node and daemon run under the macOS hardened runtime', {
  skip: process.platform !== 'darwin' || !process.env.HEXBOT_NATIVE_TEST_BUNDLE
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-signed-'))
  const bundle = process.env.HEXBOT_NATIVE_TEST_BUNDLE
  try {
    for (const name of ['node', 'hexbot-core']) {
      const binary = join(root, name)
      await cp(join(bundle, name), binary)
      await run('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', resolve('apps/desktop/entitlements.mac.plist'), binary])
      await run('codesign', ['--verify', '--strict', binary])
    }
    const env = { ...process.env, HEXBOT_HOME: root }
    const node = await run(join(root, 'node'), ['-e', 'let n=0; for(let i=0;i<1e6;i++) n+=i; console.log(n)'], { env })
    assert.equal(node.stdout.trim(), '499999500000')
    const pi = await run(join(root, 'node'), [join(bundle, 'pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--version'], { env })
    assert.equal(pi.stdout.trim(), '0.87.1')
    const daemon = await run(join(root, 'hexbot-core'), ['version'], { env })
    assert.match(daemon.stdout, /^\d+\.\d+\.\d+/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
