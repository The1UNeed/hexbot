import type { GatewayEvent } from '@hermes/shared'

import { routeEvent } from '../lib/events'
import { setActiveRpc } from '../lib/rpc'
import type { DaemonInfo, Section } from '../lib/types'

import { useConnection } from './connection'
import { liveSectionsOf, useSections } from './sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

const section = { id: 'chat', bot: 'owl', live_session_id: 'live', title: 'Chat' } as Section

const event = (type: string, payload: Record<string, unknown> = {}) =>
  routeEvent({ payload, session_id: 'live', type } as GatewayEvent, {
    refreshBots: () => undefined,
    refreshSections: () => undefined
  })

const approval = (id: string) =>
  event('approval.request', { choices: ['once', 'deny'], command: `run ${id}`, request_id: id })

const question = (id: string) =>
  event('clarify.request', { choices: ['red', 'blue'], question: 'Colour?', request_id: id })

const transcript = () => useTranscripts.getState().bySession.live!
const status = () => liveSectionsOf(useTranscripts.getState().bySession).chat
const ids = (cards: { requestId: string }[]) => cards.map(card => card.requestId)

let opened: Record<string, unknown>
let held: Promise<void> | null

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000)
  useConnection.setState({
    target: { kind: 'local' },
    epoch: 'first',
    daemon: { one_chat: true, transcript_identity: true } as DaemonInfo
  })
  useSections.setState({ byId: { chat: section }, idsByBot: { owl: ['chat'] }, liveSessionId: {} })
  useTranscripts.setState({ bySession: {} })
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  opened = { section, messages: [] }
  held = null
  setActiveRpc({
    call: async (method: string) => {
      await held

      return method === 'hexbot.sections.open' ? opened : {}
    }
  } as never)
  useTranscripts.getState().setSectionId('live', 'chat')
})

afterEach(() => {
  vi.useRealTimers()
  setActiveRpc(null)
  resetTranscriptEffects()
})

describe('a card answered or dropped on another app', () => {
  it('shows the approval answered and no longer waits', () => {
    approval('a1')
    expect(status()).toBe('needs_you')
    event('approval.resolved', { choice: 'once', request_id: 'a1' })
    expect(transcript().approvals.map(card => card.decision)).toEqual(['once'])
    expect(status()).toBeUndefined()
  })

  it('drops an unanswered approval the bot stopped waiting on, and keeps an answered one', () => {
    approval('a1')
    approval('a2')
    useTranscripts.getState().resolveApproval('live', 'a1', 'deny')
    event('approval.expire', { request_id: 'a1' })
    event('approval.expire', { request_id: 'a2' })
    expect(ids(transcript().approvals)).toEqual(['a1'])
    expect(status()).toBeUndefined()
  })

  it('shows the answer to a question and settles only that one', () => {
    question('q1')
    question('q2')
    event('clarify.resolved', { answers: { q1: 'blue' }, request_id: 'q1' })
    expect(transcript().clarifies.map(card => card.answers)).toEqual([{ q1: 'blue' }, {}])
    expect(status()).toBe('needs_you')
    event('clarify.expire', { request_id: 'q2' })
    expect(status()).toBeUndefined()
  })
})

describe('reading a section again', () => {
  it('drops cards that stopped waiting while events were missed, and keeps the rest', async () => {
    approval('gone')
    approval('waiting')
    question('asked')
    question('answered')
    useTranscripts.getState().answerClarify('live', 'answered', 'answered', 'red')
    vi.setSystemTime(2_000)
    let release!: () => void
    held = new Promise(resolve => (release = resolve))
    opened = { ...opened, busy: true, pending_requests: ['waiting'] }
    const read = useSections.getState().open('chat')
    // Newer than the snapshot: it stays even though the read does not list it.
    approval('during')
    release()
    await read
    expect(ids(transcript().approvals)).toEqual(['waiting', 'during'])
    expect(ids(transcript().clarifies)).toEqual([])
    expect(status()).toBe('needs_you')
  })

  it('ends a turn whose end was missed', async () => {
    event('message.start')
    event('message.delta', { text: 'Half a reply' })
    question('asked')
    expect(status()).toBe('needs_you')
    vi.setSystemTime(2_000)
    opened = {
      ...opened,
      busy: false,
      messages: [{ role: 'assistant', row_id: 1, text: 'Half a reply, then the rest' }],
      pending_requests: []
    }
    await useSections.getState().open('chat')
    expect(transcript().streamingMessageId).toBeNull()
    expect(transcript().turnActive).toBe(false)
    expect(transcript().messages.map(message => message.text)).toEqual([
      'Half a reply, then the rest'
    ])
    expect(status()).toBeUndefined()
  })

  it('keeps a turn that started during the read', async () => {
    vi.setSystemTime(2_000)
    let release!: () => void
    held = new Promise(resolve => (release = resolve))
    opened = { ...opened, busy: false, pending_requests: [] }
    const read = useSections.getState().open('chat')
    event('message.start')
    release()
    await read
    expect(transcript().turnActive).toBe(true)
    expect(status()).toBe('working')
  })

  it.each([
    ['clarify.resolved', { answers: { q1: 'red' } }, false],
    ['clarify.resolved', { answers: { q1: 'red' } }, true],
    ['clarify.expire', {}, false],
    ['clarify.expire', {}, true]
  ] as const)(
    'a question settled by %s %j during the read stays settled, card shown before=%s',
    async (type, settle, shown) => {
      if (shown) {
        question('q1')
      }

      vi.setSystemTime(2_000)
      let release!: () => void
      held = new Promise(resolve => (release = resolve))
      // The snapshot was taken before another app answered or the bot stopped waiting.
      opened = {
        ...opened,
        busy: true,
        pending_clarify: { choices: ['red', 'blue'], question: 'Colour?', request_id: 'q1' },
        pending_requests: ['q1']
      }
      const read = useSections.getState().open('chat')
      event(type, { ...settle, request_id: 'q1' })
      release()
      await read
      expect(transcript().clarifies.filter(card => !card.expired && !card.answers.q1)).toEqual([])
      expect(status()).toBeUndefined()
    }
  )

  it('still reads again when a turn this read ended completes', async () => {
    const opens = vi.fn(async () => opened)
    setActiveRpc({
      call: (method: string) => (method === 'hexbot.sections.open' ? opens() : {})
    } as never)
    event('message.start')
    vi.setSystemTime(2_000)
    opened = { ...opened, busy: false, pending_requests: [] }
    await useSections.getState().open('chat')
    expect(transcript().turnActive).toBe(false)
    event('message.complete', { text: 'Done' })
    await vi.waitFor(() => expect(opens).toHaveBeenCalledTimes(2))
  })

  it('keeps every card from a daemon that does not list what waits', async () => {
    approval('a1')
    question('q1')
    vi.setSystemTime(2_000)
    await useSections.getState().open('chat')
    expect(ids(transcript().approvals)).toEqual(['a1'])
    expect(ids(transcript().clarifies)).toEqual(['q1'])
  })
})
