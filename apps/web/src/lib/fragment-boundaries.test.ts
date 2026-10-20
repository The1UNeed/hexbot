import { writeFileSync } from 'node:fs'

import type { GatewayEvent } from '@hermes/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useConnection } from '../stores/connection'
import { useSections } from '../stores/sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from '../stores/transcripts'

import { messagesFromHistory } from './api'
import { routeEvent } from './events'
import { setActiveRpc } from './rpc'
import type { DaemonInfo, Section } from './types'

const section = {
  id: 'chat',
  bot: 'owl',
  live_session_id: 'chat',
  title: 'Trip',
  peer_bot: null,
  message_count: 2
} as Section

const prior = [
  { role: 'user', row_id: 'old-user', text: 'Earlier question' },
  { role: 'assistant', row_id: 'old-answer', text: 'Earlier answer' }
]

const report = { role: 'assistant', row_id: 'report', text: 'Dream report', dream: true }
const turn = 'actual-run'

const user = {
  role: 'user',
  row_id: 'user-one',
  text: 'Show the chart',
  turn_id: turn,
  input_id: undefined as string | undefined
}

const first = {
  role: 'assistant',
  row_id: 'fragment-a',
  text: 'I will show the chart.',
  turn_id: turn,
  tool_calls: [
    {
      id: 'chart-tool',
      type: 'function',
      function: {
        name: 'hexbot_show_html',
        arguments: JSON.stringify({ html: '<p>chart</p>', title: 'Chart' })
      }
    }
  ]
}

const result = {
  role: 'tool',
  row_id: 'result-row',
  tool_id: 'chart-tool',
  tool_call_id: 'chart-tool',
  name: 'hexbot_show_html',
  text: 'Shown',
  turn_id: turn
}

const second = {
  role: 'assistant',
  row_id: 'fragment-b',
  text: 'Answer after queued input',
  turn_id: turn
}

const queued = { role: 'user', row_id: 'user-two', text: 'Second queued question', turn_id: turn }
const snap = (messages: unknown[] = prior) => ({ section, messages })

const deferred = () => {
  let resolve!: (value: unknown) => void

  const promise = new Promise(yes => {
    resolve = yes
  })

  return { promise, resolve }
}

const deps = { refreshBots: () => {}, refreshSections: () => {} }

const event = (type: string, payload: Record<string, unknown> = {}) =>
  routeEvent(
    { type, session_id: 'chat', payload: { turn_id: turn, ...payload } } as GatewayEvent,
    deps
  )

const words = () =>
  useTranscripts
    .getState()
    .bySession.chat!.messages.flatMap(m => [...(m.parts ?? []), m.text])
    .filter(Boolean)

const state = () => JSON.parse(JSON.stringify(useTranscripts.getState().bySession.chat))

const save = (name: string, value: unknown) => {
  if (process.env.HEXBOT_PROBE_EVIDENCE) {
    writeFileSync(
      `${process.env.HEXBOT_PROBE_EVIDENCE}/permanent-${name}.json`,
      JSON.stringify(value, null, 2) + '\n'
    )
  }
}

let call: ReturnType<typeof vi.fn>
beforeEach(async () => {
  useConnection.setState({
    target: { kind: 'local' },
    epoch: 'fragment-epoch',
    daemon: { one_chat: true, transcript_identity: true } as DaemonInfo
  })
  useSections.setState({
    byId: { chat: section },
    idsByBot: { owl: ['chat'] },
    liveSessionId: {},
    choosing: null
  })
  useTranscripts.setState({ bySession: {} })
  setTranscriptEffects({ touchSection: () => {}, notify: () => {}, ackApproval: () => {} })
  call = vi.fn(() => Promise.resolve(snap()))
  setActiveRpc({ call } as never)
  await useSections.getState().open('chat')
  user.input_id = useTranscripts.getState().appendUserMessage('chat', user.text).inputId
})
afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

function start() {
  event('message.start')
  event('message.delta', { message_id: first.row_id, text: first.text })
  event('message.interim', { message_id: first.row_id, text: first.text, already_streamed: true })
  event('tool.start', {
    message_id: first.row_id,
    tool_id: 'chart-tool',
    name: 'hexbot_show_html',
    args: { html: '<p>chart</p>', title: 'Chart' }
  })
}

it.each([false, true])(
  'shows an identified tool once when report interposes its result=%s',
  async interposed => {
    start()

    const rows = interposed
      ? [...prior, user, first, report, result]
      : [...prior, user, report, first, result]

    const held = deferred()
    let reads = 0
    call.mockImplementation(() =>
      ++reads === 1 ? held.promise : Promise.resolve(snap([...rows, second]))
    )
    const loading = useSections.getState().open('chat')
    event('tool.complete', {
      message_id: first.row_id,
      tool_id: 'chart-tool',
      result_text: 'Shown'
    })
    event('message.delta', { message_id: second.row_id, text: second.text })
    held.resolve(snap(rows))
    await loading
    const active = state()
    event('message.complete', { message_id: second.row_id, text: second.text })
    await useSections.getState().open('chat')
    const terminal = state()
    save(`tool-report-${interposed}`, { active, terminal, reads })
    expect
      .soft(
        active.messages.flatMap((m: { toolCalls: { toolId: string }[] }) =>
          m.toolCalls.map(t => t.toolId)
        )
      )
      .toEqual(['chart-tool'])
    expect
      .soft(
        terminal.messages.flatMap((m: { toolCalls: { toolId: string }[] }) =>
          m.toolCalls.map(t => t.toolId)
        )
      )
      .toEqual(['chart-tool'])
  }
)

it.each([false, true])(
  'keeps a new identified interim after the queued user without a card, queued=%s',
  async hasQueued => {
    start()
    const rows = [...prior, user, report, first, result, ...(hasQueued ? [queued] : [])]
    const held = deferred()
    let reads = 0
    call.mockImplementation(() =>
      ++reads === 1 ? held.promise : Promise.resolve(snap([...rows, second]))
    )
    const loading = useSections.getState().open('chat')
    event('tool.complete', {
      message_id: first.row_id,
      tool_id: 'chart-tool',
      result_text: 'Shown'
    })
    event('message.delta', { message_id: second.row_id, text: second.text })
    event('message.interim', {
      message_id: second.row_id,
      text: second.text,
      already_streamed: true
    })
    held.resolve(snap(rows))
    await loading
    const active = state()
    const activeWords = words()
    event('message.complete', { message_id: second.row_id, text: second.text })
    await useSections.getState().open('chat')
    const terminal = state()
    const terminalWords = words()
    save(`queued-no-card-${hasQueued}`, { active, activeWords, terminal, terminalWords, reads })

    const expected = [
      ...prior.map(m => m.text),
      user.text,
      report.text,
      first.text,
      ...(hasQueued ? [queued.text] : []),
      second.text
    ]

    expect.soft(activeWords).toEqual(expected)
    expect.soft(terminalWords).toEqual(expected)
  }
)

it('keeps the terminal chart on its originating fragment when a report interposes the result', async () => {
  start()
  const rows = [...prior, user, first, report, result, second]
  call.mockResolvedValue(snap(rows))
  event('tool.complete', { message_id: first.row_id, tool_id: 'chart-tool', result_text: 'Shown' })
  event('message.complete', { message_id: second.row_id, text: second.text })
  await useSections.getState().open('chat')
  const messages = useTranscripts.getState().bySession.chat!.messages
  expect(messages.flatMap(message => message.toolCalls.map(tool => tool.toolId))).toEqual([
    'chart-tool'
  ])
  expect(messages.find(message => message.id === report.row_id)?.toolCalls).toEqual([])
  expect(
    messages.find(message => message.fragmentIds?.includes(first.row_id))?.toolCalls
  ).toMatchObject([
    {
      toolId: 'chart-tool',
      messageId: first.row_id,
      args: { html: '<p>chart</p>', title: 'Chart' }
    }
  ])
  expect(messages.flatMap(message => message.fragmentIds ?? [])).not.toContain(result.row_id)
})

it('keeps an unproven tool separate from an identity-free Dream report', () => {
  const messages = messagesFromHistory([
    { role: 'assistant', text: 'Dream report', dream: true },
    { role: 'tool', tool_id: 'unknown-tool', text: 'Unbound result' }
  ])

  expect(messages[0]?.toolCalls).toEqual([])
  expect(messages[1]?.toolCalls).toMatchObject([{ toolId: 'unknown-tool', messageId: undefined }])
})

it('restores nested tools and an answered question on their declared fragment across a report', () => {
  const question = {
    id: 'question-tool',
    type: 'function',
    function: { name: 'clarify', arguments: JSON.stringify({ question: 'Continue?' }) }
  }

  const messages = messagesFromHistory([
    { ...first, tool_calls: [...first.tool_calls, question] },
    report,
    {
      ...result,
      nested_calls: {
        calls: [
          {
            id: 'chart-tool/1',
            name: 'read',
            status: 'ok',
            arguments: { path: 'chart.json' },
            durationMs: 12
          }
        ]
      }
    },
    {
      role: 'tool',
      row_id: 'question-result',
      tool_call_id: 'question-tool',
      name: 'clarify',
      text: 'Yes'
    }
  ])

  expect(messages.find(message => message.id === report.row_id)?.toolCalls).toEqual([])
  const owner = messages.find(message => message.id === first.row_id)!
  expect(owner.toolCalls.map(tool => [tool.toolId, tool.messageId])).toEqual([
    ['chart-tool', first.row_id],
    ['chart-tool/1', first.row_id],
    ['question-tool', first.row_id]
  ])
  expect(owner.toolCalls[1]).toMatchObject({
    args: { path: 'chart.json' },
    durationS: 0.012,
    parentToolCallId: 'chart-tool'
  })
  expect(owner.clarifies).toMatchObject([
    { messageId: first.row_id, requestId: 'question-tool', answers: { 'question-tool': 'Yes' } }
  ])
  expect(messages.find(message => message.id === report.row_id)?.clarifies).toBeUndefined()
})

it.each([false, true])(
  'reconciles a tool result using its explicit live fragment when history lacks the declaration, start=%s',
  async hasStart => {
    event('message.start')
    event('message.delta', { message_id: first.row_id, text: first.text })
    event('message.interim', { message_id: first.row_id, text: first.text, already_streamed: true })
    const args = { html: '<p>chart</p>', title: 'Chart' }

    if (hasStart) {
      event('tool.start', {
        message_id: first.row_id,
        tool_id: 'chart-tool',
        name: 'hexbot_show_html',
        args
      })
    }

    const rows = [...prior, user, { ...first, tool_calls: [] }, report, result]
    const held = deferred()
    call.mockReturnValue(held.promise)
    const loading = useSections.getState().open('chat')
    event('tool.complete', {
      message_id: first.row_id,
      tool_id: 'chart-tool',
      name: 'hexbot_show_html',
      args,
      result_text: 'Shown'
    })
    event('message.delta', { message_id: second.row_id, text: second.text })
    held.resolve(snap(rows))
    await loading
    const active = useTranscripts.getState().bySession.chat!
    expect(active.messages.flatMap(message => message.toolCalls)).toHaveLength(1)
    expect(active.messages.find(message => message.id === report.row_id)?.toolCalls).toEqual([])
    expect(
      active.messages.find(message => message.fragmentIds?.includes(first.row_id))?.toolCalls
    ).toMatchObject([{ toolId: 'chart-tool', messageId: first.row_id, args }])
    call.mockResolvedValue(snap([...rows, second]))
    event('message.complete', { message_id: second.row_id, text: second.text })
    await useSections.getState().open('chat')
    const terminal = useTranscripts.getState().bySession.chat!
    expect(terminal.messages.flatMap(message => message.toolCalls)).toHaveLength(1)
    expect(
      terminal.messages.find(message => message.fragmentIds?.includes(first.row_id))?.toolCalls
    ).toMatchObject([{ toolId: 'chart-tool', messageId: first.row_id, args }])
  }
)

it.each(['user', 'report'] as const)(
  'keeps reasoning, tools and one continuing stream on their source side of a durable %s',
  async boundary => {
    event('message.start')
    event('message.delta', { message_id: first.row_id, text: first.text })
    event('reasoning.delta', { message_id: first.row_id, text: 'Chart reasoning' })
    event('message.interim', { message_id: first.row_id, text: first.text, already_streamed: true })
    event('tool.start', {
      message_id: first.row_id,
      tool_id: 'chart-tool',
      name: 'hexbot_show_html',
      args: { html: '<p>chart</p>', title: 'Chart' }
    })
    const streaming = useTranscripts.getState().bySession.chat!.streamingMessageId
    const divider = boundary === 'user' ? queued : report
    const rows = [...prior, user, first, result, divider]
    const held = deferred()
    call.mockReturnValue(held.promise)
    const loading = useSections.getState().open('chat')
    event('tool.complete', {
      message_id: first.row_id,
      tool_id: 'chart-tool',
      result_text: 'Shown'
    })
    event('message.delta', { message_id: second.row_id, text: second.text })
    event('reasoning.delta', { message_id: second.row_id, text: 'Queued reasoning' })
    event('message.interim', {
      message_id: second.row_id,
      text: second.text,
      already_streamed: true
    })
    held.resolve(snap(rows))
    await loading
    const active = useTranscripts.getState().bySession.chat!
    expect(words()).toEqual([
      ...prior.map(row => row.text),
      user.text,
      first.text,
      divider.text,
      second.text
    ])
    expect(active.streamingMessageId).toBe(streaming)
    expect(active.messages.filter(message => message.streaming).map(message => message.id)).toEqual(
      [streaming]
    )
    expect(
      active.messages.find(message => message.fragmentIds?.includes(first.row_id))
    ).toMatchObject({
      thinking: 'Chart reasoning',
      fragmentIds: [first.row_id],
      toolCalls: [{ toolId: 'chart-tool', messageId: first.row_id }]
    })
    expect(active.messages.find(message => message.id === streaming)).toMatchObject({
      thinking: 'Queued reasoning',
      fragmentIds: [second.row_id],
      toolCalls: []
    })
    call.mockResolvedValue(snap([...rows, second]))
    await useSections.getState().open('chat')
    const adopted = useTranscripts.getState().bySession.chat!
    expect(adopted.messages.filter(message => message.streaming)).toHaveLength(1)
    expect(words()).toEqual([
      ...prior.map(row => row.text),
      user.text,
      first.text,
      divider.text,
      second.text
    ])
    event('message.complete', { message_id: second.row_id, text: second.text })
    await useSections.getState().open('chat')
    const terminal = useTranscripts.getState().bySession.chat!
    expect(terminal.messages.filter(message => message.streaming)).toHaveLength(0)
    expect(
      terminal.messages.find(message => message.fragmentIds?.includes(first.row_id))?.thinking
    ).toBe('Chart reasoning')
    expect(
      terminal.messages.find(message => message.fragmentIds?.includes(second.row_id))?.thinking
    ).toBe('Queued reasoning')
  }
)

it.each(['user', 'report'] as const)(
  'places a new fragment at the live tail after a previously hydrated %s boundary',
  async boundary => {
    start()
    const divider = boundary === 'user' ? queued : report
    const rows = [...prior, user, first, result, divider]
    call.mockResolvedValue(snap(rows))
    await useSections.getState().open('chat')
    const before = useTranscripts.getState().bySession.chat!
    event('message.delta', { message_id: second.row_id, text: second.text })
    event('message.interim', {
      message_id: second.row_id,
      text: second.text,
      already_streamed: true
    })
    const active = useTranscripts.getState().bySession.chat!
    expect(words()).toEqual([
      ...prior.map(row => row.text),
      user.text,
      first.text,
      divider.text,
      second.text
    ])
    expect(active.messages.filter(message => message.streaming).map(message => message.id)).toEqual(
      [active.streamingMessageId]
    )
    expect(
      active.messages.find(message => message.fragmentIds?.includes(first.row_id))?.streaming
    ).toBe(false)
    expect(active.activeTurnId).toBe(before.activeTurnId)
    event('reasoning.delta', { message_id: first.row_id, text: 'Late chart reasoning' })
    event('tool.complete', {
      message_id: first.row_id,
      tool_id: 'chart-tool',
      result_text: 'Shown'
    })
    const late = useTranscripts.getState().bySession.chat!
    expect(
      late.messages.find(message => message.fragmentIds?.includes(first.row_id))?.thinking
    ).toBe('Late chart reasoning')
    expect(
      late.messages.find(message => message.fragmentIds?.includes(second.row_id))?.thinking
    ).toBeUndefined()
    expect(late.messages.filter(message => message.streaming)).toHaveLength(1)
    expect(words()).toEqual([
      ...prior.map(row => row.text),
      user.text,
      first.text,
      divider.text,
      second.text
    ])
  }
)

it.each([
  'unknown',
  'duplicate-call',
  'duplicate-row',
  'missing-arguments',
  'call-id-only'
] as const)('keeps history tool associations explicit without donating to a report, %s', mode => {
  const owner = {
    ...first,
    tool_calls:
      mode === 'unknown'
        ? []
        : mode === 'missing-arguments'
          ? [{ id: 'chart-tool' }]
          : first.tool_calls
  }

  const extra =
    mode === 'duplicate-call'
      ? [{ ...owner, row_id: 'duplicate-fragment' }]
      : mode === 'duplicate-row'
        ? [{ ...second, row_id: first.row_id }]
        : []

  const rows = [
    ...prior,
    user,
    owner,
    ...extra,
    report,
    { ...result, ...(mode === 'call-id-only' && { tool_id: undefined }) }
  ]

  const messages = messagesFromHistory(rows as Parameters<typeof messagesFromHistory>[0])
  expect(messages.find(message => message.id === report.row_id)?.toolCalls).toEqual([])
  expect(messages.flatMap(message => message.toolCalls)).toHaveLength(1)
  const tool = messages.flatMap(message => message.toolCalls)[0]!
  const proven = mode === 'missing-arguments' || mode === 'call-id-only'
  expect(tool.toolId).toBe('chart-tool')
  expect(tool.messageId).toBe(proven ? first.row_id : undefined)
  expect(messages.find(message => message.id === first.row_id)?.toolCalls).toHaveLength(
    proven ? 1 : 0
  )
  expect(messages.flatMap(message => message.fragmentIds ?? [])).not.toContain(result.row_id)
})
