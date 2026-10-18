import type { GatewayEvent } from '@hermes/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useConnection } from '../stores/connection'
import { useSections } from '../stores/sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from '../stores/transcripts'

import { routeEvent } from './events'
import { setActiveRpc } from './rpc'
import type { Attachment, DaemonInfo, Section } from './types'

const section = {
  id: 'chat',
  bot: 'owl',
  title: 'Trip',
  live_session_id: 'chat',
  archived_at: null,
  message_count: 3,
  peer_bot: null
} as Section

const prior = [
  { role: 'user', row_id: 1, text: 'Previous user question' },
  { role: 'assistant', row_id: 2, text: 'Previous assistant answer' }
]

const attachment: Attachment = {
  id: 'file',
  name: 'notes.txt',
  mime: 'text/plain',
  size: 7,
  kind: 'file',
  path: '/workspace/notes.txt'
}

const user = { role: 'user', row_id: 3, text: 'Current user question' }
const report = { role: 'assistant', row_id: 4, text: 'New dream report', dream: true }
const answer = { role: 'assistant', row_id: 5, text: 'New assistant answer' }
const snapshot = (rows = [...prior, user, report]) => ({ section, messages: rows })

const barrier = <T = unknown>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void

  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

const deps = { refreshBots: () => {}, refreshSections: () => {} }

const event = (type: string, payload: Record<string, unknown> = {}) =>
  routeEvent({ type, session_id: 'chat', payload } as GatewayEvent, deps)

const reload = (value = true) =>
  routeEvent(
    {
      type: 'hexbot.sections.changed',
      payload: { id: 'chat', bot: 'owl', reload: value }
    } as GatewayEvent,
    deps
  )

const state = () => {
  const transcript = useTranscripts.getState().bySession.chat

  return {
    liveId: useSections.getState().liveSessionId.chat ?? null,
    transcript: transcript ?? null,
    texts: transcript?.messages.map(m => m.text) ?? []
  }
}

let call: ReturnType<typeof vi.fn>
let touch: string[]
beforeEach(async () => {
  useConnection.setState({
    target: { kind: 'local' },
    epoch: 'process-one',
    daemon: { one_chat: true } as DaemonInfo
  })
  useSections.setState({
    byId: { chat: section },
    idsByBot: { owl: ['chat'] },
    liveSessionId: {},
    choosing: null
  })
  useTranscripts.setState({ bySession: {} })
  touch = []
  setTranscriptEffects({
    touchSection: id => touch.push(id),
    notify: () => {},
    ackApproval: () => {}
  })
  call = vi.fn((method: string) => {
    return Promise.resolve(method === 'hexbot.sections.open' ? snapshot(prior) : {})
  })
  setActiveRpc({ call } as never)
  await useSections.getState().open('chat')
  useTranscripts.getState().appendUserMessage('chat', user.text, [attachment])
})
afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

it.each(['start-delta', 'delta-only', 'completed-before-snapshot', 'already-streaming'] as const)(
  'report reload must retain snapshot and live effects: %s',
  async mode => {
    if (mode === 'already-streaming') {
      event('message.start')
      event('message.delta', { text: 'Prefix before reload ' })
    }

    const held = barrier()
    let reads = 0
    call.mockImplementation((method: string) => {
      return method === 'hexbot.sections.open'
        ? ++reads === 1
          ? held.promise
          : Promise.resolve(snapshot([...prior, user, report, answer]))
        : Promise.resolve({})
    })
    reload()
    expect(state().texts).toContain(prior[0]!.text)
    expect(state().texts).toContain(user.text)
    const opening = useSections.getState().open('chat')
    const sameOpening = useSections.getState().open('chat')
    expect.soft(opening).toBe(sameOpening)

    if (mode !== 'delta-only' && mode !== 'already-streaming') {
      event('message.start')
    }

    event('message.delta', { text: 'New assistant ' })

    if (mode === 'start-delta') {
      event('reasoning.delta', { text: 'Reasoning during reload' })
      event('tool.start', { tool_id: 't1', name: 'read', args: { path: 'file' } })
    }

    if (mode === 'completed-before-snapshot') {
      event('message.complete', { text: answer.text })
    }

    const beforeSnapshot = state()
    held.resolve(snapshot())
    await Promise.all([opening, sameOpening])
    const afterSnapshot = state()

    if (mode !== 'completed-before-snapshot') {
      event('message.complete', { text: answer.text })
    }

    call.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'hexbot.sections.open' ? snapshot([...prior, user, report, answer]) : {}
      )
    )
    await useSections.getState().open('chat')
    const afterReopen = state()
    expect(touch).toEqual(['chat'])
    expect(reads).toBe(2)
    expect(
      afterReopen.transcript?.messages.find(m => m.role === 'user' && m.text === user.text)
        ?.attachments
    ).toEqual([attachment])
    expect(afterReopen.texts).toEqual([...prior, user, report, answer].map(m => m.text))
    expect.soft(afterSnapshot.texts).toContain(prior[0]!.text)
    expect.soft(afterSnapshot.texts).toContain(prior[1]!.text)
    expect.soft(afterSnapshot.texts).toContain(user.text)
    expect.soft(afterSnapshot.texts).toContain(report.text)

    if (mode === 'completed-before-snapshot') {
      expect.soft(afterSnapshot.texts).toContain(answer.text)
    } else {
      expect(afterSnapshot.transcript?.streamingMessageId).toBe(
        beforeSnapshot.transcript?.streamingMessageId
      )
      expect(afterSnapshot.transcript?.messages.at(-1)).toEqual(
        beforeSnapshot.transcript?.messages.at(-1)
      )
    }

    if (mode === 'already-streaming') {
      expect.soft(afterSnapshot.texts.join('')).toContain('Prefix before reload ')
    }
  }
)

it('healthy report reload without concurrent events installs the complete snapshot once', async () => {
  reload()
  call.mockImplementation((method: string) =>
    Promise.resolve(method === 'hexbot.sections.open' ? snapshot() : {})
  )
  await useSections.getState().open('chat')
  const restored = state()
  expect(restored.texts).toEqual([...prior, user, report].map(m => m.text))
  expect(restored.transcript?.streamingMessageId).toBeNull()
})

it('healthy ordinary change does not invalidate history or active stream', async () => {
  event('message.start')
  event('message.delta', { text: 'New assistant ' })
  const before = state()
  reload(false)
  const after = state()
  expect(after).toEqual(before)
  expect(after.texts).toEqual([...prior, user].map(m => m.text).concat('New assistant '))
})

it('healthy ordinary reopen preserves an active transcript that already contains its history', async () => {
  event('message.start')
  event('message.delta', { text: 'New assistant ' })
  const before = state()
  await useSections.getState().open('chat')
  const after = state()
  expect(after.texts).toEqual(before.texts)
  expect(after.transcript?.streamingMessageId).toBe(before.transcript?.streamingMessageId)
})

it.each([false, true])(
  'healthy reload generation rejects superseded snapshot, stale failure=%s',
  async fails => {
    const first = barrier()
    const second = barrier()
    const secondCalled = barrier<void>()
    let reads = 0
    call.mockImplementation((method: string) =>
      method !== 'hexbot.sections.open'
        ? Promise.resolve({})
        : ++reads === 1
          ? first.promise
          : reads === 2
            ? (secondCalled.resolve(), second.promise)
            : Promise.resolve(snapshot())
    )
    reload()
    const pending = useSections.getState().open('chat')
    const concurrent = useSections.getState().open('chat')
    reload()

    if (fails) {
      first.reject(new Error('Stale read failure'))
    } else {
      first.resolve(snapshot([{ role: 'assistant', row_id: 91, text: 'Stale snapshot one' }]))
    }

    await secondCalled.promise
    reload()
    second.resolve(snapshot([{ role: 'assistant', row_id: 92, text: 'Stale snapshot two' }]))
    await pending
    const restored = state()
    expect(pending).toBe(concurrent)
    expect(reads).toBe(3)
    expect(restored.texts).toEqual([...prior, user, report].map(m => m.text))
  }
)

it.each(['target', 'epoch'] as const)(
  'healthy %s guard rejects an old report reload response',
  async change => {
    const held = barrier()
    call.mockImplementation((method: string) =>
      method === 'hexbot.sections.open' ? held.promise : Promise.resolve({})
    )
    reload()
    const pending = useSections.getState().open('chat')
    const rejected = expect(pending).rejects.toThrow('selected daemon changed')

    if (change === 'target') {
      useConnection.setState({ target: { kind: 'local' } })
    } else {
      useConnection.setState({ epoch: 'process-two' })
    }

    held.resolve(snapshot())
    await rejected
    const after = state()
    expect(after.liveId).toBeNull()
    expect(after.texts).not.toContain(report.text)
  }
)

it('overlaps persisted interims and tool IDs while retaining reasoning and the later live tail', async () => {
  event('message.start')
  event('message.delta', { text: 'First interim' })
  event('message.interim', { text: 'First interim', already_streamed: true })
  event('message.delta', { text: 'Second interim' })
  event('message.interim', { text: 'Second interim', already_streamed: true })
  event('tool.start', { tool_id: 'read-1', name: 'read', args: { path: 'notes.txt' } })
  event('reasoning.delta', { text: 'Keep this reasoning' })
  const held = barrier()

  const interimRows = [
    ...prior,
    user,
    report,
    { role: 'assistant', row_id: 5, text: 'First interim' },
    { role: 'assistant', row_id: 6, text: 'Second interim' },
    { role: 'tool', row_id: 7, tool_id: 'read-1', name: 'read', text: 'File contents' }
  ]

  let reads = 0
  call.mockImplementation((method: string) =>
    method !== 'hexbot.sections.open'
      ? Promise.resolve({})
      : ++reads === 1
        ? held.promise
        : Promise.resolve(snapshot([...interimRows, { ...answer, row_id: 8 }]))
  )
  reload()
  const loading = useSections.getState().open('chat')
  event('tool.complete', { tool_id: 'read-1', result_text: 'File contents' })
  event('message.delta', { text: 'Later live tail' })
  held.resolve(snapshot(interimRows))
  await loading
  const live = useTranscripts.getState().bySession.chat!
  expect(live.messages.at(-1)).toMatchObject({
    parts: ['First interim', 'Second interim'],
    text: 'Later live tail',
    thinking: 'Keep this reasoning'
  })
  expect(live.messages.flatMap(m => m.toolCalls)).toMatchObject([
    { toolId: 'read-1', status: 'ok' }
  ])
  expect(live.messages.flatMap(m => [...(m.parts ?? []), m.text]).filter(Boolean)).toEqual([
    ...prior.map(m => m.text),
    user.text,
    report.text,
    'First interim',
    'Second interim',
    'Later live tail'
  ])
  event('message.complete', { text: answer.text })
  await useSections.getState().open('chat')
  const final = useTranscripts.getState().bySession.chat!
  expect(reads).toBe(2)
  expect(final.messages.flatMap(m => m.toolCalls).map(t => t.toolId)).toEqual(['read-1'])
  expect(final.messages.flatMap(m => [...(m.parts ?? []), m.text]).filter(Boolean)).toEqual([
    ...prior.map(m => m.text),
    user.text,
    report.text,
    'First interim',
    'Second interim',
    answer.text
  ])
  expect(final.messages.find(m => m.toolCalls.length)?.thinking).toBe('Keep this reasoning')
  expect(final.messages.find(m => m.id === '3')?.attachments).toEqual([attachment])
})

it('keeps repeated equal text as distinct history rows, interims and turns', async () => {
  const old = [
    { role: 'user', row_id: 11, text: 'Same' },
    { role: 'assistant', row_id: 12, text: 'Same' }
  ]

  useTranscripts.setState({ bySession: {} })
  call.mockResolvedValue(snapshot(old))
  await useSections.getState().open('chat')
  useTranscripts.getState().appendUserMessage('chat', 'Same')
  event('message.start')
  event('message.interim', { text: 'Same' })
  event('message.interim', { text: 'Same' })

  const rows = [
    ...old,
    { role: 'user', row_id: 13, text: 'Same' },
    { role: 'assistant', row_id: 14, text: 'Same', dream: true },
    { role: 'assistant', row_id: 15, text: 'Same' },
    { role: 'assistant', row_id: 16, text: 'Same' }
  ]

  const held = barrier()
  let reads = 0
  call.mockImplementation((method: string) =>
    method !== 'hexbot.sections.open'
      ? Promise.resolve({})
      : ++reads === 1
        ? held.promise
        : Promise.resolve(snapshot([...rows, { role: 'assistant', row_id: 17, text: 'Same' }]))
  )
  reload()
  const loading = useSections.getState().open('chat')
  event('message.delta', { text: 'Same' })
  held.resolve(snapshot(rows))
  await loading
  expect(
    useTranscripts.getState().bySession.chat!.messages.flatMap(m => [...(m.parts ?? []), m.text])
  ).toEqual(Array(7).fill('Same'))
  event('message.complete', { text: 'Same' })
  await useSections.getState().open('chat')
  expect(state().texts).toEqual(Array(7).fill('Same'))
  expect(useTranscripts.getState().bySession.chat!.messages.map(m => m.id)).toEqual([
    '11',
    '12',
    '13',
    '14',
    '15',
    '16',
    '17'
  ])
})

it('retains an optimistic user and attachment absent from the snapshot, then binds the durable user once', async () => {
  const held = barrier()
  let reads = 0
  call.mockImplementation((method: string) =>
    method !== 'hexbot.sections.open'
      ? Promise.resolve({})
      : ++reads === 1
        ? held.promise
        : Promise.resolve(snapshot([...prior, report, user, answer]))
  )
  reload()
  const loading = useSections.getState().open('chat')
  event('message.delta', { text: 'Live' })
  held.resolve(snapshot([...prior, report]))
  await loading
  expect(state().texts).toEqual([...prior.map(m => m.text), report.text, user.text, 'Live'])
  expect(useTranscripts.getState().bySession.chat!.messages.at(-2)?.attachments).toEqual([
    attachment
  ])
  event('message.complete', { text: answer.text })
  await useSections.getState().open('chat')
  expect(state().texts).toEqual([...prior, report, user, answer].map(m => m.text))
  expect(
    useTranscripts.getState().bySession.chat!.messages.find(m => m.id === '3')?.attachments
  ).toEqual([attachment])
})

it('preserves cards splitting a live turn and refreshes a terminal error', async () => {
  event('message.start')
  event('message.delta', { text: 'Before approval' })
  event('tool.start', { tool_id: 'terminal-1', name: 'terminal' })
  event('approval.request', { request_id: 'approve-1', command: 'pwd' })
  event('status.update', { kind: 'checking', text: 'Checking this step' })
  const held = barrier()
  let reads = 0

  const rows = [
    ...prior,
    user,
    report,
    { role: 'assistant', row_id: 5, text: 'Before approval' },
    { role: 'tool', row_id: 6, tool_id: 'terminal-1', name: 'terminal', text: 'Workspace' }
  ]

  call.mockImplementation((method: string) =>
    method !== 'hexbot.sections.open'
      ? Promise.resolve({})
      : ++reads === 1
        ? held.promise
        : Promise.resolve(snapshot(rows))
  )
  reload()
  const loading = useSections.getState().open('chat')
  event('message.delta', { text: 'After approval' })
  event('clarify.request', { request_id: 'clarify-1', question: 'Proceed?' })
  held.resolve(snapshot(rows))
  await loading
  const restored = useTranscripts.getState().bySession.chat!
  expect(restored.approvals.map(a => a.requestId)).toEqual(['approve-1'])
  expect(restored.clarifies.map(c => c.requestId)).toEqual(['clarify-1'])
  expect(restored.checking).toBe('Checking this step')
  expect(restored.turnPrefix).toBe('Before approvalAfter approval')
  expect(restored.messages.flatMap(m => m.toolCalls).map(t => t.toolId)).toEqual(['terminal-1'])
  event('error', { message: 'Connection stopped' })
  await useSections.getState().open('chat')
  expect(reads).toBe(2)
  expect(
    useTranscripts.getState().bySession.chat!.messages.filter(m => m.error === 'Connection stopped')
  ).toHaveLength(1)
})

it('rejects a history response from another installation at the same target and epoch', async () => {
  useConnection.setState({ daemon: { one_chat: true, install_id: 'first' } as DaemonInfo })
  const held = barrier()
  call.mockReturnValue(held.promise)
  reload()
  const loading = useSections.getState().open('chat')
  const rejected = expect(loading).rejects.toThrow('selected daemon changed')
  useConnection.setState({ daemon: { one_chat: true, install_id: 'second' } as DaemonInfo })
  held.resolve(snapshot())
  await rejected
  expect(state().texts).not.toContain(report.text)
})

it.each(['target', 'epoch'] as const)('rejects a stale failure after changing %s', async change => {
  const held = barrier()
  call.mockReturnValue(held.promise)
  reload()
  const loading = useSections.getState().open('chat')
  const rejected = expect(loading).rejects.toThrow('Old read failed')

  if (change === 'target') {
    useConnection.setState({ target: { kind: 'local' } })
  } else {
    useConnection.setState({ epoch: 'different-process' })
  }

  held.reject(new Error('Old read failed'))
  await rejected
  expect(useSections.getState().liveSessionId.chat).toBeUndefined()
})

it('keeps a known history tool completion that arrives during the read', async () => {
  const rows = [
    ...prior,
    user,
    { role: 'assistant', row_id: 5, text: 'Checking' },
    { role: 'tool', row_id: 6, tool_id: 'known-tool', name: 'read', text: 'Original result' }
  ]

  call.mockResolvedValue(snapshot(rows))
  await useSections.getState().open('chat')
  const held = barrier()
  call.mockReturnValue(held.promise)
  reload()
  const loading = useSections.getState().open('chat')
  event('tool.complete', { tool_id: 'known-tool', result_text: 'Later result' })
  event('message.delta', { text: 'Resumed tail' })
  held.resolve(snapshot([...rows, report]))
  await loading
  expect(
    useTranscripts.getState().bySession.chat!.messages.flatMap(m => m.toolCalls)
  ).toMatchObject([{ toolId: 'known-tool', result: 'Later result' }])
  expect(state().texts).toContain(report.text)
  expect(state().texts.at(-1)).toBe('Resumed tail')
  call.mockResolvedValue(
    snapshot([...rows, { role: 'assistant', row_id: 8, text: answer.text }, report])
  )
  event('message.complete', { text: answer.text })
  await useSections.getState().open('chat')
  expect(state().texts.filter(text => text === answer.text)).toHaveLength(1)
  expect(
    useTranscripts
      .getState()
      .bySession.chat!.messages.flatMap(m => m.toolCalls)
      .map(t => t.toolId)
  ).toEqual(['known-tool'])
})

it('keeps multiple interim bubbles before a card and the later live bubble once', async () => {
  event('message.start')
  event('message.interim', { text: 'Interim one' })
  event('message.interim', { text: 'Interim two' })
  event('message.delta', { text: 'Before card' })
  event('approval.request', { request_id: 'card', command: 'pwd' })
  event('message.delta', { text: 'After card' })

  const rows = [
    ...prior,
    user,
    report,
    { role: 'assistant', row_id: 5, text: 'Interim one' },
    { role: 'assistant', row_id: 6, text: 'Interim two' },
    { role: 'assistant', row_id: 7, text: 'Before card' }
  ]

  const held = barrier()
  call.mockReturnValue(held.promise)
  reload()
  const loading = useSections.getState().open('chat')
  held.resolve(snapshot(rows))
  await loading
  expect(
    useTranscripts
      .getState()
      .bySession.chat!.messages.flatMap(m => [...(m.parts ?? []), m.text])
      .filter(Boolean)
  ).toEqual([
    ...prior.map(m => m.text),
    user.text,
    report.text,
    'Interim one',
    'Interim two',
    'Before card',
    'After card'
  ])
})
