import type { GatewayEvent } from '@hermes/shared'

import { useBots } from '../stores/bots'
import { useRooms } from '../stores/rooms'
import {
  botStatusWithLive,
  clearDeletedSections,
  liveSectionsOf,
  sectionStatusOf,
  useSections
} from '../stores/sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from '../stores/transcripts'

import { routeEvent } from './events'
import { setActiveRpc } from './rpc'
import type { Bot, Section } from './types'

let sequence = 0

function fixture(
  lookup: 'indexed' | 'cached',
  existing: 'missing' | 'unbound' | 'bound' = 'missing'
) {
  const sessionId = `retry-live-${++sequence}`
  const sectionId = `retry-section-${sequence}`

  const section = {
    id: sectionId,
    bot: 'owl',
    archived_at: null,
    live_session_id: sessionId
  } as Section

  const stopped = {
    name: 'owl',
    status: 'stopped',
    status_detail: {
      section_id: sectionId,
      session_id: sessionId,
      room_id: null,
      action: { kind: 'retry' },
      text: 'Failed last turn'
    }
  } as Bot

  const state = { failBots: true, roster: stopped, heldBot: null as Promise<unknown> | null }

  clearDeletedSections()
  useBots.setState({ byName: { owl: stopped }, order: ['owl'] })
  useSections.setState({
    byId: lookup === 'indexed' ? { [sectionId]: section } : {},
    idsByBot: lookup === 'indexed' ? { owl: [sectionId] } : {},
    liveSessionId: lookup === 'indexed' ? { [sectionId]: sessionId } : {}
  })
  useRooms.setState({ byId: {}, liveTurnsByRoom: {} })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  setActiveRpc({
    call: vi.fn(async (method: string) => {
      if (method === 'hexbot.bots.list') {
        if (state.heldBot) {
          return state.heldBot
        }

        if (state.failBots) {
          throw new Error('Read unavailable')
        }

        return { bots: [state.roster] }
      }

      return {}
    })
  } as never)

  const event = (type: string, payload: Record<string, unknown> = {}, live = sessionId) =>
    routeEvent({ type, session_id: live, payload } as GatewayEvent)

  if (existing === 'unbound') {
    event('session.usage', { usage: { total_tokens: 1 } })
  }

  if (existing === 'bound') {
    useTranscripts.getState().open(sessionId, sectionId, [], undefined, 'owl')
  }

  const transcript = () => useTranscripts.getState().bySession[sessionId]

  const status = () => {
    const transcripts = useTranscripts.getState().bySession
    const live = liveSectionsOf(transcripts)
    const bot = useBots.getState().byName.owl!

    return {
      section: sectionStatusOf(bot, sectionId, live),
      bot: botStatusWithLive(bot, Object.values(useSections.getState().byId), live, transcripts)
    }
  }

  const retry = async (marked = true) => {
    // runtime.rs agent_start emits precisely these payloads, followed by bots.changed.
    event('message.start', marked ? { retry_resolved: true } : {})
    event('status.update', { kind: 'working', text: 'Working' })
    let refresh!: Promise<void>
    routeEvent({ type: 'hexbot.bots.changed', payload: { name: 'owl' } } as GatewayEvent, {
      refreshBots: () => {
        refresh = useBots.getState().refresh()
      }
    })
    await refresh
  }

  return { event, retry, section, sectionId, sessionId, state, status, stopped, transcript }
}

afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

describe.each(['indexed', 'cached'] as const)('%s unopened retry identity', lookup => {
  it.each(['missing', 'unbound'] as const)(
    'binds the exact owner of a %s transcript despite failed bot refresh',
    async existing => {
      const f = fixture(lookup, existing)
      expect(f.status()).toEqual({ section: 'stopped', bot: 'stopped' })
      await f.retry()
      expect(f.status()).toEqual({ section: 'working', bot: 'working' })
      expect(f.transcript()).toMatchObject({
        sectionId: f.sectionId,
        bot: 'owl',
        retryResolved: true
      })
      expect(useBots.getState().byName.owl?.status).toBe('stopped')
    }
  )

  it('does not infer retry resolution from an ordinary unmarked start', async () => {
    const f = fixture(lookup)
    await f.retry(false)
    expect(f.transcript()?.retryResolved).toBeUndefined()
    expect(f.status()).toEqual({ section: 'stopped', bot: 'stopped' })
  })

  it.each(['completion', 'error', 'failed completion', 'new incident'] as const)(
    'handles %s after retry',
    async transition => {
      const f = fixture(lookup)
      await f.retry()

      if (transition === 'completion') {
        f.event('message.complete', { text: 'Done' })
      } else if (transition === 'error') {
        f.event('error', { message: 'Failed again' })
      } else if (transition === 'failed completion') {
        f.event('message.complete', { status: 'error', error: 'Failed again' })
      } else {
        f.event('hexbot.bots.incident', {
          bot: 'owl',
          section_id: f.sectionId,
          session_id: f.sessionId,
          incident: { id: 'new-incident', text: 'Failed again' }
        })
      }

      expect(f.status()).toEqual(
        transition === 'completion'
          ? { section: 'idle', bot: 'idle' }
          : { section: 'stopped', bot: 'stopped' }
      )
      expect(f.transcript()?.retryResolved).toBe(transition === 'completion' ? true : undefined)

      if (transition !== 'completion') {
        await f.retry()
        expect(f.status()).toEqual({ section: 'working', bot: 'working' })
      }
    }
  )

  it('preserves a sibling confirmed wait when retry resumes', async () => {
    const f = fixture(lookup)
    useTranscripts.getState().open('sibling-live', 'sibling', [], undefined, 'owl')
    f.event(
      'clarify.request',
      { request_id: 'sibling-wait', question: 'Continue?', section_id: 'sibling', bot: 'owl' },
      'sibling-live'
    )
    await f.retry()
    expect(f.status()).toEqual({ section: 'working', bot: 'needs_you' })
    expect(useTranscripts.getState().bySession['sibling-live']?.waitingRequests).toHaveLength(1)
  })

  it.each(['connector', 'room', 'global', 'other session'] as const)(
    'keeps an unrelated %s Stopped cause',
    async cause => {
      const f = fixture(lookup)
      const detail = { ...f.stopped.status_detail! }

      if (cause === 'connector') {
        detail.action = { kind: 'fix_connector', connector: 'mail' }
      }

      if (cause === 'room') {
        detail.room_id = 'r'
      }

      if (cause === 'global') {
        detail.section_id = null
      }

      if (cause === 'other session') {
        detail.session_id = 'other-live'
      }

      useBots.setState({ byName: { owl: { ...f.stopped, status_detail: detail } } })
      await f.retry()
      expect(f.status().bot).toBe('stopped')
    }
  )

  it('keeps retry evidence ahead of a Stopped read started before the marker', async () => {
    const f = fixture(lookup)
    let resolve!: (value: unknown) => void
    f.state.heldBot = new Promise(done => {
      resolve = done
    })
    const read = useBots.getState().refresh()
    f.event('message.start', { retry_resolved: true })
    f.event('status.update', { kind: 'working', text: 'Working' })
    resolve({ bots: [f.stopped] })
    await read
    expect(f.status()).toEqual({ section: 'working', bot: 'working' })
  })

  it('retires retry evidence on a newer accepted exact Stopped read', async () => {
    const f = fixture(lookup)
    await f.retry()
    f.state.failBots = false
    await useBots.getState().refresh()
    expect(f.transcript()?.retryResolved).toBeUndefined()
    expect(f.status()).toEqual({ section: 'stopped', bot: 'stopped' })
  })

  it('does not bind a late marker to a definitively deleted section', async () => {
    const f = fixture(lookup)
    f.event('hexbot.sections.changed', { id: f.sectionId, bot: 'owl', deleted: true })
    await f.retry()
    expect(f.transcript()?.sectionId).toBeUndefined()
    expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
  })

  it('does not rewrite an existing room identity to the private cached cause', async () => {
    const f = fixture(lookup)
    useTranscripts.getState().open(f.sessionId, 'room:r', [], undefined, 'owl')
    await f.retry()
    expect(f.transcript()?.sectionId).toBe('room:r')
    expect(f.transcript()?.retryResolved).toBeUndefined()
    expect(f.status()).toEqual({ section: 'stopped', bot: 'stopped' })
  })

  it('does not transfer retry proof across conflicting transcript ownership', async () => {
    const f = fixture(lookup)
    useTranscripts.getState().open(f.sessionId, f.sectionId, [], undefined, 'other')
    await f.retry()
    expect(f.transcript()?.bot).toBe('other')
    expect(f.transcript()?.retryResolved).toBeUndefined()
    expect(f.status()).toEqual({ section: 'stopped', bot: 'stopped' })
  })
})

it('binds an archived known section without making it count toward the bot dot', async () => {
  const f = fixture('indexed')
  useSections.setState({ byId: { [f.sectionId]: { ...f.section, archived_at: 1 } } })
  await f.retry()
  expect(f.transcript()?.sectionId).toBe(f.sectionId)
  expect(f.status()).toEqual({ section: 'working', bot: 'idle' })
})

it('binds an unlisted teammate section from its own exact cached cause', async () => {
  const f = fixture('cached')
  const teammate = { ...f.stopped, name: 'fox' }
  useBots.setState({ byName: { fox: teammate }, order: ['fox'] })
  f.event('message.start', { retry_resolved: true })
  f.event('status.update', { kind: 'working', text: 'Working' })
  const transcripts = useTranscripts.getState().bySession
  const live = liveSectionsOf(transcripts)
  expect(botStatusWithLive(teammate, [], live, transcripts)).toBe('working')
  expect(f.transcript()).toMatchObject({ sectionId: f.sectionId, bot: 'fox', retryResolved: true })
})

it('rejects conflicting list and cached ownership of one session', async () => {
  const f = fixture('indexed')
  useSections.setState({ byId: { [f.sectionId]: { ...f.section, bot: 'other' } } })
  await f.retry()
  expect(f.transcript()?.sectionId).toBeUndefined()
  expect(f.transcript()?.retryResolved).toBeUndefined()
  expect(f.status()).toEqual({ section: 'stopped', bot: 'stopped' })
})

it.each(['indexed', 'cached'] as const)(
  'does not transfer an unknown session marker to an exact %s retry cause',
  lookup => {
    const f = fixture(lookup)
    f.event('message.start', { retry_resolved: true }, 'unknown-live')
    f.event('status.update', { kind: 'working', text: 'Working' }, 'unknown-live')
    expect(useTranscripts.getState().bySession['unknown-live']?.sectionId).toBeUndefined()
    expect(f.status()).toEqual({ section: 'stopped', bot: 'stopped' })
  }
)

it('rejects a live id assigned to two indexed sections', async () => {
  const f = fixture('indexed')
  useSections.setState(state => ({
    byId: { ...state.byId, other: { ...f.section, id: 'other' } },
    liveSessionId: { ...state.liveSessionId, other: f.sessionId }
  }))
  await f.retry()
  expect(f.transcript()?.sectionId).toBeUndefined()
  expect(f.transcript()?.retryResolved).toBeUndefined()
  expect(f.status()).toEqual({ section: 'stopped', bot: 'stopped' })
})

it('preserves an existing room identity while keeping its room Stopped cause', async () => {
  const f = fixture('cached')
  useBots.setState({
    byName: {
      owl: {
        ...f.stopped,
        status_detail: { ...f.stopped.status_detail!, section_id: null, room_id: 'r' }
      }
    }
  })
  useTranscripts.getState().open(f.sessionId, 'room:r', [], undefined, 'owl')
  await f.retry()
  expect(f.transcript()).toMatchObject({ sectionId: 'room:r', bot: 'owl', retryResolved: true })
  expect(f.status().bot).toBe('stopped')
})
