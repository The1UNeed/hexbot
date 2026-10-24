import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeTestEnvironment, requireOneRustTest } from './run-one-rust-test.mjs'

test('native probe rejects nonexistent or ignored filters even when cargo exits successfully', () => {
  const result = (running, passed, ignored) => `running ${running} test\r\ntest result: ok. ${passed} passed; 0 failed; ${ignored} ignored; 0 measured; 2 filtered out; finished in 1.00s\r\n`
  requireOneRustTest(result(1, 1, 0))
  assert.throws(() => requireOneRustTest(result(0, 0, 0)))
  assert.throws(() => requireOneRustTest(result(1, 0, 1)))
  assert.throws(() => requireOneRustTest(result(2, 2, 0)))
  assert.throws(() => requireOneRustTest('running 1 test\ntest result: FAILED. 0 passed; 1 failed; 0 ignored;'))
})


test('GUI harness forwards the running Node as one verified path, independent of discovery strings', () => {
  const probe = fileURLToPath(import.meta.url)
  const env = nativeTestEnvironment({ HEXBOT_WINDOWS_GUI_PROBE: probe,
    HEXBOT_WINDOWS_GUI_NODE: 'C:\\node one\\node.exe C:\\node two\\node.exe', KEEP: 'value' })
  assert.equal(env.HEXBOT_WINDOWS_GUI_NODE, realpathSync(process.execPath))
  assert.equal(env.HEXBOT_WINDOWS_GUI_PROBE, realpathSync(probe))
  assert.equal(env.KEEP, 'value')
  assert.throws(() => nativeTestEnvironment({ HEXBOT_WINDOWS_GUI_PROBE: probe }, 'node'))
  assert.throws(() => nativeTestEnvironment({ HEXBOT_WINDOWS_GUI_PROBE: probe }, dirname(process.execPath)))
  assert.throws(() => nativeTestEnvironment({ HEXBOT_WINDOWS_GUI_PROBE: 'relative.mjs' }))
  assert.throws(() => nativeTestEnvironment({ HEXBOT_WINDOWS_GUI_PROBE: dirname(probe) }))
})

test('service readiness fixture receives exactly the already-running trusted Node', () => {
  const env = nativeTestEnvironment({ HEXBOT_WINDOWS_SERVICE_PROBE: '1', HEXBOT_WINDOWS_SERVICE_NODE: 'joined untrusted discovery output' })
  assert.equal(env.HEXBOT_WINDOWS_SERVICE_NODE, realpathSync(process.execPath))
  assert.throws(() => nativeTestEnvironment({ HEXBOT_WINDOWS_SERVICE_PROBE: '1' }, 'node'))
  assert.throws(() => nativeTestEnvironment({ HEXBOT_WINDOWS_SERVICE_PROBE: '1' }, dirname(process.execPath)))
})
