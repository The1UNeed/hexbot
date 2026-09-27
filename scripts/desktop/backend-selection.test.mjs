import assert from 'node:assert/strict'
import test from 'node:test'
import { builderConfig, nativeBuildEnvironment, selectBackend } from './backend-selection.mjs'

test('full builds select Rust by default and retain explicit Python rollback', () => {
  assert.equal(selectBackend([], {}), 'rust')
  assert.equal(selectBackend([], { HEXBOT_BACKEND: 'python' }), 'python')
  assert.equal(selectBackend(['--backend', 'rust'], { HEXBOT_BACKEND: 'python' }), 'rust')
  assert.equal(selectBackend(['--backend', 'python'], {}), 'python')
  assert.throws(() => selectBackend(['--backend'], {}), /backend/)
  assert.throws(() => selectBackend([], { HEXBOT_BACKEND: 'invalid' }), /backend/)
})
test('client packages never include either daemon runtime', () => {
  assert.deepEqual(builderConfig('rust', false), [])
  assert.deepEqual(builderConfig('python', false), ['--config', 'electron-builder.python.yml'])
  for (const backend of ['rust', 'python']) assert.deepEqual(builderConfig(backend, true), ['--config', 'electron-builder.client.yml'])
})

test('native packages require one matching platform and architecture', () => {
  assert.deepEqual(nativeBuildEnvironment(['--mac', '--arm64'], 'darwin', 'arm64'), {
    HEXBOT_BUILD_PLATFORM: 'darwin', HEXBOT_BUILD_ARCH: 'arm64'
  })
  assert.deepEqual(nativeBuildEnvironment(['--linux'], 'linux', 'x64'), {
    HEXBOT_BUILD_PLATFORM: 'linux', HEXBOT_BUILD_ARCH: 'x64'
  })
  for (const args of [['--mac', '--linux'], ['--mac', '--arm64', '--x64'], ['--mac', '--universal']])
    assert.throws(() => nativeBuildEnvironment(args, 'darwin', 'arm64'), /one native/)
  assert.throws(() => nativeBuildEnvironment(['--mac', '--x64'], 'darwin', 'arm64'), /runner/)
})
