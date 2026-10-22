import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('Windows local tool boundary refuses before file access, shell discovery, approval or spawn', () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./fixtures/windows-security.mjs', import.meta.url)), ...process.platform === 'win32' ? [] : ['--simulate-windows']], {encoding:'utf8', timeout:30000});
  assert.match(output, /Windows fail-closed probes passed/);
});
