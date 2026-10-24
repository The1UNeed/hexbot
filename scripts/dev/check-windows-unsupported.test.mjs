import assert from 'node:assert/strict'
import test from 'node:test'
import { checkUnsupportedDiagnostics } from './check-windows-unsupported.mjs'
const message = 'The Hexbot daemon supports macOS and Linux only'
const guard = { reason: 'compiler-message', target: { name: 'hexbot_core', kind: ['lib'] }, message: {
  level: 'error', message, code: null, spans: [{ is_primary: true, file_name: 'src\\lib.rs', text: [{ text: `compile_error!("${message}");` }] }],
} }
const finished = { reason: 'build-finished', success: false }
const result = (events = [guard, finished], status = 101) => ({ stdout: events.map(e => JSON.stringify(e)).join('\n'), status })
test('production gate accepts exactly the unsupported diagnostic and failed build', () => {
  checkUnsupportedDiagnostics(result())
  checkUnsupportedDiagnostics({ ...result(), stderr: 'error: could not compile `hexbot-core` (lib) due to 1 previous error; 8 warnings emitted\n' })
  assert.throws(() => checkUnsupportedDiagnostics({ ...result(), stderr: 'error: failed to run custom build command for other-crate\n' }))
  assert.throws(() => checkUnsupportedDiagnostics({ ...result(), stderr: 'error: could not compile `other-crate` (lib) due to 1 previous error\n' }))
  checkUnsupportedDiagnostics(result([{ reason: 'compiler-artifact' }, { ...guard, message: { ...guard.message, level: 'warning' } }, guard, finished]))
  for (const status of [0, 1, null]) assert.throws(() => checkUnsupportedDiagnostics(result(undefined, status)))
  assert.throws(() => checkUnsupportedDiagnostics({ ...result(), signal: 'SIGTERM' }))
  assert.throws(() => checkUnsupportedDiagnostics({ ...result(), stdout: 'bad JSON' }))
  for (const events of [[], [finished], [guard], [guard, guard, finished], [guard, { ...finished, success: true }],
    [guard, { ...guard, message: { ...guard.message, message: 'cannot find libc' } }, finished],
    [{ ...guard, message: { ...guard.message, message: 'different compile error' } }, finished],
    [{ ...guard, message: { ...guard.message, spans: [] } }, finished]])
    assert.throws(() => checkUnsupportedDiagnostics(result(events)))
})
