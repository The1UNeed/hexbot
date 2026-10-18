import type { GatewayEvent } from '@hermes/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useConnection } from '../stores/connection'
import { useSections } from '../stores/sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from '../stores/transcripts'

import { promptSubmit } from './api'
import { routeEvent } from './events'
import { setActiveRpc } from './rpc'
import type { Attachment, DaemonInfo, Section } from './types'

const section = { id: 'chat', bot: 'owl', live_session_id: 'chat', peer_bot: null } as Section

const prior = [
  { role: 'user', row_id: 'old-user', text: 'Earlier owner question' },
  { role: 'assistant', row_id: 'old-answer', text: 'Earlier bot answer' }
]

const report = { role: 'assistant', row_id: 'report', text: 'Dream report', dream: true }

const file: Attachment = {
  id: 'own-file',
  name: 'own-private-notes.txt',
  mime: 'text/plain',
  size: 9,
  kind: 'file',
  path: '/workspace/own-private-notes.txt'
}

const barrier = <T = unknown>() => {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(yes => {
    resolve = yes
  })

  return { promise, resolve }
}

const snapshot = (messages = prior) => ({ section, messages })
const deps = { refreshBots: () => {}, refreshSections: () => {} }

const event = (type: string, payload: Record<string, unknown> = {}) =>
  routeEvent({ type, session_id: 'chat', payload } as GatewayEvent, deps)

const reload = () =>
  routeEvent(
    {
      type: 'hexbot.sections.changed',
      payload: { id: 'chat', bot: 'owl', reload: true }
    } as GatewayEvent,
    deps
  )

const messages = () => useTranscripts.getState().bySession.chat!.messages
let call: ReturnType<typeof vi.fn>
beforeEach(() => {
  useConnection.setState({
    target: { kind: 'local' },
    epoch: 'process',
    daemon: {
      one_chat: true,
      install_id: 'installation'
    } as DaemonInfo
  })
  useSections.setState({
    byId: { chat: section },
    idsByBot: { owl: ['chat'] },
    liveSessionId: {},
    choosing: null
  })
  useTranscripts.setState({ bySession: {} })
  setTranscriptEffects({ touchSection: () => {}, notify: () => {}, ackApproval: () => {} })
  call = vi.fn(() => Promise.resolve(snapshot()))
  setActiveRpc({ call } as never)
})
afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

it.each([
  { same: false, remoteFirst: false },
  { same: false, remoteFirst: true },
  { same: true, remoteFirst: false },
  { same: true, remoteFirst: true }
])(
  'retains an unproven local input and file, same text=$same, remote first=$remoteFirst',
  async ({ same, remoteFirst }) => {
    await useSections.getState().open('chat')
    const text = 'This client question'
    const local = useTranscripts.getState().appendUserMessage('chat', text, [file])
    const submit = barrier<{ status: string }>()
    const entered = barrier<void>()
    const held = barrier()
    const own = { role: 'user', row_id: 'own-user', text }

    const remote = {
      role: 'user',
      row_id: 'remote-user',
      text: same ? text : 'Other client question'
    }

    const answer = { role: 'assistant', row_id: 'remote-answer', text: 'Other client answer' }
    let rows = [...prior, report, ...(remoteFirst ? [remote, answer] : [own])]
    call.mockImplementation((method: string) => {
      if (method === 'prompt.submit') {
        entered.resolve()

        return submit.promise
      }

      return method === 'hexbot.sections.open' ? held.promise : Promise.resolve({})
    })
    const submitting = promptSubmit('chat', text, { attachments: [file.id] })
    await entered.promise
    reload()
    const loading = useSections.getState().open('chat')
    held.resolve(snapshot(rows))
    await loading
    expect(messages().find(m => m.id === local.id)).toMatchObject({ text, attachments: [file] })
    expect(
      messages()
        .filter(m => !m.createdAt)
        .flatMap(m => m.attachments)
    ).toEqual([])
    submit.resolve({ status: 'submitted' })
    await submitting
    rows = [
      ...prior,
      report,
      remote,
      answer,
      own,
      { role: 'assistant', row_id: 'own-answer', text: 'Own answer' }
    ]
    call.mockResolvedValue(snapshot(rows))
    reload()
    await useSections.getState().open('chat')
    await useSections.getState().open('chat')
    expect(messages().find(m => m.id === local.id)).toMatchObject({ text, attachments: [file] })
    expect(
      messages()
        .filter(m => !m.createdAt)
        .flatMap(m => m.attachments)
    ).toEqual([])
    expect(
      messages()
        .filter(m => m.role === 'user')
        .map(m => m.id)
    ).toEqual(['old-user', 'remote-user', 'own-user', local.id])
  }
)

it.each([false, true])(
  'retains ordered unproven queued inputs and distinct files, same text=%s',
  async same => {
    await useSections.getState().open('chat')
    const secondFile = { ...file, id: 'second-file', name: 'second-private.txt' }
    const first = useTranscripts.getState().appendUserMessage('chat', 'Same', [file])

    const second = useTranscripts
      .getState()
      .appendUserMessage('chat', same ? 'Same' : 'Second', [secondFile])

    const rows = [
      ...prior,
      report,
      { role: 'user', row_id: 'remote-user', text: 'Same' },
      { role: 'assistant', row_id: 'remote-answer', text: 'Same' },
      { role: 'user', row_id: 'own-one', text: first.text },
      { role: 'assistant', row_id: 'answer-one', text: 'Same' },
      { role: 'user', row_id: 'own-two', text: second.text }
    ]

    const submitted = barrier<{ status: string }>()
    const entered = barrier<void>()
    let submissions = 0
    call.mockImplementation((method: string) => {
      if (method === 'prompt.submit') {
        if (++submissions === 2) {
          entered.resolve()
        }

        return submitted.promise
      }

      return Promise.resolve(snapshot(rows))
    })

    const sending = [
      promptSubmit('chat', first.text, { queued: true, attachments: [file.id] }),
      promptSubmit('chat', second.text, { queued: true, attachments: [secondFile.id] })
    ]

    await entered.promise
    reload()
    await useSections.getState().open('chat')
    submitted.resolve({ status: 'submitted' })
    await Promise.all(sending)
    await useSections.getState().open('chat')
    expect(
      messages()
        .filter(m => m.createdAt)
        .map(m => [m.id, m.text, m.attachments])
    ).toEqual([
      [first.id, first.text, [file]],
      [second.id, second.text, [secondFile]]
    ])
    expect(
      messages()
        .filter(m => !m.createdAt)
        .flatMap(m => m.attachments)
    ).toEqual([])
  }
)

it.each(['loaded', 'unloaded'])(
  'adopts a settled remote snapshot once without a visible-user anchor, %s',
  async loaded => {
    if (loaded === 'loaded') {
      await useSections.getState().open('chat')
    }

    const held = barrier()
    const rows = [...prior, report, { role: 'user', row_id: 'remote-user', text: 'Remote input' }]
    const answer = { role: 'assistant', row_id: 'remote-answer', text: 'Remote answer' }
    let reads = 0
    call.mockImplementation(() =>
      ++reads === 1 ? held.promise : Promise.resolve(snapshot([...rows, answer]))
    )
    reload()
    const loading = useSections.getState().open('chat')
    event('message.start')
    event('message.delta', { text: answer.text })
    held.resolve(snapshot(rows))
    await loading
    expect(messages().map(m => m.text)).toEqual([...rows, answer].map(m => m.text))
    event('message.complete', { text: answer.text })
    await useSections.getState().open('chat')
    await useSections.getState().open('chat')
    expect(messages().map(m => [m.id, m.text])).toEqual(
      [...rows, answer].map(m => [m.row_id, m.text])
    )
  }
)
