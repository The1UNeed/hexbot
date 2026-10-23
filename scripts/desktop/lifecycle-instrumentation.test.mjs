import assert from 'node:assert/strict'
import test from 'node:test'
import { protocolSummary } from './lifecycle-instrumentation.mjs'

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
