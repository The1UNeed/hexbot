import { writeFileSync } from 'node:fs'

import type { GatewayEvent } from '@hermes/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useConnection } from '../stores/connection'
import { useSections } from '../stores/sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from '../stores/transcripts'

import { promptSubmit } from './api'
import { routeEvent } from './events'
import { setActiveRpc } from './rpc'
import type { Attachment, DaemonInfo, Section } from './types'

const section = {
  id: 'chat',
  bot: 'owl',
  live_session_id: 'chat',
  title: 'Trip',
  peer_bot: null,
  message_count: 2
} as Section

const prior = [
  { role: 'user', row_id: 1, text: 'Earlier owner question' },
  { role: 'assistant', row_id: 2, text: 'Earlier bot answer' }
]

const report = { role: 'assistant', row_id: 3, text: 'Dream report', dream: true }

const remote = {
  role: 'user',
  input_id: 'remote-input',
  turn_id: 'remote-run',
  row_id: 4,
  text: 'Other paired client question'
}

const remoteAnswer = {
  role: 'assistant',
  turn_id: 'remote-run',
  row_id: 5,
  text: 'Answer for other paired client'
}

let ownInput: string | undefined

const own = {
  role: 'user',
  get input_id() {
    return ownInput
  },
  turn_id: 'own-run',
  row_id: 6,
  text: 'This client question with attachment'
}

const ownAnswer = {
  role: 'assistant',
  turn_id: 'own-run',
  row_id: 7,
  text: 'Answer for this client'
}

const file = {
  id: 'own-file',
  name: 'own-private-notes.txt',
  mime: 'text/plain',
  size: 9,
  kind: 'file',
  path: '/workspace/own-private-notes.txt'
} as Attachment

const snapshot = (rows = prior) => ({ section, messages: rows })

const barrier = <T = unknown>() => {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(yes => {
    resolve = yes
  })

  return { promise, resolve }
}

const deps = { refreshBots: () => {}, refreshSections: () => {} }

const event = (type: string, payload: Record<string, unknown> = {}) =>
  routeEvent(
    {
      type,
      session_id: 'chat',
      payload: { turn_id: 'remote-run', message_id: '5', ...payload }
    } as GatewayEvent,
    deps
  )

const reload = () =>
  routeEvent(
    {
      type: 'hexbot.sections.changed',
      payload: { id: 'chat', bot: 'owl', reload: true }
    } as GatewayEvent,
    deps
  )

const state = () => JSON.parse(JSON.stringify(useTranscripts.getState().bySession.chat))

const save = (name: string, data: unknown) => {
  if (process.env.HEXBOT_PROBE_EVIDENCE) {
    writeFileSync(
      `${process.env.HEXBOT_PROBE_EVIDENCE}/identity-${name}.json`,
      JSON.stringify(data, null, 2) + '\n'
    )
  }
}

let call: ReturnType<typeof vi.fn>
beforeEach(() => {
  useConnection.setState({
    target: { kind: 'local' },
    epoch: 'identity-process',
    daemon: { one_chat: true, transcript_identity: true, install_id: 'one-install' } as DaemonInfo
  })
  useSections.setState({
    byId: { chat: section },
    idsByBot: { owl: ['chat'] },
    liveSessionId: {},
    choosing: null
  })
  useTranscripts.setState({ bySession: {} })
  setTranscriptEffects({ touchSection: () => {}, notify: () => {}, ackApproval: () => {} })
  call = vi.fn((method: string) =>
    Promise.resolve(method === 'hexbot.sections.open' ? snapshot() : {})
  )
  setActiveRpc({ call } as never)
})
afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

it.each(['loaded', 'unloaded'] as const)(
  'keeps a turn from another client after its durable user, initially %s',
  async mode => {
    if (mode === 'loaded') {
      await useSections.getState().open('chat')
    }

    const held = barrier()
    const rows = [...prior, report, remote]
    let reads = 0
    call.mockImplementation((method: string) =>
      method !== 'hexbot.sections.open'
        ? Promise.resolve({})
        : ++reads === 1
          ? held.promise
          : Promise.resolve(snapshot([...rows, remoteAnswer]))
    )
    reload()
    const loading = useSections.getState().open('chat')
    event('message.start')
    event('message.delta', { text: 'Answer for other paired client' })
    held.resolve(snapshot(rows))
    await loading
    const active = state()
    event('message.complete', { text: remoteAnswer.text })
    await useSections.getState().open('chat')
    const terminal = state()
    await useSections.getState().open('chat')
    const reopened = state()
    save(`remote-${mode}`, { active, terminal, reopened, reads })
    expect
      .soft(active.messages.map((m: { text: string }) => m.text))
      .toEqual([...rows, remoteAnswer].map(m => m.text))
    expect
      .soft(terminal.messages.map((m: { text: string }) => m.text))
      .toEqual([...rows, remoteAnswer].map(m => m.text))
    expect
      .soft(reopened.messages.map((m: { text: string }) => m.text))
      .toEqual([...rows, remoteAnswer].map(m => m.text))
    expect
      .soft(reopened.messages.filter((m: { text: string }) => m.text === remoteAnswer.text))
      .toHaveLength(1)
  }
)

it.each([
  { remoteFirst: false, same: false },
  { remoteFirst: true, same: false },
  { remoteFirst: false, same: true },
  { remoteFirst: true, same: true }
])(
  'binds a pending local attachment only to its own durable user, remote first=$remoteFirst same text=$same',
  async ({ remoteFirst, same }) => {
    const remoteRow = { ...remote, text: same ? own.text : remote.text }
    await useSections.getState().open('chat')
    ownInput = useTranscripts.getState().appendUserMessage('chat', own.text, [file]).inputId
    const submit = barrier<{ status: string; input_id?: string }>()
    const submitEntered = barrier<void>()
    const held = barrier()
    let reads = 0
    const otherRows = [...prior, report, remoteRow, remoteAnswer]
    const firstRows = remoteFirst ? otherRows : [...prior, report, own]

    const finalRows = remoteFirst
      ? [...otherRows, own, ownAnswer]
      : [...prior, report, own, ownAnswer]

    call.mockImplementation((method: string) => {
      if (method === 'prompt.submit') {
        submitEntered.resolve()

        return submit.promise
      }

      return method === 'hexbot.sections.open'
        ? ++reads === 1
          ? held.promise
          : Promise.resolve(snapshot(finalRows))
        : Promise.resolve({})
    })

    const submitting = promptSubmit('chat', own.text, {
      attachments: [file.id],
      input_id: ownInput
    })

    await submitEntered.promise
    reload()
    const loading = useSections.getState().open('chat')
    held.resolve(snapshot(firstRows))
    await loading
    const pending = state()
    submit.resolve({ status: 'submitted', input_id: ownInput })
    await submitting
    await useSections.getState().open('chat')
    const projected = state()
    save(`attachment-${remoteFirst}-${same}`, { pending, projected, calls: call.mock.calls, reads })
    expect.soft(pending.messages.some((m: { text: string }) => m.text === own.text)).toBe(true)
    expect
      .soft(
        projected.messages.find((m: { id: string }) => m.id === String(own.row_id))?.attachments
      )
      .toEqual([file])

    if (remoteFirst) {
      expect
        .soft(
          pending.messages.find((m: { id: string }) => m.id === String(remote.row_id))?.attachments
        )
        .toEqual([])
      expect
        .soft(
          projected.messages.find((m: { id: string }) => m.id === String(remote.row_id))
            ?.attachments
        )
        .toEqual([])
    }
  }
)

it.each(['hidden', 'userless', 'two-users'] as const)(
  'uses fragment identity across tool/card splits and queued input boundaries, %s',
  async mode => {
    await useSections.getState().open('chat')

    const rows = [
      ...prior,
      report,
      ...(mode === 'userless'
        ? []
        : [
            {
              role: 'user',
              row_id: 4,
              text: 'First input',
              display_kind: mode === 'hidden' ? 'hidden' : 'normal',
              turn_id: 'queued-run'
            }
          ]),
      { role: 'assistant', row_id: 5, text: 'Same', turn_id: 'queued-run' },
      {
        role: 'tool',
        row_id: 6,
        tool_id: 'queued-tool',
        name: 'read',
        text: 'Contents',
        turn_id: 'queued-run'
      },
      ...(mode === 'userless'
        ? []
        : [
            {
              role: 'user',
              row_id: 7,
              text: 'Queued input',
              display_kind: mode === 'hidden' ? 'hidden' : 'normal',
              turn_id: 'queued-run'
            }
          ])
    ]

    const final = [...rows, { role: 'assistant', row_id: 8, text: 'Same', turn_id: 'queued-run' }]
    const held = barrier()
    let reads = 0
    call.mockImplementation(() => (++reads === 1 ? held.promise : Promise.resolve(snapshot(final))))
    reload()
    const loading = useSections.getState().open('chat')
    event('message.start', { turn_id: 'queued-run', message_id: undefined })
    event('message.interim', { text: 'Same', turn_id: 'queued-run', message_id: '5' })
    event('tool.start', {
      tool_id: 'queued-tool',
      name: 'read',
      args: { path: 'private.txt' },
      turn_id: 'queued-run',
      message_id: '5'
    })
    event('approval.request', {
      request_id: 'queued-card',
      command: 'read private.txt',
      turn_id: 'queued-run',
      message_id: '5'
    })
    event('tool.complete', {
      tool_id: 'queued-tool',
      result_text: 'Contents',
      turn_id: 'queued-run',
      message_id: '5'
    })
    event('message.delta', { text: 'Same', turn_id: 'queued-run', message_id: '8' })
    held.resolve(snapshot(rows))
    await loading

    const expected = [
      ...prior.map(row => row.text),
      report.text,
      ...(mode === 'two-users' ? ['First input'] : []),
      'Same',
      ...(mode === 'two-users' ? ['Queued input'] : []),
      'Same'
    ]

    const text = () =>
      useTranscripts
        .getState()
        .bySession.chat!.messages.flatMap(message => [...(message.parts ?? []), message.text])
        .filter(Boolean)

    expect(text()).toEqual(expected)
    expect(useTranscripts.getState().bySession.chat!.approvals.map(card => card.requestId)).toEqual(
      ['queued-card']
    )
    expect(
      useTranscripts
        .getState()
        .bySession.chat!.messages.flatMap(message => message.toolCalls)
        .map(tool => [tool.toolId, tool.args])
    ).toEqual([['queued-tool', { path: 'private.txt' }]])
    event('message.complete', { text: 'Same', turn_id: 'queued-run', message_id: '8' })
    await useSections.getState().open('chat')
    await useSections.getState().open('chat')
    expect(text()).toEqual(expected)
    expect(
      useTranscripts
        .getState()
        .bySession.chat!.messages.flatMap(message => message.toolCalls)
        .map(tool => tool.toolId)
    ).toEqual(['queued-tool'])
  }
)

it('does not treat advertised identity support or duplicate projection keys as ownership proof', async () => {
  await useSections.getState().open('chat')
  const pending = useTranscripts.getState().appendUserMessage('chat', own.text, [file])

  const rows = [
    ...prior,
    report,
    { ...remote, text: own.text, input_id: pending.inputId },
    { ...own, input_id: pending.inputId }
  ]

  call.mockResolvedValue(snapshot(rows))
  reload()
  await useSections.getState().open('chat')
  await useSections.getState().open('chat')
  const messages = useTranscripts.getState().bySession.chat!.messages
  expect(messages.find(message => message.id === pending.id)?.attachments).toEqual([file])
  expect(
    messages.filter(message => !message.createdAt).flatMap(message => message.attachments)
  ).toEqual([])
})

it.each(['message.complete', 'error'])(
  'does not let a delayed old %s finish a newer run',
  async type => {
    await useSections.getState().open('chat')
    event('message.start', { turn_id: 'old-run', message_id: undefined })
    event('message.delta', {
      turn_id: 'old-run',
      message_id: 'old-fragment',
      text: 'Earlier live answer'
    })
    event('message.start', { turn_id: 'new-run', message_id: undefined })
    event('message.delta', {
      turn_id: 'new-run',
      message_id: 'new-fragment',
      text: 'Current live answer'
    })
    const before = useTranscripts.getState().bySession.chat!
    event(type, {
      turn_id: 'old-run',
      message_id: 'old-fragment',
      text: 'Earlier live answer',
      message: 'Old error'
    })
    const after = useTranscripts.getState().bySession.chat!
    expect(after.streamingMessageId).toBe(before.streamingMessageId)
    expect(after.activeTurnId).toBe('new-run')
    expect(after.turnActive).toBe(true)
    expect(after.messages.at(-1)).toEqual(before.messages.at(-1))
    expect(after.error).toBeNull()
  }
)

it('does not use an ACK or capability as proof when the projected input ID is omitted', async () => {
  await useSections.getState().open('chat')
  const pending = useTranscripts.getState().appendUserMessage('chat', own.text, [file])
  const rows = [...prior, report, { role: 'user', row_id: 6, text: own.text }]
  call.mockImplementation((method: string) =>
    Promise.resolve(
      method === 'prompt.submit'
        ? { status: 'submitted', input_id: pending.inputId }
        : snapshot(rows)
    )
  )
  await promptSubmit('chat', own.text, { input_id: pending.inputId, attachments: [file.id] })
  reload()
  await useSections.getState().open('chat')
  const messages = useTranscripts.getState().bySession.chat!.messages
  expect(messages.find(message => message.id === '6')?.attachments).toEqual([])
  expect(messages.find(message => message.id === pending.id)?.attachments).toEqual([file])
  expect(messages.filter(message => message.role === 'user')).toHaveLength(3)
})

it('keeps distinct fragment IDs without another legacy start and ignores late text for durable fragments', async () => {
  await useSections.getState().open('chat')
  event('message.start', { turn_id: 'fragment-run', message_id: undefined })
  const streaming = useTranscripts.getState().bySession.chat!.streamingMessageId
  event('message.interim', { turn_id: 'fragment-run', message_id: 'first-fragment', text: 'Same' })
  event('tool.start', {
    turn_id: 'fragment-run',
    message_id: 'first-fragment',
    tool_id: 'distinct-tool',
    name: 'read',
    args: { path: 'notes' }
  })
  event('message.delta', { turn_id: 'fragment-run', message_id: 'last-fragment', text: 'Same' })

  const rows = [
    ...prior,
    report,
    { role: 'assistant', row_id: 'first-fragment', turn_id: 'fragment-run', text: 'Same' },
    {
      role: 'tool',
      row_id: 'tool-result-own-row',
      turn_id: 'fragment-run',
      tool_id: 'distinct-tool',
      name: 'read',
      text: 'Contents'
    }
  ]

  call.mockResolvedValue(snapshot(rows as never))
  reload()
  await useSections.getState().open('chat')
  event('message.delta', { turn_id: 'fragment-run', message_id: 'first-fragment', text: 'Same' })
  event('message.interim', { turn_id: 'fragment-run', message_id: 'first-fragment', text: 'Same' })
  const live = useTranscripts.getState().bySession.chat!
  expect(live.streamingMessageId).toBe(streaming)
  expect(live.messages.at(-1)?.fragmentIds).toEqual(['first-fragment', 'last-fragment'])
  expect(live.messages.at(-1)?.fragmentIds).not.toContain('tool-result-own-row')
  expect(
    live.messages.flatMap(message => [...(message.parts ?? []), message.text]).filter(Boolean)
  ).toEqual([...prior.map(row => row.text), report.text, 'Same', 'Same'])
  call.mockResolvedValue(
    snapshot([
      ...rows,
      { role: 'assistant', row_id: 'last-fragment', turn_id: 'fragment-run', text: 'Same' }
    ] as never)
  )
  event('message.complete', { turn_id: 'fragment-run', message_id: 'last-fragment', text: 'Same' })
  await useSections.getState().open('chat')
  await useSections.getState().open('chat')
  expect(
    useTranscripts
      .getState()
      .bySession.chat!.messages.flatMap(message => [...(message.parts ?? []), message.text])
      .filter(Boolean)
  ).toEqual([...prior.map(row => row.text), report.text, 'Same', 'Same'])
})

it('creates a valid correlation key when randomUUID is unavailable on a paired page', async () => {
  const random = crypto.getRandomValues.bind(crypto)
  vi.stubGlobal('crypto', { getRandomValues: random })

  try {
    await useSections.getState().open('chat')
    const pending = useTranscripts.getState().appendUserMessage('chat', own.text, [file])
    expect(pending.inputId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

it.each([false, true])(
  'adopts a partial terminal once and retains its error, durable fragment=%s',
  async durable => {
    await useSections.getState().open('chat')
    const rows = [...prior, report, remote]
    const held = barrier()
    let reads = 0
    call.mockImplementation(() =>
      ++reads === 1
        ? held.promise
        : Promise.resolve(
            snapshot(durable ? [...rows, { ...remoteAnswer, text: 'Partial answer' }] : rows)
          )
    )
    reload()
    const loading = useSections.getState().open('chat')
    event('message.start')
    event('message.delta', { text: 'Partial answer' })
    held.resolve(snapshot(rows))
    await loading
    event('message.complete', {
      text: 'Partial answer',
      partial: true,
      status: 'interrupted',
      error: 'Turn interrupted'
    })
    await useSections.getState().open('chat')
    await useSections.getState().open('chat')
    const messages = useTranscripts.getState().bySession.chat!.messages
    expect(messages.filter(message => message.text === 'Partial answer')).toHaveLength(
      durable ? 1 : 0
    )
    expect(messages.filter(message => message.error === 'Turn interrupted')).toHaveLength(1)

    if (durable) {
      expect(messages.find(message => message.id === '5')).toMatchObject({
        text: 'Partial answer',
        error: 'Turn interrupted',
        status: 'interrupted'
      })
    }
  }
)
