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

const hydrate = (rows: HistoryRow[], busy = false) =>
  useTranscripts.getState().open('s', 'chat', messagesFromHistory(rows, { busy }), { reports: [] })

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

it('deduplicates reused call_0 asks by occurrenceId while preserving stored fragment owners on mid-turn reopen', () => {
  event('message.start', { turn_id: 'run' })
  event('tool.start', {
    message_id: 'a1',
    turn_id: 'run',
    occurrence_id: 'occ-1',
    tool_id: 'call_0',
    name: 'message_bot',
    context: 'biology',
    args: { to: 'biology', wait: true }
  })
  event('tool.complete', {
    message_id: 'a1',
    turn_id: 'run',
    occurrence_id: 'occ-1',
    tool_id: 'call_0',
    name: 'message_bot',
    context: 'biology',
    result: { details: { reply: 'bio', section_id: 'th-bio' } }
  })
  // After call_0 is reused across fragments, daemon omits message_id on live events.
  event('tool.start', {
    turn_id: 'run',
    occurrence_id: 'occ-2',
    tool_id: 'call_0',
    name: 'message_bot',
    context: 'chemistry',
    args: { to: 'chemistry', wait: true }
  })
  event('tool.complete', {
    turn_id: 'run',
    occurrence_id: 'occ-2',
    tool_id: 'call_0',
    name: 'message_bot',
    context: 'chemistry',
    result: { details: { reply: 'chem', section_id: 'th-chem' } }
  })
  event('tool.start', {
    turn_id: 'run',
    occurrence_id: 'occ-3',
    tool_id: 'call_0',
    name: 'message_bot',
    context: 'physics',
    args: { to: 'physics', wait: true }
  })

  const rows: HistoryRow[] = [
    {
      role: 'assistant',
      row_id: 'a1',
      turn_id: 'run',
      text: '',
      tool_calls: [
        {
          id: 'call_0',
          occurrence_id: 'occ-1',
          function: { name: 'message_bot', arguments: '{"to":"biology","wait":true}' }
        }
      ]
    },
    {
      role: 'tool',
      row_id: 't1',
      turn_id: 'run',
      tool_call_id: 'call_0',
      occurrence_id: 'occ-1',
      name: 'message_bot',
      context: 'biology',
      text: '{"reply":"bio","section_id":"th-bio"}'
    },
    {
      role: 'assistant',
      row_id: 'a2',
      turn_id: 'run',
      text: '',
      tool_calls: [
        {
          id: 'call_0',
          occurrence_id: 'occ-2',
          function: { name: 'message_bot', arguments: '{"to":"chemistry","wait":true}' }
        }
      ]
    },
    {
      role: 'tool',
      row_id: 't2',
      turn_id: 'run',
      tool_call_id: 'call_0',
      occurrence_id: 'occ-2',
      name: 'message_bot',
      context: 'chemistry',
      text: '{"reply":"chem","section_id":"th-chem"}'
    },
    {
      role: 'assistant',
      row_id: 'a3',
      turn_id: 'run',
      text: '',
      tool_calls: [
        {
          id: 'call_0',
          occurrence_id: 'occ-3',
          function: { name: 'message_bot', arguments: '{"to":"physics","wait":true}' }
        }
      ]
    }
  ]

  // Busy reopen synthesizes the pending running declaration on `a3` AND retains all 3 owners.
  useTranscripts
    .getState()
    .open('s', 'chat', messagesFromHistory(rows, { busy: true }), { reports: [] })

  expect(
    calls().map(call => ({
      messageId: call.messageId,
      occurrenceId: call.occurrenceId,
      status: call.status,
      to: (call.args as { to?: string } | null)?.to
    }))
  ).toEqual([
    { messageId: 'a1', occurrenceId: 'occ-1', status: 'ok', to: 'biology' },
    { messageId: 'a2', occurrenceId: 'occ-2', status: 'ok', to: 'chemistry' },
    { messageId: 'a3', occurrenceId: 'occ-3', status: 'running', to: 'physics' }
  ])

  // Even without a synthesized pending declaration, Chemistry stays ahead of Physics.
  hydrate(rows)
  expect(
    calls().map(call => ({
      occurrenceId: call.occurrenceId,
      status: call.status,
      to: (call.args as { to?: string } | null)?.to
    }))
  ).toEqual([
    { occurrenceId: 'occ-1', status: 'ok', to: 'biology' },
    { occurrenceId: 'occ-2', status: 'ok', to: 'chemistry' },
    { occurrenceId: 'occ-3', status: 'running', to: 'physics' }
  ])
})

it('scopes tool occurrences and history owners by tool name when distinct tools share call_0', () => {
  // Fragment a1 uses call_0 for read_file; fragment a2 declares message_bot (occ-ask) and
  // web_search (no occurrence_id) both on call_0, plus hexbot_share_file sharing call_0.
  event('message.start', { turn_id: 'run' })
  event('tool.start', {
    message_id: 'a1',
    turn_id: 'run',
    tool_id: 'call_0',
    name: 'read_file',
    args: { path: 'a.txt' }
  })
  event('tool.complete', {
    message_id: 'a1',
    turn_id: 'run',
    tool_id: 'call_0',
    name: 'read_file',
    result_text: 'contents'
  })
  // Later fragment live events omit message_id because call_0 was reused in this turn.
  event('tool.start', {
    turn_id: 'run',
    tool_id: 'call_0',
    occurrence_id: 'occ-ask',
    name: 'message_bot',
    args: { to: 'biology', text: 'Check' }
  })
  event('tool.complete', {
    turn_id: 'run',
    tool_id: 'call_0',
    occurrence_id: 'occ-ask',
    name: 'message_bot',
    result: { details: { reply: 'ok', section_id: 'th-bio' } }
  })
  event('tool.start', {
    turn_id: 'run',
    tool_id: 'call_0',
    name: 'web_search',
    args: { query: 'mitosis' }
  })
  event('tool.complete', {
    turn_id: 'run',
    tool_id: 'call_0',
    name: 'web_search',
    result_text: 'hits'
  })

  const rows: HistoryRow[] = [
    {
      role: 'assistant',
      row_id: 'a1',
      turn_id: 'run',
      text: 'Reading.',
      tool_calls: [{ id: 'call_0', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }]
    },
    {
      role: 'tool',
      row_id: 't1',
      turn_id: 'run',
      tool_call_id: 'call_0',
      name: 'read_file',
      text: 'contents'
    },
    {
      role: 'assistant',
      row_id: 'a2',
      turn_id: 'run',
      text: 'Checking.',
      tool_calls: [
        {
          id: 'call_0',
          occurrence_id: 'occ-ask',
          function: { name: 'message_bot', arguments: '{"to":"biology","text":"Check"}' }
        },
        {
          id: 'call_0',
          function: { name: 'web_search', arguments: '{"query":"mitosis"}' }
        }
      ]
    },
    {
      role: 'tool',
      row_id: 't2',
      turn_id: 'run',
      tool_call_id: 'call_0',
      occurrence_id: 'occ-ask',
      name: 'message_bot',
      context: 'biology',
      text: '{"reply":"ok","section_id":"th-bio"}'
    },
    {
      role: 'tool',
      row_id: 't3',
      turn_id: 'run',
      tool_call_id: 'call_0',
      name: 'web_search',
      context: 'mitosis',
      text: 'hits'
    }
  ]

  hydrate(rows)
  expect(calls().map(call => call.name)).toEqual(['read_file', 'message_bot', 'web_search'])
  expect(calls()[2]).toMatchObject({
    args: { query: 'mitosis' },
    messageId: 'a2',
    name: 'web_search'
  })

  // A shared file whose call_0 collides with message_bot still restores its `path` argument.
  const sharedHistory = messagesFromHistory([
    {
      role: 'assistant',
      row_id: 'a-share',
      turn_id: 'T-share',
      text: 'Here is the report.',
      tool_calls: [
        {
          id: 'call_0',
          occurrence_id: 'occ-ask-share',
          function: { name: 'message_bot', arguments: '{"to":"fox","text":"Review"}' }
        },
        {
          id: 'call_0',
          function: { name: 'hexbot_share_file', arguments: '{"path":"/work/report.pdf"}' }
        }
      ]
    },
    {
      role: 'tool',
      row_id: 't-share-1',
      turn_id: 'T-share',
      tool_call_id: 'call_0',
      occurrence_id: 'occ-ask-share',
      name: 'message_bot',
      text: '{"reply":"Reviewed","section_id":"th-fox"}'
    },
    {
      role: 'tool',
      row_id: 't-share-2',
      turn_id: 'T-share',
      tool_call_id: 'call_0',
      name: 'hexbot_share_file',
      text: '{"shared":true}'
    }
  ])

  const shareCall = sharedHistory
    .flatMap(message => message.toolCalls)
    .find(call => call.name === 'hexbot_share_file')

  expect(shareCall).toMatchObject({
    args: { path: '/work/report.pdf' },
    messageId: 'a-share',
    name: 'hexbot_share_file'
  })
})

it('keeps earlier turn nested asks intact and retains running sibling tools during partial hydration', () => {
  // 1. Cross-turn nested ask reusing call_0/1 under call_0 must never pull turn 1 onto turn 2.
  const crossTurnRows: HistoryRow[] = [
    { role: 'user', row_id: 'u1', text: 'First question' },
    {
      role: 'assistant',
      row_id: 'a1',
      turn_id: 'T1',
      text: 'Turn 1 answer.',
      tool_calls: [{ id: 'call_0', function: { name: 'codemode', arguments: '{"code":"1"}' } }]
    },
    {
      role: 'tool',
      row_id: 't1',
      turn_id: 'T1',
      tool_call_id: 'call_0',
      name: 'codemode',
      text: 'ok',
      nested_calls: {
        calls: [
          {
            id: 'call_0/1',
            name: 'message_bot',
            arguments: { to: 'fox', text: 'Ask fox' },
            status: 'ok',
            section_id: 'th-fox',
            result: { reply: 'Fox ok', section_id: 'th-fox' }
          }
        ]
      }
    },
    { role: 'user', row_id: 'u2', text: 'Second question' }
  ]

  event('message.start', { turn_id: 'T2' })
  event('tool.start', {
    message_id: 'a2',
    turn_id: 'T2',
    tool_id: 'call_0',
    occurrence_id: 'p2',
    name: 'codemode',
    args: { code: '2' }
  })
  event('tool.start', {
    turn_id: 'T2',
    parent_tool_call_id: 'call_0',
    tool_id: 'call_0/1',
    name: 'message_bot',
    context: 'owl',
    args: { to: 'owl', text: 'Ask owl' }
  })
  hydrate(crossTurnRows)
  const msgs = state().messages
  expect(msgs.some(m => m.text === 'Turn 1 answer.')).toBe(true)
  expect(msgs.findIndex(m => m.text === 'Turn 1 answer.')).toBeLessThan(
    msgs.findIndex(m => m.text === 'Second question')
  )

  const owlAsk = msgs
    .flatMap(m => m.toolCalls)
    .find(c => c.name === 'message_bot' && (c.args as { to?: string } | null)?.to === 'owl')

  expect(owlAsk).toMatchObject({ parentToolCallId: 'call_0', status: 'running', toolId: 'call_0/1' })

  // 2. Partial history read containing only message_bot on a1 must not drop running web_search siblings on call_0.
  useTranscripts.setState({ bySession: {} })
  event('message.start', { turn_id: 'T-part' })
  event('tool.start', {
    message_id: 'a1',
    turn_id: 'T-part',
    tool_id: 'call_0',
    occurrence_id: 'occ-bio',
    name: 'message_bot',
    context: 'biology',
    args: { to: 'biology', text: 'Hi' }
  })
  event('tool.complete', {
    message_id: 'a1',
    turn_id: 'T-part',
    tool_id: 'call_0',
    occurrence_id: 'occ-bio',
    name: 'message_bot',
    context: 'biology',
    result: { details: { reply: 'ok', section_id: 'th-bio' } }
  })
  event('tool.start', {
    message_id: 'a1',
    turn_id: 'T-part',
    tool_id: 'call_0',
    name: 'web_search',
    context: 'meiosis',
    args: { query: 'meiosis' }
  })
  event('tool.start', {
    message_id: 'a1',
    turn_id: 'T-part',
    tool_id: 'call_0',
    name: 'web_search',
    context: 'cytokinesis',
    args: { query: 'cytokinesis' }
  })
  hydrate([
    {
      role: 'assistant',
      row_id: 'a1',
      turn_id: 'T-part',
      text: 'Working.',
      tool_calls: [
        {
          id: 'call_0',
          occurrence_id: 'occ-bio',
          function: { name: 'message_bot', arguments: '{"to":"biology","text":"Hi"}' }
        },
        { id: 'call_0', function: { name: 'web_search', arguments: '{"query":"meiosis"}' } },
        { id: 'call_0', function: { name: 'web_search', arguments: '{"query":"cytokinesis"}' } }
      ]
    },
    {
      role: 'tool',
      row_id: 't1',
      turn_id: 'T-part',
      tool_call_id: 'call_0',
      occurrence_id: 'occ-bio',
      name: 'message_bot',
      context: 'biology',
      text: '{"reply":"ok","section_id":"th-bio"}'
    }
  ])
  expect(calls().map(c => [c.name, c.status])).toEqual([
    ['message_bot', 'ok'],
    ['web_search', 'running'],
    ['web_search', 'running']
  ])
})

it('never mixes incompatible asks or tool names during hydration, preserves settled untagged asks, keeps failed nested section_id, and never turns ambiguous tool failures into ok', () => {
  // 1. Two untagged message_bot calls sharing call_0 in one fragment: Owl's stored reply must
  //    never merge Fox's live arguments onto Owl's thread.
  useTranscripts.setState({ bySession: {} })
  event('message.start', { turn_id: 'T-mix' })
  event('tool.start', {
    message_id: 'a-mix',
    turn_id: 'T-mix',
    tool_id: 'call_0',
    name: 'message_bot',
    context: 'fox',
    args: { to: 'fox', text: 'Ask fox' }
  })
  hydrate([
    {
      role: 'assistant',
      row_id: 'a-mix',
      turn_id: 'T-mix',
      text: '',
      tool_calls: [
        { id: 'call_0', function: { name: 'message_bot', arguments: '{"to":"owl","text":"Ask owl"}' } }
      ]
    },
    {
      role: 'tool',
      row_id: 't-owl',
      turn_id: 'T-mix',
      tool_call_id: 'call_0',
      name: 'message_bot',
      context: 'owl',
      text: '{"reply":"Owl done","section_id":"owl-thread"}'
    }
  ])
  const mixCalls = calls()
  expect(mixCalls).toHaveLength(2)
  expect(mixCalls.find(c => (c.args as { to?: string } | null)?.to === 'owl')).toMatchObject({
    status: 'ok',
    summary: 'owl'
  })
  expect(mixCalls.find(c => (c.args as { to?: string } | null)?.to === 'fox')).toMatchObject({
    status: 'running',
    result: null
  })

  // 2. Settled message_bot to fox must never adopt a live web_search("mitosis")'s args/summary.
  useTranscripts.setState({ bySession: {} })
  event('message.start', { turn_id: 'T-cross' })
  event('tool.start', {
    message_id: 'a-cross',
    turn_id: 'T-cross',
    tool_id: 'call_0',
    name: 'web_search',
    context: 'mitosis',
    args: { query: 'mitosis' }
  })
  hydrate([
    {
      role: 'assistant',
      row_id: 'a-cross',
      turn_id: 'T-cross',
      text: '',
      tool_calls: [
        {
          id: 'call_0',
          occurrence_id: 'occ-fox',
          function: { name: 'message_bot', arguments: '{"to":"fox","text":"Ask fox"}' }
        }
      ]
    },
    {
      role: 'tool',
      row_id: 't-cross',
      turn_id: 'T-cross',
      tool_call_id: 'call_0',
      occurrence_id: 'occ-fox',
      name: 'message_bot',
      context: 'fox',
      text: '{"reply":"Fox ok","section_id":"fox-thread"}'
    }
  ])
  const foxCross = calls().find(c => c.name === 'message_bot')
  expect(foxCross).toMatchObject({
    args: { to: 'fox', text: 'Ask fox' },
    status: 'ok',
    summary: 'fox'
  })

  // 3. Late busy history containing a running declaration must never revert a settled untagged ask.
  useTranscripts.setState({ bySession: {} })
  event('message.start', { turn_id: 'T-late' })
  event('tool.start', {
    turn_id: 'T-late',
    tool_id: 'call_0',
    name: 'message_bot',
    context: 'fox',
    args: { to: 'fox', text: 'Need help' }
  })
  event('tool.complete', {
    turn_id: 'T-late',
    tool_id: 'call_0',
    name: 'message_bot',
    context: 'fox',
    args: { to: 'fox', text: 'Need help' },
    result: { details: { reply: 'Here it is', section_id: 'th-late' } }
  })
  hydrate(
    [
      {
        role: 'assistant',
        row_id: 'a-late',
        turn_id: 'T-late',
        text: '',
        tool_calls: [
          {
            id: 'call_0',
            function: { name: 'message_bot', arguments: '{"to":"fox","text":"Need help"}' }
          }
        ]
      }
    ],
    true
  )
  expect(calls()).toMatchObject([
    {
      messageId: 'a-late',
      name: 'message_bot',
      result: { details: { reply: 'Here it is', section_id: 'th-late' } },
      status: 'ok',
      toolId: 'call_0'
    }
  ])

  // 4. Failed nested ask retains its exact persisted section_id alongside its error message.
  const failedNested = messagesFromHistory([
    {
      role: 'assistant',
      row_id: 'a-fn',
      turn_id: 'T-fn',
      text: '',
      tool_calls: [{ id: 'code_1', occurrence_id: 'occ-c1', function: { name: 'codemode', arguments: '{}' } }]
    },
    {
      role: 'tool',
      row_id: 't-fn',
      turn_id: 'T-fn',
      tool_call_id: 'code_1',
      occurrence_id: 'occ-c1',
      name: 'codemode',
      text: 'done',
      nested_calls: {
        calls: [
          {
            id: 'code_1/1',
            name: 'message_bot',
            arguments: { to: 'fox', text: 'Check' },
            status: 'error',
            error: 'Peer timed out',
            section_id: 'th-old-fox'
          }
        ]
      }
    }
  ])

  const failedAskCall = failedNested.flatMap(m => m.toolCalls).find(c => c.name === 'message_bot')
  expect(failedAskCall).toMatchObject({
    parentOccurrenceId: 'occ-c1',
    result: { error: 'Peer timed out', section_id: 'th-old-fox' },
    status: 'error'
  })

  // 5. Two parallel web_search calls sharing call_0 with one error and one ok completion (empty
  //    daemon context) settle to `unresolved` (neither falsely `ok` nor blaming both as `error`)
  //    while carrying the 1-failed / 1-ok summary until history reconciles; all-failed settles to
  //    `error` and all-ok settles to `ok`.
  useTranscripts.setState({ bySession: {} })
  event('message.start', { turn_id: 'T-ambig' })
  event('tool.start', {
    message_id: 'a-ambig',
    turn_id: 'T-ambig',
    tool_id: 'call_0',
    name: 'web_search',
    context: 'meiosis',
    args: { query: 'meiosis' }
  })
  event('tool.start', {
    message_id: 'a-ambig',
    turn_id: 'T-ambig',
    tool_id: 'call_0',
    name: 'web_search',
    context: 'cytokinesis',
    args: { query: 'cytokinesis' }
  })
  event('tool.complete', {
    message_id: 'a-ambig',
    turn_id: 'T-ambig',
    tool_id: 'call_0',
    name: 'web_search',
    context: '',
    result: { error: 'Search timed out' },
    result_text: 'Search timed out'
  })
  event('tool.complete', {
    message_id: 'a-ambig',
    turn_id: 'T-ambig',
    tool_id: 'call_0',
    name: 'web_search',
    context: '',
    result: { content: [{ text: 'ok' }] },
    result_text: 'ok'
  })
  event('message.complete', { text: 'Answered with partial search.' })
  expect(calls().map(c => c.status)).toEqual(['unresolved', 'unresolved'])
  expect(calls()[0]!.result).toMatchObject({
    error: { error: 'Search timed out' },
    failed: 1,
    ok: 1,
    unresolved: true
  })

  // History reload cleanly reconciles exact per-declaration outcomes.
  hydrate([
    {
      role: 'assistant',
      row_id: 'a-ambig',
      turn_id: 'T-ambig',
      text: 'Answered with partial search.',
      tool_calls: [
        { id: 'call_0', function: { name: 'web_search', arguments: '{"query":"meiosis"}' } },
        { id: 'call_0', function: { name: 'web_search', arguments: '{"query":"cytokinesis"}' } }
      ]
    },
    {
      role: 'tool',
      row_id: 't-ambig-1',
      turn_id: 'T-ambig',
      tool_call_id: 'call_0',
      name: 'web_search',
      is_error: true,
      text: 'Search timed out'
    },
    {
      role: 'tool',
      row_id: 't-ambig-2',
      turn_id: 'T-ambig',
      tool_call_id: 'call_0',
      name: 'web_search',
      is_error: false,
      text: 'ok'
    }
  ])
  expect(calls().map(c => c.status)).toEqual(['error', 'ok'])

  // 6. Running, settled ok, and failed direct asks in a busy snapshot without declarations yet
  //    are all preserved after the latest user message, and a T2 ask never attaches to T1's reply.
  for (const status of ['running', 'ok', 'error'] as const) {
    const laggedDirect = messagesFromHistory(
      [
        { role: 'user', row_id: 'u-old', text: 'Earlier' },
        { role: 'assistant', row_id: 'a-old', turn_id: 'T-old', text: 'Earlier answer.' },
        { role: 'user', row_id: 'u-new', text: 'Ask biology' }
      ],
      {
        asks: [
          {
            args: { to: 'biology', text: 'Check cells', wait: status !== 'ok' },
            context: 'biology',
            occurrence_id: `occ-lag-${status}`,
            ...(status === 'ok'
              ? { result: { section_id: 'th-lag', status: 'sent' } }
              : status === 'error'
                ? { result: { error: 'Peer failed', section_id: 'th-lag' } }
                : {}),
            section_id: 'th-lag',
            status,
            tool_id: 'call_0',
            turn_id: 'T-new'
          }
        ],
        busy: true
      }
    )

    expect(laggedDirect.at(-2)?.role).toBe('user')
    expect(laggedDirect.at(-1)?.role).toBe('assistant')
    expect(laggedDirect.at(-1)?.toolCalls).toMatchObject([
      {
        name: 'message_bot',
        occurrenceId: `occ-lag-${status}`,
        status,
        summary: 'biology',
        toolId: 'call_0'
      }
    ])
  }

  // Turn T2 starting after history ended at T1's reply must create a new T2 bubble, NOT attach to T1.
  const crossTurnLag = messagesFromHistory(
    [
      { role: 'user', row_id: 'u-t1', text: 'First' },
      { role: 'assistant', row_id: 'a-t1', turn_id: 'T1', text: 'First reply.' }
    ],
    {
      asks: [
        {
          args: { to: 'biology', text: 'Second turn' },
          context: 'biology',
          section_id: 'th-t2',
          status: 'running',
          tool_id: 'call_0',
          turn_id: 'T2'
        }
      ],
      busy: true
    }
  )

  expect(crossTurnLag.find(m => m.id === 'a-t1')?.toolCalls).toEqual([])
  expect(crossTurnLag.at(-1)).toMatchObject({
    role: 'assistant',
    turnId: 'T2'
  })
  expect(crossTurnLag.at(-1)?.toolCalls).toMatchObject([
    { name: 'message_bot', status: 'running', summary: 'biology' }
  ])

  // Persisted nested ask consumes only its compatible snapshot entry (target/args/section),
  // keeping a sibling peer's nested ask intact instead of duplicating Chemistry.
  const partialNestedWeb = messagesFromHistory(
    [
      { role: 'user', row_id: 'u-pn', text: 'Ask both in code' },
      {
        role: 'assistant',
        row_id: 'a-pn',
        turn_id: 'T-pn',
        text: '',
        tool_calls: [{ id: 'code', function: { name: 'codemode', arguments: '{}' } }]
      },
      {
        role: 'tool',
        row_id: 't-pn',
        turn_id: 'T-pn',
        tool_call_id: 'code',
        name: 'codemode',
        text: 'chem done',
        nested_calls: {
          calls: [
            {
              id: 'code/1',
              name: 'message_bot',
              arguments: { to: 'chemistry', text: 'Check bonds', wait: true },
              status: 'ok',
              section_id: 'th-chem',
              result: { reply: 'Chem ok', section_id: 'th-chem' }
            }
          ]
        }
      }
    ],
    {
      asks: [
        {
          args: { to: 'biology', text: 'Check cells', wait: true },
          context: 'biology',
          parent_tool_call_id: 'code',
          result: { reply: 'Bio ok', section_id: 'th-bio' },
          section_id: 'th-bio',
          status: 'ok',
          tool_id: 'code/1',
          turn_id: 'T-pn'
        },
        {
          args: { to: 'chemistry', text: 'Check bonds', wait: true },
          context: 'chemistry',
          parent_tool_call_id: 'code',
          result: { reply: 'Chem ok', section_id: 'th-chem' },
          section_id: 'th-chem',
          status: 'ok',
          tool_id: 'code/1',
          turn_id: 'T-pn'
        }
      ],
      busy: true
    }
  )

  expect(
    partialNestedWeb
      .flatMap(m => m.toolCalls)
      .filter(c => c.name === 'message_bot')
      .map(c => (c.args as { to?: string } | null)?.to)
  ).toEqual(['chemistry', 'biology'])

  // 7. Failed top-level message_bot history row retains its persisted section_id.
  const failedDirect = messagesFromHistory([
    {
      role: 'assistant',
      row_id: 'a-fd',
      turn_id: 'T-fd',
      text: '',
      tool_calls: [
        {
          id: 'call_0',
          occurrence_id: 'occ-fd',
          function: { name: 'message_bot', arguments: '{"to":"fox","text":"Help"}' }
        }
      ]
    },
    {
      role: 'tool',
      row_id: 't-fd',
      turn_id: 'T-fd',
      tool_call_id: 'call_0',
      occurrence_id: 'occ-fd',
      name: 'message_bot',
      is_error: true,
      section_id: 'th-archived-fox',
      text: 'Peer failed'
    }
  ])

  expect(failedDirect.flatMap(m => m.toolCalls)).toMatchObject([
    {
      name: 'message_bot',
      result: { error: 'Peer failed', section_id: 'th-archived-fox' },
      status: 'error'
    }
  ])
})
