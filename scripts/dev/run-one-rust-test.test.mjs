import assert from 'node:assert/strict'
import test from 'node:test'
import { requireOneRustTest } from './run-one-rust-test.mjs'

test('native probe rejects nonexistent or ignored filters even when cargo exits successfully', () => {
  const result = (running, passed, ignored) => `running ${running} test\r\ntest result: ok. ${passed} passed; 0 failed; ${ignored} ignored; 0 measured; 2 filtered out; finished in 1.00s\r\n`
  requireOneRustTest(result(1, 1, 0))
  assert.throws(() => requireOneRustTest(result(0, 0, 0)))
  assert.throws(() => requireOneRustTest(result(1, 0, 1)))
  assert.throws(() => requireOneRustTest(result(2, 2, 0)))
  assert.throws(() => requireOneRustTest('running 1 test\ntest result: FAILED. 0 passed; 1 failed; 0 ignored;'))
})
