import { routeEvent } from '../lib/events'
import { setActiveRpc } from '../lib/rpc'
import type { Bot, Section } from '../lib/types'

import { useBots } from './bots'
import { useRooms } from './rooms'
import {
  botStatusWithLive,
  clearDeletedSections,
  liveSectionsOf,
  sectionStatusOf,
  useSections
} from './sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

let sequence = 0

async function fixture(rollover = true) {
  const id = `private-retry-${++sequence}`
  const live = `new-${id}`

  const stopped = {
    name: 'owl',
    status: 'stopped',
    status_detail: {
      section_id: id,
      session_id: rollover ? `old-${id}` : live,
      room_id: null,
      action: { kind: 'retry' }
    }
  } as Bot

  const section = {
    id,
    bot: 'owl',
    title: 'Private',
    archived_at: null,
    live_session_id: live
  } as Section

  const state = { failedRead: true, roster: stopped }
  clearDeletedSections()
  useTranscripts.getState().dropAll()
  useRooms.setState({ byId: {}, liveTurnsByRoom: {} })
  useSections.setState({ byId: {}, idsByBot: {}, liveSessionId: {} })
  useBots.setState({ byName: { owl: stopped }, order: ['owl'] })
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  setActiveRpc({
    call: vi.fn(async (method: string) => {
      if (method === 'hexbot.sections.open') {
        return { section, messages: [] }
      }

      if (method === 'hexbot.bots.list' && !state.failedRead) {
        return { bots: [state.roster] }
      }

      throw new Error('Read unavailable')
    })
  } as never)
  await useSections.getState().open(id)

  const event = (type: string, payload: Record<string, unknown> = {}, sessionId = live) =>
    routeEvent({ type, session_id: sessionId, payload } as never)

  const status = () => {
    const sessions = useTranscripts.getState().bySession
    const projection = liveSectionsOf(sessions)
    const bot = useBots.getState().byName.owl!

    return {
      bot: botStatusWithLive(bot, [section], projection, sessions),
      section: sectionStatusOf(bot, id, projection)
    }
  }

  const retry = async (marker: unknown = true, sessionId = live) => {
    event('message.start', { retry_resolved: marker }, sessionId)
    event('status.update', { kind: 'working', text: 'Working' }, sessionId)
    await useBots.getState().refresh()
  }

  return { id, live, stopped, section, state, event, retry, status }
}

afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

it.each([false, true])(
  'resolves the same stored private section after actual open changes its live SID=%s',
  async rollover => {
    const f = await fixture(rollover)
    await f.retry()
    expect(useSections.getState().liveSessionId[f.id]).toBe(f.live)
    expect(f.status()).toEqual({ bot: 'working', section: 'working' })
  }
)

it.each([
  'no current mapping',
  'unlisted',
  'other bot',
  'other section',
  'different current SID',
  'old marker SID',
  'unmarked',
  'string marker'
] as const)('does not broaden private rollover authority for %s', async boundary => {
  const f = await fixture()

  if (boundary === 'no current mapping') {
    useSections.setState({ liveSessionId: {} })
  }

  if (boundary === 'unlisted') {
    useSections.setState({ byId: {}, idsByBot: {}, liveSessionId: {} })
  }

  if (boundary === 'other bot') {
    useSections.setState({ byId: { [f.id]: { ...f.section, bot: 'fox' } } })
  }

  if (boundary === 'other section') {
    useBots.setState({
      byName: {
        owl: { ...f.stopped, status_detail: { ...f.stopped.status_detail!, section_id: 'other' } }
      }
    })
  }

  if (boundary === 'different current SID') {
    useSections.setState({ liveSessionId: { [f.id]: 'different-live' } })
  }

  await f.retry(
    boundary === 'unmarked' ? false : boundary === 'string marker' ? 'true' : true,
    boundary === 'old marker SID' ? f.stopped.status_detail!.session_id! : f.live
  )
  expect(f.status().bot).toBe('stopped')
})

it.each(['old failure SID', 'current failure SID'] as const)(
  'lets fresh private %s authority retire rollover proof',
  async cause => {
    const f = await fixture()
    await f.retry()
    f.state.failedRead = false
    f.state.roster = {
      ...f.stopped,
      status_detail: {
        ...f.stopped.status_detail!,
        session_id: cause === 'old failure SID' ? f.stopped.status_detail!.session_id : f.live
      }
    }
    await useBots.getState().refresh()
    expect(useTranscripts.getState().bySession[f.live]?.retryResolved).toBeUndefined()
    expect(f.status()).toEqual({ bot: 'stopped', section: 'stopped' })
  }
)

it.each(['error', 'new epoch', 'delete'] as const)(
  'retires private rollover proof on %s',
  async boundary => {
    const f = await fixture()
    await f.retry()

    if (boundary === 'error') {
      f.event('error', { message: 'Failed again' })
    }

    if (boundary === 'new epoch') {
      useSections.getState().clearLive()
    }

    if (boundary === 'delete') {
      useSections.getState().drop(f.id, 'owl')
    }

    expect(f.status().bot).toBe(boundary === 'delete' ? 'idle' : 'stopped')
  }
)

it('does not let an old SID replay overwrite an accepted current private retry', async () => {
  const f = await fixture()
  await f.retry()
  await f.retry(true, f.stopped.status_detail!.session_id!)
  expect(f.status()).toEqual({ bot: 'working', section: 'working' })
})
