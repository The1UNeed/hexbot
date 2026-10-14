import { render } from '@testing-library/react'
import { createElement } from 'react'

import { StatusDot } from '../components/ui/status-dot'
import { routeEvent } from '../lib/events'
import { setActiveRpc } from '../lib/rpc'
import type { Bot, Room, Section } from '../lib/types'

import { useBots } from './bots'
import { useRooms } from './rooms'
import { botStatusWithLive, clearDeletedSections, liveSectionsOf, useSections } from './sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

let sequence = 0

function fixture(
  cause: 'native' | 'named' = 'native',
  transcript: 'bound' | 'missing' | 'unbound' = 'bound'
) {
  const roomId = `retry-room-${++sequence}`
  const sessionId = `retry-live-${sequence}`
  const storedId = `stored-room-session-${sequence}`

  const room = {
    id: roomId,
    archived_at: null,
    turns: [{ bot: 'owl', live_session_id: sessionId }]
  } as Room

  const stopped = {
    name: 'owl',
    status: 'stopped',
    status_detail: {
      section_id: storedId,
      session_id: sessionId,
      room_id: cause === 'named' ? roomId : null,
      action: { kind: 'retry' }
    }
  } as Bot

  const state = { failBots: true, bot: stopped, heldBot: null as Promise<unknown> | null }
  clearDeletedSections()
  useSections.setState({ byId: {}, idsByBot: {}, liveSessionId: {} })
  useBots.setState({ byName: { owl: stopped }, order: ['owl'] })
  useRooms.setState({
    byId: { [roomId]: room },
    liveTurnsByRoom: {},
    eventsByRoom: {},
    order: [roomId]
  })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  setActiveRpc({
    call: vi.fn(async (method: string) => {
      if (method === 'hexbot.sections.list') {
        return {
          sections: [
            {
              id: 'private',
              bot: 'owl',
              peer_bot: 'cat',
              archived_at: null,
              live_session_id: 'private-live'
            }
          ]
        }
      }

      if (method === 'hexbot.rooms.delete') {
        return { deleted: true }
      }

      if (method === 'hexbot.bots.list') {
        if (state.heldBot) {
          return state.heldBot
        }

        if (state.failBots) {
          throw new Error('Read unavailable')
        }

        return { bots: [state.bot] }
      }

      return {}
    })
  } as never)

  const event = (type: string, payload: Record<string, unknown> = {}, live = sessionId) =>
    routeEvent({ type, session_id: live, payload } as never, { refreshBots: vi.fn() })

  const turn = (live = sessionId, bot = 'owl', id = roomId, status = 'running') =>
    event('hexbot.rooms.turn', { room_id: id, bot, live_session_id: live, status })

  turn()

  if (transcript !== 'bound') {
    useTranscripts.setState({ bySession: {} })

    if (transcript === 'unbound') {
      event('session.usage', { usage: { total_tokens: 1 } })
    }
  }

  const current = () => useTranscripts.getState().bySession[sessionId]

  const status = (name = 'owl') => {
    const sessions = useTranscripts.getState().bySession

    return botStatusWithLive(
      useBots.getState().byName[name]!,
      Object.values(useSections.getState().byId).filter(section => section.bot === name),
      liveSectionsOf(sessions),
      sessions
    )
  }

  const retry = async (marked = true, live = sessionId) => {
    // rooms.execute sends running before runner.run emits agent_start frames.
    event('message.start', marked ? { retry_resolved: true } : {}, live)
    event('status.update', { kind: 'working', text: 'Working' }, live)
    await useBots.getState().refresh()
  }

  return { current, event, retry, room, roomId, sessionId, status, stopped, storedId, state, turn }
}

afterEach(() => {
  resetTranscriptEffects()
  setActiveRpc(null)
})

describe.each(['native', 'named'] as const)('%s room retry cause', cause => {
  it.each(['bound', 'missing', 'unbound'] as const)(
    'shows Working for an exact current retry with a %s transcript after failed refresh',
    async transcript => {
      const f = fixture(cause, transcript)
      expect(f.status()).toBe('stopped')
      await f.retry()
      const view = render(createElement(StatusDot, { status: f.status() }))
      expect(view.getByRole('img', { name: 'Working' })).toBeVisible()
      expect(view.queryByRole('img', { name: 'Stopped' })).toBeNull()
      expect(f.current()).toMatchObject({
        sectionId: `room:${f.roomId}`,
        bot: 'owl',
        retryResolved: true
      })
      view.unmount()
    }
  )

  it('does not resolve a failure from an unmarked room start', async () => {
    const f = fixture(cause)
    await f.retry(false)
    expect(f.status()).toBe('stopped')
  })

  it.each(['other SID', 'other room', 'other bot'] as const)(
    'rejects a marker belonging to %s',
    async boundary => {
      const f = fixture(cause)

      if (boundary === 'other room') {
        f.turn('elsewhere-live', 'owl', 'elsewhere')
      }

      if (boundary === 'other bot') {
        f.turn('elsewhere-live', 'fox')
      }

      await f.retry(true, boundary === 'other SID' ? 'old-live' : 'elsewhere-live')
      expect(f.status()).toBe('stopped')
    }
  )

  it.each(['connector', 'global', 'private'] as const)(
    'preserves an unrelated %s stopped cause',
    async boundary => {
      const f = fixture(cause)
      const detail = { ...f.stopped.status_detail! }

      if (boundary === 'connector') {
        detail.action = { kind: 'fix_connector', connector: 'mail' }
      }

      if (boundary === 'global') {
        detail.section_id = null
        detail.room_id = null
        detail.session_id = null
      }

      if (boundary === 'private') {
        detail.section_id = 'private'
        detail.room_id = null
        useSections.setState({
          byId: { private: { id: 'private', bot: 'owl', archived_at: null } as Section }
        })
      }

      useBots.setState({ byName: { owl: { ...f.stopped, status_detail: detail } } })
      await f.retry()
      expect(f.status()).toBe('stopped')
    }
  )

  it.each(['approval', 'clarify'] as const)(
    'keeps a pending %s sibling above Working',
    async kind => {
      const f = fixture(cause)
      f.turn('sibling-live', 'owl', 'sibling')
      f.event(
        `${kind}.request`,
        { request_id: 'pending', question: 'Continue?', bot: 'owl', section_id: 'sibling-stored' },
        'sibling-live'
      )
      await f.retry()
      expect(f.status()).toBe('needs_you')
      expect(useTranscripts.getState().bySession['sibling-live']?.waitingRequests).toHaveLength(1)
    }
  )

  it('keeps pending private siblings above Working', async () => {
    const f = fixture(cause)
    useTranscripts.getState().open('private-live', 'private', [], undefined, 'owl')
    f.event(
      'clarify.request',
      { request_id: 'pending', question: 'Continue?', bot: 'owl', section_id: 'private' },
      'private-live'
    )
    await f.retry()
    expect(f.status()).toBe('needs_you')
  })

  it.each(['before', 'after'] as const)(
    'uses exact raw bot proof despite a shared virtual room key inserted %s',
    async order => {
      const f = fixture(cause)

      const fox = {
        name: 'fox',
        status: 'stopped',
        status_detail: {
          room_id: f.roomId,
          section_id: 'fox-stored',
          session_id: 'fox-live',
          action: { kind: 'retry' }
        }
      } as Bot

      useBots.setState({ byName: { owl: f.stopped, fox } })

      if (order === 'before') {
        f.turn('fox-live', 'fox')
      }

      await f.retry()

      if (order === 'after') {
        f.turn('fox-live', 'fox')
      }

      f.event(
        'clarify.request',
        { request_id: 'fox-wait', question: 'Choose?', bot: 'fox', section_id: 'fox-stored' },
        'fox-live'
      )
      expect(f.status()).toBe('working')
      expect(f.status('fox')).toBe('stopped')
    }
  )

  it.each(['complete', 'error', 'failed complete', 'new incident'] as const)(
    'handles %s while the exact current turn is known',
    async transition => {
      const f = fixture(cause)
      await f.retry()

      if (transition === 'complete') {
        f.event('message.complete', { text: 'Done' })
      }

      if (transition === 'error') {
        f.event('error', { message: 'Failed again' })
      }

      if (transition === 'failed complete') {
        f.event('message.complete', { error: 'Failed again', status: 'error' })
      }

      if (transition === 'new incident') {
        f.event('hexbot.bots.incident', {
          bot: 'owl',
          section_id: f.storedId,
          session_id: f.sessionId,
          incident: { text: 'Failed again', id: 'new-failure' }
        })
      }

      expect(f.status()).toBe(transition === 'complete' ? 'idle' : 'stopped')

      if (transition !== 'complete') {
        await f.retry()
        expect(f.status()).toBe('working')
      }
    }
  )

  it('allows old Stopped reads to finish without retiring newer retry proof', async () => {
    const f = fixture(cause)
    let resolve!: (value: unknown) => void
    f.state.heldBot = new Promise(done => {
      resolve = done
    })
    const read = useBots.getState().refresh()
    f.event('message.start', { retry_resolved: true })
    f.event('status.update', { kind: 'working', text: 'Working' })
    resolve({ bots: [f.stopped] })
    await read
    expect(f.status()).toBe('working')
  })

  it('retires room retry proof after a fresh exact Stopped roster', async () => {
    const f = fixture(cause)
    await f.retry()
    f.state.failBots = false
    await useBots.getState().refresh()
    expect(f.current()?.retryResolved).toBeUndefined()
    expect(f.status()).toBe('stopped')
  })

  it('excludes an archived room from retry authority', async () => {
    const f = fixture(cause)
    useRooms.setState({ byId: { [f.roomId]: { ...f.room, archived_at: 1 } } })
    await f.retry()
    expect(f.status()).toBe('stopped')
    expect(f.current()?.sectionId).toBe(`room:${f.roomId}`)
  })

  it('does not infer room identity from a cached cause after deletion', async () => {
    const f = fixture(cause)
    f.event('hexbot.rooms.changed', { id: f.roomId, deleted: true })
    await f.retry(true, cause === 'native' ? 'unknown-after-delete' : f.sessionId)
    expect(f.status()).toBe('stopped')
  })

  it('supports an exact known current turn even while room metadata is missing', async () => {
    const f = fixture(cause, 'missing')
    useRooms.setState({ byId: {} })
    await f.retry()
    expect(f.status()).toBe('working')
  })

  it('drops retry proof on epoch cleanup instead of applying it to the new process', async () => {
    const f = fixture(cause)
    await f.retry()
    useSections.getState().clearLive()
    expect(f.status()).toBe('stopped')
    f.turn('new-live')
    expect(f.status()).toBe('stopped')
  })
})

it('uses current room retry proof when a named old failure SID was reopened', async () => {
  const f = fixture('named')
  useBots.setState({
    byName: {
      owl: { ...f.stopped, status_detail: { ...f.stopped.status_detail!, session_id: 'old-live' } }
    }
  })
  await f.retry()
  expect(f.status()).toBe('working')
})

it('uses current named room retry proof when cached detail has no live SID', async () => {
  const f = fixture('named')
  useBots.setState({
    byName: {
      owl: { ...f.stopped, status_detail: { ...f.stopped.status_detail!, session_id: null } }
    }
  })
  await f.retry()
  expect(f.status()).toBe('working')
})

it('keeps an unknown null-room cause with an old SID until its room can be proven', async () => {
  const f = fixture('native')
  useBots.setState({
    byName: {
      owl: { ...f.stopped, status_detail: { ...f.stopped.status_detail!, session_id: 'old-live' } }
    }
  })
  await f.retry()
  expect(f.status()).toBe('stopped')
})

it('does not use another bot’s current room marker for a cached retry cause', async () => {
  const f = fixture('named')
  const sessions = useTranscripts.getState().bySession
  useTranscripts.setState({
    bySession: { ...sessions, [f.sessionId]: { ...sessions[f.sessionId]!, bot: 'fox' } }
  })
  await f.retry()
  expect(f.status()).toBe('stopped')
})

it('does not treat current room stored-session metadata as a private section', async () => {
  const f = fixture('native', 'missing')
  await f.retry()
  expect(f.current()?.sectionId).toBe(`room:${f.roomId}`)
  expect(liveSectionsOf(useTranscripts.getState().bySession)[f.storedId]).toBeUndefined()
})

describe.each(['native', 'named'] as const)('%s completed room retry', cause => {
  it('keeps Idle through successful message completion and native terminal room events', async () => {
    const f = fixture(cause)
    await f.retry()
    f.event('message.complete', { text: 'Done', status: 'complete' })
    f.turn(f.sessionId, 'owl', f.roomId, 'complete')
    f.event('hexbot.rooms.event', {
      room_id: f.roomId,
      event: {
        room_id: f.roomId,
        actor_id: 'owl',
        actor_kind: 'bot',
        kind: 'message.bot',
        seq: 2,
        created_at: 2,
        payload: { text: 'Done' }
      }
    })
    await useBots.getState().refresh()
    expect(useRooms.getState().liveTurnsByRoom[f.roomId]?.owl).toBeUndefined()
    expect(f.current()?.retryResolved).toBe(true)
    expect(f.status()).toBe('idle')
  })

  it.each(['failed', 'stopped'] as const)(
    'retires completed proof after a %s terminal',
    async terminal => {
      const f = fixture(cause)
      await f.retry()
      f.event('message.complete', { text: 'Done', status: 'complete' })
      f.turn(f.sessionId, 'owl', f.roomId, 'complete')
      f.turn(f.sessionId, 'owl', f.roomId, terminal)
      expect(f.current()).toBeUndefined()
      expect(f.status()).toBe('stopped')
    }
  )

  it.each(['archived', 'deleted'] as const)(
    'excludes completed proof when the room is %s',
    async boundary => {
      const f = fixture(cause)
      await f.retry()
      f.event('message.complete', { text: 'Done', status: 'complete' })
      f.turn(f.sessionId, 'owl', f.roomId, 'complete')

      if (boundary === 'archived') {
        useRooms.setState({ byId: { [f.roomId]: { ...f.room, archived_at: 1 } } })
      } else {
        f.event('hexbot.rooms.changed', { id: f.roomId, deleted: true })
      }

      expect(f.status()).toBe('stopped')

      if (boundary === 'deleted') {
        expect(f.current()).toBeUndefined()
      }
    }
  )

  it('preserves accepted completed proof across the connection activity reset', async () => {
    const f = fixture(cause)
    await f.retry()
    f.event('message.complete', { text: 'Done', status: 'complete' })
    f.turn(f.sessionId, 'owl', f.roomId, 'complete')
    useTranscripts.getState().clearAnsweredWaiting(undefined, undefined, undefined, {
      preserveWaiting: true,
      preserveRetryResolved: true
    })
    expect(f.current()?.retryResolved).toBe(true)
    expect(f.status()).toBe('idle')
    useSections.getState().clearLive()
    expect(f.status()).toBe('stopped')
  })
})

it.each(['complete', 'failed', 'stopped'] as const)(
  'does not let an old %s SID drop a newer room turn',
  async terminal => {
    const f = fixture('named')
    await f.retry()
    f.event('message.complete', { text: 'Done', status: 'complete' })
    f.turn(f.sessionId, 'owl', f.roomId, 'complete')
    f.turn('new-live')
    expect(f.current()).toBeUndefined()
    await f.retry(true, 'new-live')
    f.turn(f.sessionId, 'owl', f.roomId, terminal)
    expect(useRooms.getState().liveTurnsByRoom[f.roomId]?.owl?.live_session_id).toBe('new-live')
    expect(useTranscripts.getState().bySession['new-live']?.retryResolved).toBe(true)
    expect(f.status()).toBe('working')
  }
)

it('retires completed proof before an unmarked newer room turn', async () => {
  const f = fixture('named')
  await f.retry()
  f.event('message.complete', { text: 'Done', status: 'complete' })
  f.turn(f.sessionId, 'owl', f.roomId, 'complete')
  f.turn('new-live')
  await f.retry(false, 'new-live')
  expect(f.current()).toBeUndefined()
  expect(f.status()).toBe('stopped')
})

it('allows fresh named room failure authority to retire old completed proof even with a different live SID', async () => {
  const f = fixture('named')
  await f.retry()
  f.event('message.complete', { text: 'Done', status: 'complete' })
  f.turn(f.sessionId, 'owl', f.roomId, 'complete')
  f.state.failBots = false
  f.state.bot = {
    ...f.stopped,
    status_detail: { ...f.stopped.status_detail!, session_id: 'new-failed-live' }
  }
  await useBots.getState().refresh()
  expect(f.current()?.retryResolved).toBeUndefined()
  expect(f.status()).toBe('stopped')
})

it('retires completed proof when a trusted new room attempt cannot open a live session', async () => {
  const f = fixture('named')
  await f.retry()
  f.event('message.complete', { text: 'Done', status: 'complete' })
  f.turn(f.sessionId, 'owl', f.roomId, 'complete')
  f.event('hexbot.rooms.turn', {
    room_id: f.roomId,
    bot: 'owl',
    live_session_id: null,
    status: 'running'
  })
  f.event('hexbot.rooms.turn', {
    room_id: f.roomId,
    bot: 'owl',
    live_session_id: null,
    status: 'failed'
  })
  expect(f.current()).toBeUndefined()
  expect(f.status()).toBe('stopped')
})

it('does not let an ambiguous null terminal drop a current live retry', async () => {
  const f = fixture('named')
  await f.retry()
  f.event('hexbot.rooms.turn', {
    room_id: f.roomId,
    bot: 'owl',
    live_session_id: null,
    status: 'failed'
  })
  expect(f.current()?.retryResolved).toBe(true)
  expect(useRooms.getState().liveTurnsByRoom[f.roomId]?.owl?.live_session_id).toBe(f.sessionId)
  expect(f.status()).toBe('working')
})

it.each(['archived', 'deleted'] as const)(
  'rejects buffered old running and retry frames after the room is %s',
  async boundary => {
    const f = fixture('named')

    if (boundary === 'archived') {
      useRooms.setState({ byId: { [f.roomId]: { ...f.room, archived_at: 1 } } })
    } else {
      f.event('hexbot.rooms.changed', { id: f.roomId, deleted: true })
    }

    f.turn()
    await f.retry()
    expect(f.status()).toBe('stopped')

    if (boundary === 'deleted') {
      expect(useRooms.getState().liveTurnsByRoom[f.roomId]).toBeUndefined()
    }
  }
)

it('fences a buffered running turn after successful room removal, then allows a new daemon to bind it', async () => {
  const f = fixture('named')
  await f.retry()
  await useRooms.getState().remove(f.roomId)
  f.turn()
  await f.retry()
  expect(f.status()).toBe('stopped')
  expect(useRooms.getState().liveTurnsByRoom[f.roomId]).toBeUndefined()
  useSections.getState().clearLive()
  f.turn()
  await f.retry()
  expect(f.status()).toBe('working')
})

it.each(['list', 'log', 'get'] as const)(
  'does not restore deleted room retry ownership from an in-flight %s read',
  async stage => {
    const f = fixture('named')
    await f.retry()
    let resolve!: (value: unknown) => void

    const held = new Promise(done => {
      resolve = done
    })

    const call = vi.fn(async (method: string) => {
      if (method === `hexbot.rooms.${stage}`) {
        return held
      }

      if (method === 'hexbot.rooms.list') {
        return { rooms: [f.room] }
      }

      if (method === 'hexbot.rooms.log') {
        return { events: [] }
      }

      throw new Error('Bot refresh unavailable')
    })

    setActiveRpc({ call } as never)

    const reading =
      stage === 'get' ? useRooms.getState().refreshOne(f.roomId) : useRooms.getState().refresh()

    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith(`hexbot.rooms.${stage}`, expect.anything())
    )
    useRooms.getState().drop(f.roomId)
    resolve(
      stage === 'list' ? { rooms: [f.room] } : stage === 'get' ? { room: f.room } : { events: [] }
    )
    await reading
    f.turn()
    await f.retry()
    expect(useRooms.getState().byId[f.roomId]).toBeUndefined()
    expect(useRooms.getState().liveTurnsByRoom[f.roomId]).toBeUndefined()
    expect(f.status()).toBe('stopped')
  }
)

it.each([
  ['global', false],
  ['global', true],
  ['empty section', false],
  ['empty section', true],
  ['indexed private section', false],
  ['indexed private section', true]
] as const)(
  'preserves a named room %s Stopped cause with completed retry=%s',
  async (cause, completed) => {
    const f = fixture('named')
    const sectionId = cause === 'global' ? null : cause === 'empty section' ? '' : 'private-section'
    const detail = { ...f.stopped.status_detail!, section_id: sectionId }
    useBots.setState({ byName: { owl: { ...f.stopped, status_detail: detail } } })

    if (cause === 'indexed private section') {
      useSections.setState({
        byId: {
          'private-section': { id: 'private-section', bot: 'owl', archived_at: null } as Section
        },
        idsByBot: { owl: ['private-section'] },
        liveSessionId: { 'private-section': 'private-live' }
      })
    }

    // agent_start resolves turn_failed by its stored section, not a global or private cause.
    await f.retry()
    expect(f.current()?.retryResolved).toBe(true)
    expect(f.status()).toBe('stopped')

    if (completed) {
      f.event('message.complete', { text: 'Done', status: 'complete' })
      f.turn(f.sessionId, 'owl', f.roomId, 'complete')
      expect(f.current()?.retryResolved).toBe(true)
      expect(f.status()).toBe('stopped')
    }
  }
)
