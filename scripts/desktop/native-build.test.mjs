import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeBuildEnvironment } from './native-build.mjs'
import { parseBuildArgs } from './build-config.mjs'

test('native builds allow Intel macOS on Apple Silicon and reject other cross builds', () => {
  assert.deepEqual(nativeBuildEnvironment(['--mac', '--x64'], 'darwin', 'arm64'), {
    HEXBOT_BUILD_PLATFORM: 'darwin', HEXBOT_BUILD_ARCH: 'x64'
  })
  for (const args of [['--mac', '--linux'], ['--mac', '--arm64', '--x64'], ['--mac', '--universal']])
    assert.throws(() => nativeBuildEnvironment(args, 'darwin', 'arm64'), /one native/)
  assert.throws(() => nativeBuildEnvironment(['--linux', '--arm64'], 'linux', 'x64'), /runner/)
  assert.throws(() => parseBuildArgs(['--mac', '--backend', 'python']), /removed/)
})
