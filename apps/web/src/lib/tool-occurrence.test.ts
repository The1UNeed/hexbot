import type { GatewayEvent } from '@hermes/shared'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from '../stores/transcripts'

import type { HistoryRow } from './api'
import { messagesFromHistory } from './api'
import { routeEvent } from './events'

const event = (type: string, payload: Record<string, unknown> = {}) =>
  routeEvent({ type, session_id: 's', payload } as GatewayEvent)

const calls = () => useTranscripts.getState().bySession.s!.messages.flatMap(m => m.toolCalls)
const state = () => useTranscripts.getState().bySession.s!

const start = (message = 'a', turn = 'run', tool = 'same', args: unknown = { source: message }) => {
  event('message.start', { turn_id: turn })
  event('tool.start', { message_id: message, turn_id: turn, tool_id: tool, name: 'memory', args })
}

const assistant = (id: string, turn = 'run', tool = 'same'): HistoryRow => ({
  role: 'assistant',
  row_id: id,
  turn_id: turn,
  text: id,
  tool_calls: [
    { id: tool, function: { name: 'memory', arguments: JSON.stringify({ source: id }) } }
  ]
})

const result = (id: string, turn = 'run', tool = 'same'): HistoryRow => ({
  role: 'tool',
  row_id: id,
  turn_id: turn,
  tool_call_id: tool,
  name: 'memory',
  text: id
})

const hydrate = (rows: HistoryRow[]) =>
  useTranscripts.getState().open('s', 'chat', messagesFromHistory(rows), { reports: [] })

beforeEach(() => {
  useTranscripts.setState({ bySession: {} })
  setTranscriptEffects({ touchSection: () => {}, notify: () => {}, ackApproval: () => {} })
})
afterEach(resetTranscriptEffects)

it('completes only the proven fragment when two top-level calls reuse an ID', () => {
  start('a')
  event('tool.start', {
    message_id: 'b',
    turn_id: 'run',
    tool_id: 'same',
    name: 'memory',
    args: { source: 'b' }
  })
  event('tool.complete', {
    message_id: 'a',
    turn_id: 'run',
    tool_id: 'same',
    args: { source: 'a-complete' },
    result_text: 'a-result'
  })
  expect(calls()).toMatchObject([
    { messageId: 'a', args: { source: 'a-complete' }, result: 'a-result', status: 'ok' },
    { messageId: 'b', args: { source: 'b' }, result: null, status: 'running' }
  ])
})

it('withholds an omitted-source completion when distinct fragments share an ID', () => {
  start('a')
  event('tool.start', { message_id: 'b', turn_id: 'run', tool_id: 'same', name: 'memory' })
  event('tool.complete', { turn_id: 'run', tool_id: 'same', result_text: 'unproven' })
  expect(calls().map(call => [call.messageId, call.status, call.result])).toEqual([
    ['a', 'running', null],
    ['b', 'running', null]
  ])
})

it.each([true, false])(
  'routes an old same-ID completion to its own turn without settling the new run, fragment=%s',
  fragment => {
    start('a', 'old')
    event('message.complete', { turn_id: 'old' })
    start('b', 'new')
    const streaming = state().streamingMessageId
    event('tool.complete', {
      turn_id: 'old',
      ...(fragment && { message_id: 'a' }),
      tool_id: 'same',
      result_text: 'old-result'
    })
    event('tool.complete', { turn_id: 'old', tool_id: 'unknown', result_text: 'orphan' })
    expect(calls()).toMatchObject([
      { messageId: 'a', result: 'old-result' },
      { messageId: 'b', result: null, status: 'running' }
    ])
    expect(state()).toMatchObject({
      turnActive: true,
      activeTurnId: 'new',
      streamingMessageId: streaming
    })
  }
)

it('keeps parent-scoped siblings separate even when their child IDs are equal', () => {
  start('a', 'run', 'parent-a')
  event('tool.start', { message_id: 'b', turn_id: 'run', tool_id: 'parent-b', name: 'codemode' })

  for (const parent of ['parent-a', 'parent-b']) {
    event('tool.start', {
      turn_id: 'run',
      tool_id: 'child',
      parent_tool_call_id: parent,
      name: 'memory',
      args: { parent }
    })
  }

  event('tool.complete', {
    turn_id: 'run',
    tool_id: 'child',
    parent_tool_call_id: 'parent-a',
    args: { parent: 'finished-a' },
    result_text: 'a-result'
  })
  expect(calls().filter(call => call.toolId === 'child')).toMatchObject([
    {
      messageId: 'a',
      parentToolCallId: 'parent-a',
      args: { parent: 'finished-a' },
      result: 'a-result',
      status: 'ok'
    },
    {
      messageId: 'b',
      parentToolCallId: 'parent-b',
      args: { parent: 'parent-b' },
      result: null,
      status: 'running'
    }
  ])
})

it('accepts a legacy omitted-parent completion only when its occurrence is unique', () => {
  start('a', 'run', 'parent')
  event('tool.start', { tool_id: 'child', parent_tool_call_id: 'parent', name: 'memory' })
  event('tool.complete', { tool_id: 'child', result_text: 'legacy-result' })
  expect(calls()[1]).toMatchObject({
    parentToolCallId: 'parent',
    messageId: 'a',
    result: 'legacy-result',
    status: 'ok'
  })
})

it('does not choose between a top-level and nested occurrence when completion omits parent and fragment', () => {
  start('a')
  event('tool.start', { message_id: 'b', tool_id: 'parent', name: 'codemode' })
  event('tool.start', { tool_id: 'same', parent_tool_call_id: 'parent', name: 'memory' })
  event('tool.complete', { tool_id: 'same', result_text: 'unproven' })
  expect(
    calls()
      .filter(call => call.toolId === 'same')
      .map(call => call.status)
  ).toEqual(['running', 'running'])
  expect(calls()).toHaveLength(3)
})

it('keeps duplicate starts ambiguous rather than updating both or adding a completion', () => {
  start()
  event('tool.start', { message_id: 'a', turn_id: 'run', tool_id: 'same' })
  event('tool.complete', {
    message_id: 'a',
    turn_id: 'run',
    tool_id: 'same',
    result_text: 'unproven'
  })
  expect(calls().map(call => call.status)).toEqual(['running', 'running'])
})

it('keeps a child unbound when its omitted fragment cannot choose between duplicate parents', () => {
  start('a', 'run', 'parent')
  event('tool.start', { message_id: 'b', turn_id: 'run', tool_id: 'parent', name: 'codemode' })
  event('tool.start', {
    turn_id: 'run',
    tool_id: 'child',
    parent_tool_call_id: 'parent',
    name: 'memory'
  })
  expect(calls().at(-1)).toMatchObject({
    toolId: 'child',
    parentToolCallId: 'parent',
    messageId: undefined
  })
})

it('keeps reconnect completion fallback parent linkage without adopting a colliding top-level call', () => {
  start('a', 'run', 'child')
  event('tool.start', { message_id: 'b', turn_id: 'run', tool_id: 'parent', name: 'codemode' })
  event('tool.complete', {
    turn_id: 'run',
    tool_id: 'child',
    parent_tool_call_id: 'parent',
    name: 'memory',
    result_text: 'reconnected'
  })
  expect(calls()).toMatchObject([
    { toolId: 'child', messageId: 'a', result: null, status: 'running' },
    { toolId: 'parent', messageId: 'b' },
    { toolId: 'child', parentToolCallId: 'parent', messageId: 'b', result: 'reconnected' }
  ])
})

it('uses a unique declared turn to separate equal top-level IDs in durable history and repeated hydration', () => {
  const rows = [
    assistant('a', 'old'),
    result('result-a', 'old'),
    assistant('b', 'new'),
    result('result-b', 'new')
  ]

  for (let read = 0; read < 3; read++) {
    hydrate(rows)
    expect(calls()).toMatchObject([
      { messageId: 'a', args: { source: 'a' }, result: 'result-a' },
      { messageId: 'b', args: { source: 'b' }, result: 'result-b' }
    ])
  }
})

it.each(['same-turn', 'omitted-turn', 'duplicate-row'])(
  'withholds history source for ambiguous declarations, %s',
  mode => {
    const a = assistant('a', 'old')
    const b = assistant(mode === 'duplicate-row' ? 'a' : 'b', mode === 'same-turn' ? 'old' : 'new')
    const tool = result('result', mode === 'omitted-turn' ? 'unused' : 'old')

    if (mode === 'omitted-turn') {
      delete tool.turn_id
    }

    hydrate([a, b, tool])
    expect(calls()).toMatchObject([{ messageId: undefined, args: null }])
  }
)

it('uses the explicit enclosing result as nested parent even when the ID spelling disagrees', () => {
  const row = {
    ...result('result', 'run', 'parent'),
    nested_calls: {
      calls: [{ id: 'unrelated/path', name: 'memory', arguments: { action: 'read' }, status: 'ok' }]
    }
  }

  hydrate([assistant('a', 'run', 'parent'), row])
  expect(calls()[1]).toMatchObject({
    parentToolCallId: 'parent',
    messageId: 'a',
    toolId: 'unrelated/path'
  })
})

it('uses explicit parent provenance on a separate nested result instead of a colliding top-level declaration', () => {
  hydrate([
    assistant('a', 'run', 'child'),
    assistant('b', 'run', 'parent'),
    { ...result('nested', 'run', 'child'), parent_tool_call_id: 'parent', args: { action: 'read' } }
  ])
  expect(calls()).toMatchObject([
    { toolId: 'child', parentToolCallId: 'parent', messageId: 'b', args: { action: 'read' } }
  ])
})

it('does not donate omitted-source live metadata to a proven durable occurrence', () => {
  event('tool.start', { tool_id: 'same', name: 'unproven', args: { source: 'unproven' } })
  event('tool.complete', { tool_id: 'same', result_text: 'unproven' })
  event('message.complete')
  hydrate([assistant('a'), result('stored-result')])
  expect(calls()).toMatchObject([
    { name: 'memory', messageId: 'a', args: { source: 'a' }, result: 'stored-result' }
  ])
})

it('keeps duplicate durable results from receiving one live occurrence twice', () => {
  start()
  event('tool.complete', { message_id: 'a', tool_id: 'same', result_text: 'live-result' })
  event('message.complete')
  hydrate([assistant('a'), result('first'), result('second')])
  expect(calls().map(call => call.result)).toEqual(['first', 'second'])
})

it('does not promote a live source through repeated durable fragment IDs in one folded bubble', () => {
  start()
  event('tool.complete', { message_id: 'a', tool_id: 'same', result_text: 'live-result' })
  event('message.complete')
  hydrate([
    assistant('a'),
    result('stored-result'),
    { role: 'assistant', row_id: 'a', turn_id: 'run', text: 'Repeated source' }
  ])
  expect(calls()).toMatchObject([{ messageId: undefined, result: 'stored-result', args: null }])
  event('tool.start', { message_id: 'a', turn_id: 'run', tool_id: 'another', name: 'unproven' })
  event('tool.complete', {
    message_id: 'a',
    turn_id: 'run',
    tool_id: 'same',
    args: { source: 'unproven' },
    result_text: 'unproven'
  })
  expect(calls()).toMatchObject([{ messageId: undefined, result: 'stored-result', args: null }])
})

it('does not let a delayed old completion claim a newer unbound tool after a card', () => {
  start('a', 'old', 'old-tool')
  event('message.complete', { turn_id: 'old' })
  event('message.start', { turn_id: 'new' })
  event('approval.request', { request_id: 'approval', command: 'Inspect memory' })
  event('tool.start', { tool_id: 'current-only', name: 'memory', args: { source: 'current' } })
  const streaming = state().streamingMessageId
  event('tool.complete', {
    turn_id: 'old',
    tool_id: 'current-only',
    args: { source: 'old' },
    result_text: 'old'
  })
  expect(calls().at(-1)).toMatchObject({
    toolId: 'current-only',
    args: { source: 'current' },
    result: null,
    status: 'running'
  })
  expect(state()).toMatchObject({
    activeTurnId: 'new',
    turnActive: true,
    streamingMessageId: streaming
  })
})

it('retains separate live metadata for same-ID top-level calls in proven turns through hydration and reopen', () => {
  start('a', 'old')
  event('tool.complete', {
    turn_id: 'old',
    message_id: 'a',
    tool_id: 'same',
    result_text: 'a-result',
    duration_s: 1,
    summary: 'First call'
  })
  event('message.complete', { turn_id: 'old' })
  start('b', 'new')
  event('tool.complete', {
    turn_id: 'new',
    message_id: 'b',
    tool_id: 'same',
    result_text: 'b-result',
    duration_s: 2,
    summary: 'Second call'
  })

  const rows = [
    assistant('a', 'old'),
    { ...result('result-a', 'old'), text: 'a-result' },
    assistant('b', 'new'),
    { ...result('result-b', 'new'), text: 'b-result' }
  ]

  for (let read = 0; read < 3; read++) {
    hydrate(rows)
    expect(calls()).toMatchObject([
      {
        messageId: 'a',
        args: { source: 'a' },
        result: 'a-result',
        durationS: 1,
        summary: 'First call'
      },
      {
        messageId: 'b',
        args: { source: 'b' },
        result: 'b-result',
        durationS: 2,
        summary: 'Second call'
      }
    ])
    expect(state().messages.filter(message => message.streaming)).toHaveLength(1)
  }
})

it('keeps a reconnect completion in another proven fragment separate from an earlier top-level call', () => {
  start('a')
  event('tool.complete', {
    message_id: 'b',
    turn_id: 'run',
    tool_id: 'same',
    name: 'other',
    args: { source: 'b' },
    result_text: 'b-result'
  })
  expect(calls()).toMatchObject([
    { messageId: 'a', args: { source: 'a' }, result: null, status: 'running' },
    { messageId: 'b', args: { source: 'b' }, result: 'b-result', status: 'ok' }
  ])
  hydrate([{ role: 'assistant', row_id: 'a', turn_id: 'run', text: 'a' }, result('unbound')])
  expect(calls().filter(call => call.messageId)).toMatchObject([
    { messageId: 'a', args: { source: 'a' }, result: null },
    { messageId: 'b', args: { source: 'b' }, result: 'b-result' }
  ])
  expect(calls().filter(call => !call.messageId)).toMatchObject([{ args: null, result: 'unbound' }])
})
