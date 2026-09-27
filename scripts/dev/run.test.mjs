import assert from 'node:assert/strict'
import test from 'node:test'
import { derivePorts, selectBackend } from './run.mjs'

test('dev ports derive from the checkout path and stay apart per worktree', () => {
  const a = derivePorts('/home/alex/hexbot')
  const b = derivePorts('/home/alex/hexbot-worktree')
  assert.deepEqual(a, derivePorts('/home/alex/hexbot'))
  assert.ok(a.daemon >= 9200 && a.daemon < 9900)
  assert.equal(a.web, a.daemon + 1000)
  assert.notEqual(a.daemon, b.daemon)
})


test('dev defaults to Rust and permits explicit Python rollback', () => {
  assert.equal(selectBackend([], {}), 'rust')
  assert.equal(selectBackend(['--backend', 'rust'], {}), 'rust')
  assert.equal(selectBackend([], { HEXBOT_BACKEND: 'rust' }), 'rust')
  assert.equal(selectBackend([], { HEXBOT_BACKEND: 'python' }), 'python')
  assert.equal(selectBackend(['--backend', 'python'], { HEXBOT_BACKEND: 'rust' }), 'python')
  assert.throws(() => selectBackend(['--backend'], {}), /backend/)
  assert.throws(() => selectBackend(['--backend', 'other'], {}), /backend/)
})
