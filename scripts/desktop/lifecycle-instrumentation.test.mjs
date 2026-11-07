import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { protocolSummary, withProtocolTrace } from './lifecycle-instrumentation.mjs'

test('protocol diagnostics retain context and acknowledgement metadata without code or values', () => {
  const request = protocolSummary({ id: 7, method: 'Runtime.callFunctionOn', params: {
    objectId: 'context.1', executionContextId: 4, awaitPromise: true, returnByValue: true,
    functionDeclaration: 'SECRET_CODE', arguments: [{ value: 'SECRET_ARGUMENT' }]
  } }, 'send')
  assert.equal(request.awaitPromise, true)
  assert.equal(request.executionContextId, 4)
  assert.equal(request.objectId, 'context.1')
  assert(!JSON.stringify(request).includes('SECRET'))
  const created = protocolSummary({ method: 'Runtime.executionContextCreated', params: { context: {
    id: 4, name: 'Electron', uniqueId: 'unique-context', origin: 'SECRET_ORIGIN', auxData: { isDefault: true, other: 'SECRET_OTHER' }
  } } }, 'receive')
  assert.equal(created.executionContextId, 4)
  assert.equal(created.isDefault, true)
  assert.equal(created.uniqueId, 'unique-context')
  assert(!JSON.stringify(created).includes('SECRET'))
  const reply = protocolSummary({ id: 7, result: { result: { type: 'object', subtype: 'promise', value: 'SECRET_RESULT' } } }, 'receive')
  assert.equal(reply.resultSubtype, 'promise')
  assert(!JSON.stringify(reply).includes('SECRET'))
  const failed = protocolSummary({ id: 7, error: { code: -32000, message: 'Promise was collected' } }, 'receive')
  assert.deepEqual(failed.error, { code: -32000, message: 'Promise was collected' })
  assert.equal(protocolSummary({ error: { message: 'x'.repeat(2048) } }, 'receive').error.message.length, 512)
})


test('real-launch trace preserves a protocol failure and restores the existing logger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-protocol-trace-'))
  const original = () => {}
  let namespaces = 'existing:logger'
  const debug = { log: original, disable() { const prior = namespaces; namespaces = ''; return prior }, enable(value) { namespaces = value } }
  const failure = new Error('Resulting promise was garbage collected')
  const file = join(root, 'trace.jsonl')
  try {
    await assert.rejects(withProtocolTrace(debug, file, () => 'full', async record => {
      record('instrumentation-request', { trackedPid: 123 })
      debug.log('SEND ► %s', JSON.stringify({ id: 9, method: 'Runtime.callFunctionOn', params: { awaitPromise: true, objectId: 'context.1', functionDeclaration: 'SECRET' } }))
      debug.log('◀ RECV %s', JSON.stringify({ id: 9, error: { code: -32000, message: 'Promise was collected' } }))
      throw failure
    }), error => error === failure)
    const data = await readFile(file, 'utf8')
    assert(!data.includes('SECRET'))
    const records = data.trim().split('\n').map(JSON.parse)
    assert.equal(records.filter(r => r.event === 'protocol').length, 2)
    assert.equal(records.find(r => r.error)?.error.message, 'Promise was collected')
    assert.equal(records.at(-1).event, 'protocol-summary')
    assert.equal(debug.log, original)
    assert.equal(namespaces, 'existing:logger')
    await assert.rejects(withProtocolTrace(debug, join(root, 'absent/trace'), () => 'full', async () => { throw failure }), error => error === failure)
    assert.equal(debug.log, original)
    assert.equal(namespaces, 'existing:logger')
  } finally { await rm(root, { recursive: true, force: true }) }
})
