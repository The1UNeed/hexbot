import assert from 'node:assert/strict'
import test from 'node:test'
import { derivePorts } from './run.mjs'

test('dev ports derive from the checkout path and stay apart per worktree', () => {
  const a = derivePorts('/home/alex/hexbot')
  const b = derivePorts('/home/alex/hexbot-worktree')
  assert.deepEqual(a, derivePorts('/home/alex/hexbot'))
  assert.ok(a.daemon >= 9200 && a.daemon < 9900)
  assert.equal(a.web, a.daemon + 1000)
  assert.notEqual(a.daemon, b.daemon)
})
