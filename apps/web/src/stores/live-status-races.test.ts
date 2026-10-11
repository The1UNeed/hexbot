import type { GatewayEvent } from '@hermes/shared'

import type { sectionsOpen } from '../lib/api'
import { routeEvent } from '../lib/events'
import { setActiveRpc } from '../lib/rpc'
import type { Bot, Section } from '../lib/types'

import { useBots } from './bots'
import { useRooms } from './rooms'
import { botStatusWithLive, liveSectionsOf, sectionStatusOf, useSections } from './sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

const actions = () => useTranscripts.getState()

const event = (type: string, payload: Record<string, unknown> = {}, session = 'live') =>
  routeEvent({ type, session_id: session, payload } as GatewayEvent)

const deferred = <T = unknown>() => {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(done => {
    resolve = done
  })

  return { promise, resolve }
}

const owner = (sectionId = 's1', status: Bot['status'] = 'working') =>
  ({
    name: 'owl',
    status,
    status_detail: {
      section_id: sectionId.startsWith('room:') ? null : sectionId,
      room_id: sectionId.startsWith('room:') ? sectionId.slice(5) : null,
      session_id: 'live'
    }
  }) as Bot

function expectStatus(status: Bot['status'], sectionId = 's1') {
  const bot = useBots.getState().byName.owl!
  const live = liveSectionsOf(actions().bySession)
  const sections = sectionId === 's1' ? [{ id: sectionId, bot: 'owl' } as Section] : []

  if (!sectionId.startsWith('room:')) {
    expect(sectionStatusOf(bot, sectionId, live)).toBe(status)
  }

  expect(botStatusWithLive(bot, sections, live, actions().bySession)).toBe(status)
}

beforeEach(() => {
  actions().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  useSections.setState({ byId: {}, idsByBot: { owl: ['s1', 's2'] } })
  useRooms.setState({ liveTurnsByRoom: {} })
  useBots.setState({ byName: { owl: owner() }, order: ['owl'] })
  actions().open('live', 's1', [])
})

afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

describe.each(['s1', 'thread', 'room:r'])('coexisting cards in %s', sectionId => {
  it.each([
    ['approval', true],
    ['approval', false],
    ['clarify', true],
    ['clarify', false]
  ] as const)(
    'keeps the sibling card waiting after a %s answer resumes (status first=%s)',
    async (kind, statusFirst) => {
      const response = deferred()
      setActiveRpc({
        call: vi.fn((method: string) =>
          method === 'hexbot.bots.list' ? Promise.reject(new Error('offline')) : response.promise
        )
      } as never)
      useBots.setState({ byName: { owl: owner(sectionId) } })
      actions().open('live', sectionId, [])
      event('clarify.request', { request_id: 'question', question: 'Choose a name?' })
      event('approval.request', { request_id: 'permission', choices: ['once'] })

      const answer =
        kind === 'approval'
          ? actions().respondApproval('live', 'permission', 'once')
          : actions().respondClarify('live', 'question', 'Example')

      if (statusFirst) {
        event('status.update', { kind: 'working', text: 'Working' })
      }

      response.resolve(kind === 'approval' ? { resolved: true } : { status: 'answered' })
      await answer

      if (!statusFirst) {
        event('status.update', { kind: 'working', text: 'Working' })
      }

      await useBots.getState().refresh()

      if (kind === 'approval') {
        expect(actions().bySession.live?.clarifies[0]?.answers).toEqual({})
      } else {
        expect(actions().bySession.live?.approvals[0]?.decision).toBeUndefined()
      }

      expectStatus('needs_you', sectionId)

      event('clarify.expire', { request_id: 'question' })
      event('message.complete', { text: 'Done.' })
      event('status.update', { kind: 'idle', text: '' })
      expectStatus('idle', sectionId)
    }
  )
})

describe('question id completion', () => {
  it('accepts one answer for repeated ids through the actual clarify RPC', async () => {
    useBots.setState({ byName: { owl: owner('s1', 'needs_you') } })
    setActiveRpc({ call: vi.fn(async () => ({ status: 'answered' })) } as never)
    event('clarify.request', {
      request_id: 'batch',
      questions: [
        { qid: 'same', question: 'First?' },
        { qid: 'same', question: 'Second?' }
      ]
    })
    await actions().respondClarify('live', 'batch', 'Yes', 'same')
    expectStatus('working')
  })

  it('keeps a question pending when unrelated answer keys equal the question count', () => {
    event('clarify.request', {
      request_id: 'batch',
      questions: [{ qid: 'actual', question: 'Choose?' }],
      answers: { unrelated: 'Yes' }
    })
    actions().statusUpdate('live', { kind: 'working', text: 'Working' })
    expectStatus('needs_you')
  })

  it('rejects unrelated keys as positive answer evidence', () => {
    useBots.setState({ byName: { owl: owner('s1', 'needs_you') } })
    event('clarify.request', {
      request_id: 'batch',
      questions: [{ qid: 'actual', question: 'Choose?' }]
    })
    actions().answerClarify('live', 'batch', 'unrelated', 'Yes')
    expect(actions().bySession.live?.answeredWaiting).toBeUndefined()
    expectStatus('needs_you')
  })
})

describe.each(['approval', 'clarify'] as const)('%s response after pending replay', kind => {
  it.each([false, true])('settles only its own replay (sibling=%s)', async sibling => {
    useBots.setState({ byName: { owl: owner('s1', 'needs_you') } })
    const response = deferred()
    setActiveRpc({ call: vi.fn(() => response.promise) } as never)

    const ask = () =>
      event(`${kind}.request`, {
        request_id: 'answer',
        question: 'Choose?',
        choices: ['once']
      })

    ask()

    const answering =
      kind === 'approval'
        ? actions().respondApproval('live', 'answer', 'once')
        : actions().respondClarify('live', 'answer', 'Yes')

    event('status.update', { kind: 'working', text: 'Working' })
    ask()

    if (sibling) {
      event('clarify.request', { request_id: 'other', question: 'Still pending?' })
    }

    response.resolve(kind === 'approval' ? { resolved: true } : { status: 'answered' })
    await answering
    expectStatus(sibling ? 'needs_you' : 'working')
    expect(
      actions().bySession.live?.waitingRequests?.some(
        item => item.kind === kind && item.requestId === 'answer'
      )
    ).toBe(false)
  })

  it.each(['event', 'roster'] as const)(
    'preserves newer Idle before a late replay and reply (%s)',
    async boundary => {
      useBots.setState({ byName: { owl: owner('s1', 'needs_you') } })
      const response = deferred()
      setActiveRpc({
        call: vi.fn((method: string) =>
          method === 'hexbot.bots.list'
            ? Promise.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
            : response.promise
        )
      } as never)

      const ask = () =>
        event(`${kind}.request`, { request_id: 'answer', question: 'Choose?', choices: ['once'] })

      ask()

      const answering =
        kind === 'approval'
          ? actions().respondApproval('live', 'answer', 'once')
          : actions().respondClarify('live', 'answer', 'Yes')

      if (boundary === 'event') {
        event('status.update', { kind: 'idle', text: '' })
      } else {
        await useBots.getState().refresh()
      }

      ask()
      response.resolve(kind === 'approval' ? { resolved: true } : { status: 'answered' })
      await answering
      expect(actions().bySession.live?.answeredWaiting).toBeUndefined()
      expectStatus('idle')
    }
  )
})

describe.each(['full', 'scoped', 'update'])('%s aggregate roster', scope => {
  const refresh = () =>
    scope === 'full'
      ? useBots.getState().refresh()
      : scope === 'scoped'
        ? useBots.getState().refreshOne('owl')
        : useBots.getState().update('owl', { title: 'New title' })

  it('retires only the named session when another conversation is working', async () => {
    const named = { ...owner('s2'), status_detail: { section_id: 's2', session_id: 'other' } }
    const call = vi.fn(async () => (scope === 'full' ? { bots: [named] } : { bot: named }))
    setActiveRpc({ call } as never)
    actions().statusUpdate('live', { kind: 'working', text: 'Working' })
    actions().open('other', 's2', [])
    actions().statusUpdate('other', { kind: 'working', text: 'Working' })

    if (scope === 'full') {
      await useBots.getState().refresh()
    } else if (scope === 'scoped') {
      await useBots.getState().refreshOne('owl')
    } else {
      await useBots.getState().update('owl', { title: 'New title' })
    }

    expect(
      sectionStatusOf(useBots.getState().byName.owl, 's1', liveSectionsOf(actions().bySession))
    ).toBe('working')
    expect(actions().bySession.other?.liveStatus).toBeUndefined()
  })

  it.each(['s1', 'thread', 'room:r'])(
    'remembers %s ownership after the aggregate names another session, then retires on Idle',
    async sectionId => {
      actions().open('live', sectionId, [])
      actions().open('teammate', 'room:r', [], undefined, 'cat')
      actions().statusUpdate('teammate', { kind: 'working', text: 'Working' })
      actions().statusUpdate('live', { kind: 'working', text: 'Working' })
      useBots.setState({ byName: { owl: owner(sectionId) } })
      const selected = { ...owner('s2'), status_detail: { section_id: 's2', session_id: 'other' } }
      const idle = { name: 'owl', status: 'idle', status_detail: null } as Bot
      let reply = selected as Bot
      setActiveRpc({
        call: vi.fn(async () => (scope === 'full' ? { bots: [reply] } : { bot: reply }))
      } as never)
      await refresh()
      expect(actions().bySession.live?.liveStatus).toBe('working')
      reply = idle
      await refresh()
      expect(actions().bySession.live?.liveStatus).toBe('idle')
      expect(actions().bySession.teammate?.liveStatus).toBe('working')
    }
  )

  it('keeps a completed retained card idle after accepted aggregate Idle', async () => {
    event('clarify.request', { request_id: 'old', question: 'Choose?' })
    event('message.complete', { text: 'Done.' })
    event('status.update', { kind: 'idle', text: '' })
    const idle = { name: 'owl', status: 'idle', status_detail: null } as Bot
    setActiveRpc({
      call: vi.fn(async () => (scope === 'full' ? { bots: [idle] } : { bot: idle }))
    } as never)
    await refresh()
    expect(actions().bySession.live?.clarifies).toHaveLength(1)
    expectStatus('idle')
  })

  it('retains confirmed questions across matching NeedsYou, but lets accepted Working retire them', async () => {
    event('clarify.request', { request_id: 'old', question: 'Choose?' })
    let reply = owner('s1', 'needs_you')
    setActiveRpc({
      call: vi.fn(async () => (scope === 'full' ? { bots: [reply] } : { bot: reply }))
    } as never)
    await refresh()
    event('status.update', { kind: 'working', text: 'Working' })
    expectStatus('needs_you')
    reply = owner('s1', 'working')
    await refresh()
    expectStatus('working')
    event('clarify.request', { request_id: 'old', question: 'Choose?' })
    expectStatus('needs_you')
  })
})

describe.each(['open', 'openThread'] as const)('%s pending approval replay', method => {
  it.each([false, true])(
    'preserves duplicate replay across the snapshot (ahead=%s)',
    async ahead => {
      event('approval.request', { request_id: 'permission', choices: ['once'] })

      if (ahead) {
        actions().appendUserMessage('live', 'Earlier message')
      }

      const response = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
      setActiveRpc({ call: vi.fn(() => response.promise) } as never)

      const opening =
        method === 'open'
          ? useSections.getState().open('s1')
          : useSections.getState().openThread('s1', 'peer')

      event('approval.request', { request_id: 'permission', choices: ['once'] })
      response.resolve({
        section: { id: 's1', bot: 'owl', live_session_id: 'live' } as Section,
        messages: []
      })
      await opening
      expect(actions().bySession.live?.approvals).toHaveLength(1)
      expectStatus('needs_you')
    }
  )
})

describe.each(['open', 'openThread'] as const)('%s exact verification expiry', method => {
  it.each([
    [false, 'idle'],
    [false, 'needs_you'],
    [true, 'idle'],
    [true, 'needs_you']
  ] as const)(
    'retires an exact replay when verification confirms absence (sibling=%s, cached=%s)',
    async (sibling, cached) => {
      event('clarify.request', { request_id: 'question', question: 'Choose?' })
      const first = deferred()
      const verified = deferred()
      const verifying = deferred<void>()
      let reads = 0

      const call = vi.fn(() => {
        if (++reads === 1) {
          return first.promise
        }

        verifying.resolve()

        return verified.promise
      })

      setActiveRpc({ call } as never)

      const opening =
        method === 'open'
          ? useSections.getState().open('s1')
          : useSections.getState().openThread('s1', 'peer')

      const snapshot = {
        section: { id: 's1', bot: 'owl', live_session_id: 'live' },
        messages: []
      }

      event('status.update', { kind: 'working', text: 'Working' })
      first.resolve({
        ...snapshot,
        pending_clarify: { request_id: 'question', question: 'Choose?' }
      })
      await verifying.promise
      event('clarify.request', { request_id: 'question', question: 'Choose?' })

      if (sibling) {
        event('approval.request', { request_id: 'other', choices: ['once'] })
      }

      verified.resolve(snapshot)
      await opening
      useBots.setState({ byName: { owl: owner('s1', cached) } })
      expect(actions().bySession.live?.settledClarifyIds).toContain('question')
      expectStatus(sibling ? 'needs_you' : 'working')
      expect(call).toHaveBeenCalledTimes(2)
    }
  )
})

describe('retry resolution', () => {
  const stopped = () =>
    ({
      ...owner('s1', 'stopped'),
      status_detail: {
        section_id: 's1',
        session_id: 'live',
        room_id: null,
        action: { kind: 'retry' }
      }
    }) as Bot

  it('uses the explicit successful new-turn marker through a failed roster and completion', async () => {
    useBots.setState({ byName: { owl: stopped() } })
    setActiveRpc({
      call: vi.fn(async () => {
        throw new Error('offline')
      })
    } as never)
    event('message.start', { retry_resolved: true })
    event('status.update', { kind: 'working', text: 'Working' })
    await useBots.getState().refresh()
    expectStatus('working')
    event('message.complete', { text: 'Done.' })
    event('status.update', { kind: 'idle', text: '' })
    expectStatus('idle')
  })

  it('keeps retry Stopped for unmarked compaction and approval resume events', () => {
    useBots.setState({ byName: { owl: stopped() } })
    event('message.start')
    event('status.update', { kind: 'working', text: 'Compacting context...' })
    expectStatus('stopped')
  })

  it.each(['full', 'scoped', 'update'] as const)(
    'preserves a newer retry marker through an older %s reply, then accepts a newer stop',
    async scope => {
      const response = deferred()

      const call = vi.fn((method: string): Promise<unknown> =>
        method === 'hexbot.bots.list'
          ? Promise.resolve({ bots: [stopped()] })
          : Promise.resolve({ bot: stopped() })
      )

      call.mockReturnValueOnce(response.promise)
      setActiveRpc({ call } as never)
      useBots.setState({ byName: { owl: stopped() } })

      const refresh = () =>
        scope === 'full'
          ? useBots.getState().refresh()
          : scope === 'scoped'
            ? useBots.getState().refreshOne('owl')
            : useBots.getState().update('owl', { title: 'Edited' })

      const old = refresh()
      event('message.start', { retry_resolved: true })
      event('status.update', { kind: 'working', text: 'Working' })
      response.resolve(scope === 'full' ? { bots: [stopped()] } : { bot: stopped() })
      await old
      expectStatus('working')
      await refresh()
      expectStatus('stopped')
    }
  )

  it.each(['error', 'incident', 'roster', 'reconnect', 'snapshot', 'drop'])(
    'retires proof when %s arrives',
    async boundary => {
      useBots.setState({ byName: { owl: stopped() } })
      event('message.start', { retry_resolved: true })
      event('status.update', { kind: 'working', text: 'Working' })
      expectStatus('working')

      if (boundary === 'error') {
        event('error', { message: 'Failed again' })
      } else if (boundary === 'incident') {
        actions().incidentEvent('live', 'Failed again', { connector: null, incidentId: 'new' })
      } else if (boundary === 'roster') {
        setActiveRpc({ call: vi.fn(async () => ({ bots: [stopped()] })) } as never)
        await useBots.getState().refresh()
      } else if (boundary === 'reconnect') {
        actions().clearAnsweredWaiting()
      } else if (boundary === 'snapshot') {
        actions().open('live', 's1', [])
      } else {
        actions().drop('live')
        actions().open('live', 's1', [])
      }

      expectStatus('stopped')
    }
  )

  it.each(['connector', 'global', 'room', 'other section', 'other session'])(
    'preserves %s Stopped even with a marked new turn',
    cause => {
      const bot = stopped()

      if (cause === 'connector') {
        bot.status_detail = {
          ...bot.status_detail!,
          action: { kind: 'fix_connector', connector: 'mail' }
        }
      } else if (cause === 'global') {
        bot.status_detail = { ...bot.status_detail!, section_id: null, action: null }
      } else if (cause === 'room') {
        bot.status_detail = { ...bot.status_detail!, room_id: 'r' }
      } else if (cause === 'other section') {
        bot.status_detail = { ...bot.status_detail!, section_id: 's2' }
      } else {
        bot.status_detail = { ...bot.status_detail!, session_id: 'different' }
      }

      useBots.setState({ byName: { owl: bot } })
      event('message.start', { retry_resolved: true })
      event('status.update', { kind: 'working', text: 'Working' })
      expect(
        botStatusWithLive(
          bot,
          [{ id: 's1' } as Section],
          liveSectionsOf(actions().bySession),
          actions().bySession
        )
      ).toBe('stopped')

      if (!['global', 'other section'].includes(cause)) {
        expect(sectionStatusOf(bot, 's1', liveSectionsOf(actions().bySession))).toBe('stopped')
      }
    }
  )
})
