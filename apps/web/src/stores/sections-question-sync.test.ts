import type * as api from '../lib/api'
import { clarifyAnswered, sectionsOpen } from '../lib/api'
import { routeEvent } from '../lib/events'
import type { Bot, Section } from '../lib/types'

import { useBots } from './bots'
import { liveSectionsOf, sectionStatusOf, useSections } from './sections'
import {
  clarifyWaiting,
  resetTranscriptEffects,
  setTranscriptEffects,
  useTranscripts
} from './transcripts'

vi.mock('../lib/api', async importOriginal => ({
  ...(await importOriginal<typeof api>()),
  sectionsOpen: vi.fn()
}))

const section = {
  id: 'section',
  bot: 'hexbot',
  archived_at: null,
  live_session_id: 'live'
} as Section

const question = 'What do you mainly want help with?'
const actions = () => useTranscripts.getState()
const current = () => actions().bySession.live!
const status = () => sectionStatusOf(undefined, section.id, liveSectionsOf(actions().bySession))
const ask = (id = 'question') => actions().clarifyRequest('live', { request_id: id, question })

const snapshot = (): Awaited<ReturnType<typeof sectionsOpen>> => ({
  section,
  messages: [
    { role: 'assistant', text: question },
    {
      role: 'tool',
      name: 'clarify',
      tool_id: 'model-tool-call',
      args: { question },
      text: 'Tech and software'
    },
    { role: 'assistant', text: 'Got it, tech and software.' }
  ]
})

function deferred() {
  let resolve!: (value: Awaited<ReturnType<typeof sectionsOpen>>) => void
  let reject!: (reason: Error) => void

  const promise = new Promise<Awaited<ReturnType<typeof sectionsOpen>>>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, reject, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  actions().dropAll()
  useSections.setState({
    byId: { section },
    idsByBot: { hexbot: [section.id] },
    liveSessionId: { section: 'live' }
  })
  useBots.setState({
    byName: { hexbot: { name: 'hexbot', status: 'idle' } as Bot },
    order: ['hexbot']
  })
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  actions().open('live', section.id, [])
})

afterEach(resetTranscriptEffects)

it('settles a question answered in the other app and rejects an older replay', () => {
  ask()
  routeEvent({
    type: 'clarify.resolved',
    session_id: 'live',
    payload: {
      request_id: 'question',
      answers: { question: 'Tech and software' },
      status: 'answered'
    }
  })
  actions().messageComplete('live', { text: 'Got it, tech and software.' })
  ask()
  expect(clarifyAnswered(current().clarifies[0]!)).toBe(true)
  expect(status()).toBe('idle')
})

describe.each(['open', 'openThread'] as const)('%s question recovery', method => {
  const open = async () => {
    if (method === 'open') {
      await useSections.getState().open(section.id)

      return current().messages
    }

    return (await useSections.getState().openThread(section.id, 'fox')).messages
  }

  it('retires both stale onboarding cards after missing the answers from another app', async () => {
    ask()
    ask('style')
    vi.mocked(sectionsOpen).mockResolvedValue(snapshot())
    const messages = await open()
    expect(messages.flatMap(message => message.clarifies ?? []).some(clarifyAnswered)).toBe(true)
    expect(current().clarifies.filter(clarifyWaiting)).toEqual([])
    expect(status()).toBe('idle')
    ask()
    ask('style')
    expect(current().clarifies.filter(clarifyWaiting)).toEqual([])
  })

  it('preserves the current stream while retiring stale cards', async () => {
    ask()
    actions().messageDelta('live', 'A new reply is streaming')
    const streaming = current().streamingMessageId
    vi.mocked(sectionsOpen).mockResolvedValue({ section, messages: [] })
    await open()
    expect(current().clarifies.filter(clarifyWaiting)).toEqual([])
    expect(current().streamingMessageId).toBe(streaming)
  })

  it('keeps sibling questions when the daemon still reports one pending request', async () => {
    ask()
    ask('sibling')
    vi.mocked(sectionsOpen).mockResolvedValue({
      ...snapshot(),
      pending_clarify: { request_id: 'sibling', question }
    })
    await open()
    expect(
      current()
        .clarifies.filter(clarifyWaiting)
        .map(card => card.requestId)
    ).toEqual(['question', 'sibling'])
  })

  it.each(['new', 'replayed'] as const)(
    'keeps a %s question received while history is loading',
    async kind => {
      ask()
      const pending = deferred()
      vi.mocked(sectionsOpen).mockReturnValue(pending.promise)
      const opening = open()
      ask(kind === 'new' ? 'new-question' : 'question')
      pending.resolve(snapshot())
      await opening

      const waiting = current()
        .clarifies.filter(clarifyWaiting)
        .map(card => card.requestId)

      expect(waiting).toContain(kind === 'new' ? 'new-question' : 'question')
      expect(status()).toBe('needs_you')
    }
  )

  it('does not clear a question from a replacement session epoch', async () => {
    ask()
    const pending = deferred()
    vi.mocked(sectionsOpen).mockReturnValue(pending.promise)
    const opening = open()
    actions().drop('live')
    actions().open('live', section.id, [])
    ask()
    pending.resolve(snapshot())
    await opening
    expect(current().clarifies.filter(clarifyWaiting)).toHaveLength(1)
  })

  it('keeps unanswered approvals while retiring stale questions', async () => {
    ask()
    actions().approvalRequest('live', { request_id: 'approval' })
    vi.mocked(sectionsOpen).mockResolvedValue(snapshot())
    await open()
    expect(current().clarifies.filter(clarifyWaiting)).toEqual([])
    expect(current().approvals[0]?.decision).toBeUndefined()
  })

  it('leaves questions available when history cannot be read', async () => {
    ask()
    vi.mocked(sectionsOpen).mockRejectedValue(new Error('Disconnected'))
    await expect(open()).rejects.toThrow('Disconnected')
    expect(current().clarifies.filter(clarifyWaiting)).toHaveLength(1)
  })
})
