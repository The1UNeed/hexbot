import assert from 'node:assert/strict';
import test from 'node:test';
import {stripUnsupportedGuard} from './prepare-windows-security.mjs';

const guard = '#[cfg(not(any(target_os = "macos", target_os = "linux")))]\ncompile_error!("The Hexbot daemon supports macOS and Linux only");\n';
test('disposable source edit removes only one exact guard and preserves all other bytes', () => {
  const before = Buffer.from('//! keep\n\n' + guard + '\nmod keep;\n');
  assert.deepEqual(stripUnsupportedGuard(before),Buffer.from('//! keep\n\n\nmod keep;\n'));
  assert.equal(before.includes(Buffer.from(guard)),true,'input bytes must not be mutated');
  for (const text of ['',guard.replaceAll('\n','\r\n'),guard.replace('Linux only','Linux'),guard + guard]) {
    assert.throws(() => stripUnsupportedGuard(Buffer.from(text)),/exactly one exact/);
  }
});
