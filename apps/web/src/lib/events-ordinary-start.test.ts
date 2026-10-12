import type { GatewayEvent } from '@hermes/shared'

import { useBots } from '../stores/bots'
import { useRooms } from '../stores/rooms'
import {
  botStatusWithLive,
  clearDeletedSections,
  liveSectionsOf,
  useSections
} from '../stores/sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from '../stores/transcripts'

import { routeEvent } from './events'
import { setActiveRpc } from './rpc'
import type { Bot, Section } from './types'

let sequence = 0

function fixture(indexed: boolean) {
  const sectionId = `ordinary-section-${++sequence}`
  const sessionId = `ordinary-live-${sequence}`

  const section = {
    id: sectionId,
    bot: 'owl',
    archived_at: null,
    live_session_id: sessionId
  } as Section

  const bot = { name: 'owl', status: 'idle', status_detail: null } as Bot
  clearDeletedSections()
  useBots.setState({ byName: { owl: bot }, order: ['owl'] })
  useSections.setState({
    byId: indexed ? { [sectionId]: section } : {},
    idsByBot: indexed ? { owl: [sectionId] } : {},
    liveSessionId: {}
  })
  useRooms.setState({ byId: {}, liveTurnsByRoom: {} })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  setActiveRpc({
    call: vi.fn(async () => {
      throw new Error('Read unavailable')
    })
  } as never)

  const event = (type: string, payload: Record<string, unknown> = {}, live = sessionId) =>
    routeEvent({ type, session_id: live, payload } as GatewayEvent)

  const start = (
    payload = { bot: 'owl', section_id: sectionId, room_id: null } as Record<string, unknown>
  ) => {
    event('message.start', payload)
    event('status.update', { kind: 'working', text: 'Working' })
  }

  const status = () => {
    const transcripts = useTranscripts.getState().bySession

    return botStatusWithLive(
      useBots.getState().byName.owl!,
      Object.values(useSections.getState().byId),
      liveSectionsOf(transcripts),
      transcripts
    )
  }

  return { bot, event, section, sectionId, sessionId, start, status }
}

afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

describe.each([false, true])('ordinary starts with indexed=%s', indexed => {
  it.each([false, true])(
    'projects an unopened private turn with retry marker=%s when reads fail',
    async marked => {
      const f = fixture(indexed)
      f.start({
        bot: 'owl',
        section_id: f.sectionId,
        room_id: null,
        ...(marked ? { retry_resolved: true } : {})
      })
      await useBots.getState().refresh()
      expect(f.status()).toBe('working')
      expect(useBots.getState().byName.owl?.status).toBe('idle')
      expect(useSections.getState().liveSessionId[f.sectionId]).toBe(f.sessionId)
      expect(useTranscripts.getState().bySession[f.sessionId]).toMatchObject({
        bot: 'owl',
        sectionId: f.sectionId
      })
      f.event('message.complete', { text: 'Finished' })
      expect(f.status()).toBe('idle')
    }
  )

  it('keeps a confirmed sibling card ahead of ordinary Working', () => {
    const f = fixture(indexed)
    useTranscripts.getState().open('sibling-live', 'sibling', [], undefined, 'owl')
    useSections.setState(state => ({
      byId: {
        ...state.byId,
        sibling: { ...f.section, id: 'sibling', live_session_id: 'sibling-live' }
      },
      liveSessionId: { sibling: 'sibling-live' }
    }))
    f.event(
      'approval.request',
      { request_id: 'sibling-card', choices: ['once', 'deny'] },
      'sibling-live'
    )
    f.start()
    expect(f.status()).toBe('needs_you')
  })
})

it.each([
  {},
  { bot: 'owl', section_id: 'unverified' },
  { bot: 'owl', section_id: 'unverified', room_id: 'room' },
  { bot: 'owl', section_id: 'room:room', room_id: null },
  { bot: '', section_id: 'unverified', room_id: null }
])('does not infer private ownership from incomplete or room metadata %j', payload => {
  const f = fixture(false)
  f.start(payload)
  expect(f.status()).toBe('idle')
  expect(useSections.getState().liveSessionId).toEqual({})
})

it.each(['archived', 'deleted', 'foreign', 'newer session'] as const)(
  'preserves %s ownership guards',
  guard => {
    const f = fixture(true)

    if (guard === 'archived') {
      useSections.setState({ byId: { [f.sectionId]: { ...f.section, archived_at: 1 } } })
    }

    if (guard === 'deleted') {
      useSections.getState().drop(f.sectionId, 'owl')
    }

    if (guard === 'foreign') {
      useSections.setState({ byId: { [f.sectionId]: { ...f.section, bot: 'cat' } } })
    }

    if (guard === 'newer session') {
      useSections.setState({ liveSessionId: { [f.sectionId]: 'newer-live' } })
    }

    f.start()
    expect(f.status()).toBe('idle')
    expect(useSections.getState().liveSessionId[f.sectionId]).not.toBe(f.sessionId)
  }
)

it('does not replace a newer cached section session when its binding is absent', () => {
  const f = fixture(true)
  useSections.setState({ byId: { [f.sectionId]: { ...f.section, live_session_id: 'newer-live' } } })
  f.start()
  expect(f.status()).toBe('idle')
  expect(useSections.getState().liveSessionId[f.sectionId]).toBeUndefined()
})

it('retains ordinary activity over a roster captured before its start', async () => {
  const f = fixture(false)
  let resolve!: (value: unknown) => void

  const response = new Promise(done => {
    resolve = done
  })

  setActiveRpc({
    call: vi.fn(async (method: string) => (method === 'hexbot.bots.list' ? response : {}))
  } as never)
  const refreshing = useBots.getState().refresh()
  f.start()
  resolve({ bots: [f.bot] })
  await refreshing
  expect(f.status()).toBe('working')
})

it('retires ordinary activity when a later roster confirms Idle', async () => {
  const f = fixture(false)
  f.start()
  setActiveRpc({
    call: vi.fn(async (method: string) => (method === 'hexbot.bots.list' ? { bots: [f.bot] } : {}))
  } as never)
  await useBots.getState().refresh()
  expect(f.status()).toBe('idle')
})

it('fences a held older section snapshot after a confirmed start', async () => {
  const f = fixture(true)
  let resolve!: (value: unknown) => void

  const response = new Promise(done => {
    resolve = done
  })

  setActiveRpc({
    call: vi.fn(async (method: string) => {
      if (method === 'hexbot.sections.list') {
        return response
      }
      throw new Error('Read unavailable')
    })
  } as never)
  const refreshing = useSections.getState().refresh()
  f.start()
  resolve({ sections: [{ ...f.section, live_session_id: 'old-live' }] })
  await refreshing
  expect(useSections.getState().liveSessionId[f.sectionId]).toBe(f.sessionId)
  expect(f.status()).toBe('working')
})

it('does not move a transcript already assigned to another owner', () => {
  const f = fixture(false)
  useTranscripts.getState().open(f.sessionId, 'other-section', [], undefined, 'cat')
  f.start()
  expect(useTranscripts.getState().bySession[f.sessionId]).toMatchObject({
    sectionId: 'other-section',
    bot: 'cat'
  })
  expect(f.status()).toBe('idle')
})

it('accepts a fresh start after a verified session rollover', async () => {
  const f = fixture(true)
  f.start()
  setActiveRpc({
    call: vi.fn(async (method: string) => {
      if (method === 'hexbot.sections.list') {
        return { sections: [{ ...f.section, live_session_id: 'newer-live' }] }
      }

      throw new Error('Read unavailable')
    })
  } as never)
  await useSections.getState().verifySessionOwner(f.sessionId, true)
  expect(useSections.getState().liveSessionId[f.sectionId]).toBe('newer-live')
  f.event('message.start', { bot: 'owl', section_id: f.sectionId, room_id: null }, 'newer-live')
  f.event('status.update', { kind: 'working', text: 'Working' }, 'newer-live')
  expect(f.status()).toBe('working')
  expect(useTranscripts.getState().bySession['newer-live']).toMatchObject({
    bot: 'owl',
    sectionId: f.sectionId
  })
  // A delayed event from the old turn cannot reclaim the accepted new binding.
  f.start()
  expect(useSections.getState().liveSessionId[f.sectionId]).toBe('newer-live')
})
