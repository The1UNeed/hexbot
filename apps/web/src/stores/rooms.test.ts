import type { GatewayEvent } from '@hermes/shared'
import { JsonRpcGatewayError } from '@hermes/shared'

import { routeEvent } from '../lib/events'
import { setActiveRpc } from '../lib/rpc'
import type { Room, RoomEvent } from '../lib/types'

import { useRooms } from './rooms'
import { useTranscripts } from './transcripts'

const event = (
  seq: number,
  kind: RoomEvent['kind'],
  payload: RoomEvent['payload'] = {}
): RoomEvent => ({
  actor_id: kind === 'message.bot' ? 'writer' : null,
  actor_kind: kind === 'message.bot' ? 'bot' : 'system',
  created_at: 1_700_000_000 + seq,
  kind,
  payload,
  room_id: 'room-1',
  seq
})

describe('rooms reducer', () => {
  beforeEach(() => {
    useRooms.setState({ byId: {}, eventsByRoom: {}, liveTurnsByRoom: {}, order: [] })
    useTranscripts.setState({ bySession: {} })
  })

  it('orders persisted events and replaces a live turn when the bot message arrives', () => {
    const rooms = useRooms.getState()
    rooms.handleEvent('room-1', event(2, 'waiting.human'))
    rooms.handleEvent('room-1', event(1, 'turn.started'))
    rooms.handleTurn({
      bot: 'writer',
      live_session_id: 'live-1',
      room_id: 'room-1',
      status: 'running'
    })
    routeEvent({
      payload: { text: 'Draft' },
      session_id: 'live-1',
      type: 'message.delta'
    } as GatewayEvent)

    expect(useTranscripts.getState().bySession['live-1']?.messages[0]?.text).toBe('Draft')
    rooms.handleEvent('room-1', event(3, 'message.bot', { text: 'Draft done' }))
    rooms.handleEvent('room-1', event(4, 'limit.tripped'))

    expect(useRooms.getState().eventsByRoom['room-1']?.map(item => item.kind)).toEqual([
      'turn.started',
      'waiting.human',
      'message.bot',
      'limit.tripped'
    ])
    expect(useRooms.getState().liveTurnsByRoom['room-1']).toEqual({})
  })

  it('rebuilds live turns on refresh, so a turn that ended offline stops working', async () => {
    const room = { id: 'room-1', members: [], name: 'Lab', turns: [] } as unknown as Room
    const rooms = useRooms.getState()
    rooms.handleTurn({ bot: 'writer', live_session_id: 'live-1', room_id: 'room-1', status: 'running' })
    rooms.handleTurn({ bot: 'scout', live_session_id: 'live-2', room_id: 'room-1', status: 'running' })
    room.turns = [{ bot: 'scout', live_session_id: 'live-2' }]
    setActiveRpc({
      call: vi.fn((method: string) =>
        Promise.resolve(method === 'hexbot.rooms.list' ? { rooms: [room] } : { events: [] })
      )
    } as never)

    await useRooms.getState().refresh()

    expect(Object.keys(useRooms.getState().liveTurnsByRoom['room-1'] ?? {})).toEqual(['scout'])
    expect(useTranscripts.getState().bySession['live-1']).toBeUndefined()
    expect(useTranscripts.getState().bySession['live-2']).toBeDefined()
  })

  it('keeps live turns when the daemon does not report running turns', async () => {
    const room = { id: 'room-1', members: [], name: 'Lab' } as unknown as Room
    useRooms
      .getState()
      .handleTurn({ bot: 'writer', live_session_id: 'live-1', room_id: 'room-1', status: 'running' })
    setActiveRpc({
      call: vi.fn((method: string) =>
        Promise.resolve(method === 'hexbot.rooms.list' ? { rooms: [room] } : { events: [] })
      )
    } as never)

    await useRooms.getState().refresh()

    expect(Object.keys(useRooms.getState().liveTurnsByRoom['room-1'] ?? {})).toEqual(['writer'])
    expect(useTranscripts.getState().bySession['live-1']).toBeDefined()
  })

  it('keeps a card that arrived after the last list when another turn changes during a refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)

    try {
      const turn = { bot: 'writer', live_session_id: 'live-1', room_id: 'room-1' }

      const room = (pending: string[]) =>
        ({
          id: 'room-1',
          members: [],
          name: 'Lab',
          turns: [{ ...turn, pending_requests: pending }]
        }) as unknown as Room

      let listed = Promise.resolve({ rooms: [room([])] })

      setActiveRpc({
        call: vi.fn((method: string) =>
          method === 'hexbot.rooms.list' ? listed : Promise.resolve({ events: [] })
        )
      } as never)

      await useRooms.getState().refresh()
      vi.setSystemTime(2_000)
      routeEvent({
        payload: { command: 'new', request_id: 'new' },
        session_id: 'live-1',
        type: 'approval.request'
      } as GatewayEvent)
      vi.setSystemTime(3_000)
      let answer!: (value: { rooms: Room[] }) => void
      listed = new Promise(resolve => (answer = resolve))
      const refreshing = useRooms.getState().refresh()
      // Another bot's turn changes while the list is read: the room keeps its
      // turns, whose saved list is older than the card.
      useRooms
        .getState()
        .handleTurn({ bot: 'scout', live_session_id: 'live-2', room_id: 'room-1', status: 'running' })
      answer({ rooms: [room(['new'])] })
      await refreshing

      expect(
        useTranscripts.getState().bySession['live-1']?.approvals.map(card => card.requestId)
      ).toEqual(['new'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a card the turn no longer waits on after a reconnect, keeping what still waits', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)

    try {
      const turn = { bot: 'writer', live_session_id: 'live-1', room_id: 'room-1' }
      useRooms.getState().handleTurn({ ...turn, status: 'running' })

      for (const id of ['answered-meanwhile', 'still-waiting']) {
        routeEvent({
          payload: { command: id, request_id: id },
          session_id: 'live-1',
          type: 'approval.request'
        } as GatewayEvent)
      }

      // Another app answered one while this one was offline; the same turn runs on.
      vi.setSystemTime(2_000)

      const room = {
        id: 'room-1',
        members: [],
        name: 'Lab',
        turns: [{ ...turn, pending_requests: ['still-waiting'] }]
      } as unknown as Room

      setActiveRpc({
        call: vi.fn((method: string) =>
          Promise.resolve(method === 'hexbot.rooms.list' ? { rooms: [room] } : { events: [] })
        )
      } as never)

      await useRooms.getState().refresh()

      expect(
        useTranscripts.getState().bySession['live-1']?.approvals.map(card => card.requestId)
      ).toEqual(['still-waiting'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not bring back a turn that ended while the refresh was loading', async () => {
    const room = { id: 'room-1', members: [], name: 'Lab' } as unknown as Room
    room.turns = [{ bot: 'writer', live_session_id: 'live-1' }]
    let release: (() => void) | undefined

    setActiveRpc({
      call: vi.fn((method: string) =>
        method === 'hexbot.rooms.list'
          ? Promise.resolve({ rooms: [room] })
          : new Promise(resolve => (release = () => resolve({ events: [] })))
      )
    } as never)

    const refreshing = useRooms.getState().refresh()
    await vi.waitFor(() => expect(release).toBeDefined())
    useRooms.getState().handleTurn({
      bot: 'writer',
      live_session_id: 'live-1',
      room_id: 'room-1',
      status: 'complete'
    })
    release!()
    await refreshing
    expect(useRooms.getState().liveTurnsByRoom['room-1']).toEqual({})
  })

  it('drops a deleted room, and one the daemon no longer shows you', async () => {
    const room = { id: 'room-1', members: [], name: 'Lab' } as unknown as Room
    useRooms.setState({ byId: { 'room-1': room, 'room-2': { ...room, id: 'room-2' } } })

    const call = vi.fn(() =>
      Promise.reject(new JsonRpcGatewayError('not the owner', { code: 4302 }))
    )

    setActiveRpc({ call } as never)

    routeEvent({ payload: { deleted: true, id: 'room-1' }, type: 'hexbot.rooms.changed' } as never)
    expect(useRooms.getState().byId['room-1']).toBeUndefined()
    expect(call).not.toHaveBeenCalled()

    // Deleted while offline: the room is gone on the next load, and read marks
    // never surface as unhandled errors.
    await useRooms.getState().markRead('room-2', 3)
    expect(useRooms.getState().byId['room-2']).toBeUndefined()
    useRooms.setState({ byId: { 'room-2': { ...room, id: 'room-2' } } })
    await useRooms.getState().open('room-2')
    expect(useRooms.getState().byId['room-2']).toBeUndefined()
    useRooms.setState({ byId: { 'room-2': { ...room, id: 'room-2' } } })
    await useRooms.getState().refreshOne('room-2')
    expect(useRooms.getState().byId['room-2']).toBeUndefined()
    expect(call).toHaveBeenCalledTimes(4)
  })

  it('hydrates active message_bot asks on running room turns for a cold client open or refresh', async () => {
    const runningRoom = {
      id: 'room-1',
      members: [],
      name: 'Lab',
      turns: [
        {
          asks: [
            {
              args: { text: 'Check data', to: 'biology', wait: true },
              context: 'biology',
              message_id: 'a1',
              section_id: 'th-bio',
              status: 'running' as const,
              tool_id: 'call_0',
              turn_id: 'T1'
            }
          ],
          bot: 'scout',
          live_session_id: 'live-scout'
        }
      ]
    } as unknown as Room

    setActiveRpc({
      call: vi.fn((method: string) =>
        Promise.resolve(
          method === 'hexbot.rooms.get'
            ? { room: runningRoom }
            : method === 'hexbot.rooms.list'
              ? { rooms: [runningRoom] }
              : { events: [] }
        )
      )
    } as never)

    await useRooms.getState().open('room-1')
    expect(useRooms.getState().liveTurnsByRoom['room-1']?.scout?.live_session_id).toBe('live-scout')
    expect(
      useTranscripts
        .getState()
        .bySession['live-scout']?.messages.flatMap(message => message.toolCalls)
    ).toMatchObject([
      {
        args: { to: 'biology', wait: true },
        messageId: 'a1',
        name: 'message_bot',
        result: { section_id: 'th-bio' },
        startedAt: 0,
        status: 'running',
        summary: 'biology',
        toolId: 'call_0'
      }
    ])

    // Completing live settles the hydrated running ask and a later stale refresh must not revert it.
    routeEvent({
      payload: {
        context: 'biology',
        message_id: 'a1',
        name: 'message_bot',
        result: { details: { section_id: 'th-bio', status: 'replied' } },
        tool_id: 'call_0',
        turn_id: 'T1'
      },
      session_id: 'live-scout',
      type: 'tool.complete'
    } as GatewayEvent)

    await useRooms.getState().refresh()
    expect(
      useTranscripts
        .getState()
        .bySession['live-scout']?.messages.flatMap(message => message.toolCalls)
    ).toMatchObject([
      {
        name: 'message_bot',
        result: { details: { section_id: 'th-bio', status: 'replied' } },
        status: 'ok',
        toolId: 'call_0'
      }
    ])

    // 2. Reconnect after Biology settled while Chemistry is now running: refresh merges Chemistry
    //    into the existing transcript while keeping Biology settled.
    const bioAndChemRoom = {
      ...runningRoom,
      turns: [
        {
          asks: [
            {
              args: { text: 'Check data', to: 'biology', wait: true },
              context: 'biology',
              message_id: 'a1',
              result: { details: { reply: 'Bio ok', section_id: 'th-bio' } },
              section_id: 'th-bio',
              status: 'ok' as const,
              tool_id: 'call_0',
              turn_id: 'T1'
            },
            {
              args: { text: 'Check chem', to: 'chemistry', wait: true },
              context: 'chemistry',
              message_id: 'a2',
              section_id: 'th-chem',
              status: 'running' as const,
              tool_id: 'call_1',
              turn_id: 'T1'
            }
          ],
          bot: 'scout',
          live_session_id: 'live-scout'
        }
      ]
    } as unknown as Room

    setActiveRpc({
      call: vi.fn((method: string) =>
        Promise.resolve(
          method === 'hexbot.rooms.list' ? { rooms: [bioAndChemRoom] } : { events: [] }
        )
      )
    } as never)

    await useRooms.getState().refresh()
    expect(
      useTranscripts
        .getState()
        .bySession['live-scout']?.messages.flatMap(message => message.toolCalls)
    ).toMatchObject([
      { name: 'message_bot', status: 'ok', summary: 'biology', toolId: 'call_0' },
      {
        args: { to: 'chemistry', wait: true },
        name: 'message_bot',
        result: { section_id: 'th-chem' },
        status: 'running',
        summary: 'chemistry',
        toolId: 'call_1'
      }
    ])

    // 3. Cold open where live Chemistry completion (or a live text delta) arrives before rooms.get
    //    resolves: snapshot's earlier Biology ask is prepended in order while Chemistry stays settled.
    useTranscripts.setState({ bySession: {} })
    useRooms.setState({ byId: {}, eventsByRoom: {}, liveTurnsByRoom: {}, order: [] })
    routeEvent({
      payload: { text: 'Checking ' },
      session_id: 'live-cold',
      type: 'message.delta'
    } as GatewayEvent)
    routeEvent({
      payload: {
        context: 'chemistry',
        message_id: 'a2',
        name: 'message_bot',
        result: { details: { reply: 'Chem ok', section_id: 'th-chem' } },
        tool_id: 'call_1',
        turn_id: 'T1'
      },
      session_id: 'live-cold',
      type: 'tool.complete'
    } as GatewayEvent)

    const coldRoom = {
      ...bioAndChemRoom,
      turns: [
        {
          ...bioAndChemRoom.turns![0]!,
          live_session_id: 'live-cold'
        }
      ]
    } as unknown as Room

    setActiveRpc({
      call: vi.fn((method: string) =>
        Promise.resolve(method === 'hexbot.rooms.get' ? { room: coldRoom } : { events: [] })
      )
    } as never)

    await useRooms.getState().open('room-1')
    expect(
      useTranscripts
        .getState()
        .bySession['live-cold']?.messages.flatMap(message => message.toolCalls)
    ).toMatchObject([
      { name: 'message_bot', status: 'ok', summary: 'biology', toolId: 'call_0' },
      { name: 'message_bot', status: 'ok', summary: 'chemistry', toolId: 'call_1' }
    ])

    // 4. Reconnecting to a new turn (T3) on the same live session resets the old turn's asks
    //    instead of showing Biology from T2 alongside Chemistry from T3.
    const nextTurnRoom = {
      ...runningRoom,
      turns: [
        {
          asks: [
            {
              args: { text: 'New question', to: 'chemistry', wait: true },
              context: 'chemistry',
              message_id: 'b1',
              occurrence_id: 'occ-chem-t3',
              status: 'running' as const,
              tool_id: 'call_0',
              turn_id: 'T3'
            }
          ],
          bot: 'scout',
          live_session_id: 'live-cold',
          turn_id: 'T3'
        }
      ]
    } as unknown as Room

    setActiveRpc({
      call: vi.fn((method: string) =>
        Promise.resolve(
          method === 'hexbot.rooms.list' ? { rooms: [nextTurnRoom] } : { events: [] }
        )
      )
    } as never)

    await useRooms.getState().refresh()
    expect(
      useTranscripts
        .getState()
        .bySession['live-cold']?.messages.flatMap(message => message.toolCalls)
    ).toMatchObject([{ name: 'message_bot', status: 'running', summary: 'chemistry', toolId: 'call_0' }])

    // 5. Merging a missing middle ask preserves exact snapshot order [biology, chemistry, physics].
    useTranscripts.getState().mergeTurnCalls(
      'live-order',
      'room:room-1',
      [
        {
          args: { to: 'biology', wait: true },
          durationS: null,
          name: 'message_bot',
          occurrenceId: 'occ-1',
          result: null,
          startedAt: 0,
          status: 'running',
          summary: 'biology',
          toolId: 'call_0'
        },
        {
          args: { to: 'physics', wait: true },
          durationS: null,
          name: 'message_bot',
          occurrenceId: 'occ-3',
          result: null,
          startedAt: 0,
          status: 'running',
          summary: 'physics',
          toolId: 'call_2'
        }
      ],
      'T-order'
    )
    useTranscripts.getState().mergeTurnCalls(
      'live-order',
      'room:room-1',
      [
        {
          args: { to: 'biology', wait: true },
          durationS: null,
          name: 'message_bot',
          occurrenceId: 'occ-1',
          result: null,
          startedAt: 0,
          status: 'running',
          summary: 'biology',
          toolId: 'call_0'
        },
        {
          args: { to: 'chemistry', wait: true },
          durationS: null,
          name: 'message_bot',
          occurrenceId: 'occ-2',
          result: null,
          startedAt: 0,
          status: 'running',
          summary: 'chemistry',
          toolId: 'call_1'
        },
        {
          args: { to: 'physics', wait: true },
          durationS: null,
          name: 'message_bot',
          occurrenceId: 'occ-3',
          result: null,
          startedAt: 0,
          status: 'running',
          summary: 'physics',
          toolId: 'call_2'
        }
      ],
      'T-order'
    )
    expect(
      useTranscripts
        .getState()
        .bySession['live-order']?.messages.flatMap(message => message.toolCalls)
        .map(call => call.summary)
    ).toEqual(['biology', 'chemistry', 'physics'])

    // 4. Missed snapshot asks land ahead of a newer live ask (`history`) that arrived
    //    after the snapshot was sampled.
    useTranscripts.getState().mergeTurnCalls(
      'live-missed',
      'room:room-1',
      [
        {
          args: { to: 'biology', wait: true },
          durationS: null,
          name: 'message_bot',
          occurrenceId: 'occ-1',
          result: null,
          startedAt: 0,
          status: 'ok',
          summary: 'biology',
          toolId: 'call_0'
        },
        {
          args: { to: 'history', wait: true },
          durationS: null,
          name: 'message_bot',
          occurrenceId: 'occ-4',
          result: null,
          startedAt: 0,
          status: 'running',
          summary: 'history',
          toolId: 'call_3'
        }
      ],
      'T-missed',
      undefined,
      'rt-missed'
    )
    useTranscripts.getState().mergeTurnCalls(
      'live-missed',
      'room:room-1',
      [
        {
          args: { to: 'biology', wait: true },
          durationS: null,
          name: 'message_bot',
          occurrenceId: 'occ-1',
          result: null,
          startedAt: 0,
          status: 'ok',
          summary: 'biology',
          toolId: 'call_0'
        },
        {
          args: { to: 'chemistry', wait: true },
          durationS: null,
          name: 'message_bot',
          occurrenceId: 'occ-2',
          result: null,
          startedAt: 0,
          status: 'ok',
          summary: 'chemistry',
          toolId: 'call_1'
        },
        {
          args: { to: 'physics', wait: true },
          durationS: null,
          name: 'message_bot',
          occurrenceId: 'occ-3',
          result: null,
          startedAt: 0,
          status: 'ok',
          summary: 'physics',
          toolId: 'call_2'
        }
      ],
      'T-missed',
      undefined,
      'rt-missed'
    )
    expect(
      useTranscripts
        .getState()
        .bySession['live-missed']?.messages.flatMap(message => message.toolCalls)
        .map(call => call.summary)
    ).toEqual(['biology', 'chemistry', 'physics', 'history'])

    // 5. Nested codemode ask hydrated from a room snapshot retains parentToolCallId so
    //    its live tool.complete settles it in place instead of appending a duplicate.
    useTranscripts.getState().mergeTurnCalls(
      'live-nested',
      'room:room-1',
      [
        {
          args: { to: 'biology', wait: true },
          durationS: null,
          name: 'message_bot',
          parentToolCallId: 'code',
          result: { section_id: 'th-bio' },
          startedAt: 0,
          status: 'running',
          summary: 'biology',
          toolId: 'code/1'
        }
      ],
      'T-nested',
      undefined,
      'rt-nested'
    )
    useTranscripts.getState().eventIdentity('live-nested', { turnId: 'T-nested' })
    useTranscripts.getState().toolComplete('live-nested', {
      context: 'biology',
      name: 'message_bot',
      parent_tool_call_id: 'code',
      result: { details: { reply: 'Answered', section_id: 'th-bio' } },
      tool_id: 'code/1'
    })
    expect(
      useTranscripts
        .getState()
        .bySession['live-nested']?.messages.flatMap(message => message.toolCalls)
    ).toMatchObject([{ parentToolCallId: 'code', status: 'ok', summary: 'biology', toolId: 'code/1' }])

    // 6. Fallback continuation inside the same room_turns.id (`rt-fb`) keeps earlier asks
    //    even when Pi switches to a new turn_id (`T2`).
    useTranscripts.getState().mergeTurnCalls(
      'live-fb',
      'room:room-1',
      [
        {
          args: { to: 'biology', wait: true },
          durationS: null,
          name: 'message_bot',
          occurrenceId: 'occ-b',
          result: { section_id: 'th-bio' },
          startedAt: 0,
          status: 'ok',
          summary: 'biology',
          toolId: 'call_0'
        }
      ],
      'T1',
      undefined,
      'rt-fb'
    )
    useTranscripts.getState().mergeTurnCalls(
      'live-fb',
      'room:room-1',
      [
        {
          args: { to: 'biology', wait: true },
          durationS: null,
          name: 'message_bot',
          occurrenceId: 'occ-b',
          result: { section_id: 'th-bio' },
          startedAt: 0,
          status: 'ok',
          summary: 'biology',
          toolId: 'call_0'
        },
        {
          args: { to: 'chemistry', wait: true },
          durationS: null,
          name: 'message_bot',
          occurrenceId: 'occ-c',
          result: null,
          startedAt: 0,
          status: 'running',
          summary: 'chemistry',
          toolId: 'call_1'
        }
      ],
      'T2',
      undefined,
      'rt-fb'
    )
    expect(
      useTranscripts
        .getState()
        .bySession['live-fb']?.messages.flatMap(message => message.toolCalls)
        .map(call => [call.summary, call.status])
    ).toEqual([
      ['biology', 'ok'],
      ['chemistry', 'running']
    ])

    // 7. Parallel calls sharing call_0 and the same fragment message_id (`a1`) settle
    //    independently when Chemistry finishes before Biology, and snapshot merge keeps both.
    useTranscripts.getState().eventIdentity('live-parallel', { messageId: 'a1', turnId: 'T-par' })
    useTranscripts.getState().messageStart('live-parallel')
    useTranscripts.getState().toolStart('live-parallel', {
      args: { to: 'biology', text: 'Q1', wait: true },
      context: 'biology',
      name: 'message_bot',
      tool_id: 'call_0'
    })
    useTranscripts.getState().toolStart('live-parallel', {
      args: { to: 'chemistry', text: 'Q2', wait: true },
      context: 'chemistry',
      name: 'message_bot',
      tool_id: 'call_0'
    })
    useTranscripts.getState().toolComplete('live-parallel', {
      args: { to: 'chemistry', text: 'Q2', wait: true },
      context: 'chemistry',
      name: 'message_bot',
      result: { details: { reply: 'chem reply', section_id: 'th-chem' } },
      tool_id: 'call_0'
    })
    useTranscripts.getState().toolComplete('live-parallel', {
      args: { to: 'biology', text: 'Q1', wait: true },
      context: 'biology',
      name: 'message_bot',
      result: { details: { reply: 'bio reply', section_id: 'th-bio' } },
      tool_id: 'call_0'
    })
    expect(
      useTranscripts
        .getState()
        .bySession['live-parallel']?.messages.flatMap(message => message.toolCalls)
        .map(call => ({
          reply: (call.result as { details?: { reply?: string } } | null)?.details?.reply,
          sectionId: (call.result as { details?: { section_id?: string } } | null)?.details
            ?.section_id,
          status: call.status,
          to: (call.args as { to?: string } | null)?.to
        }))
    ).toEqual([
      { reply: 'bio reply', sectionId: 'th-bio', status: 'ok', to: 'biology' },
      { reply: 'chem reply', sectionId: 'th-chem', status: 'ok', to: 'chemistry' }
    ])

    // Snapshot merge when only Chemistry was received live on fragment a1 still restores Biology.
    useTranscripts
      .getState()
      .eventIdentity('live-par-snap', { messageId: 'a1', turnId: 'T-par-snap' })
    useTranscripts.getState().messageStart('live-par-snap')
    useTranscripts.getState().toolStart('live-par-snap', {
      args: { to: 'chemistry', text: 'Q2', wait: true },
      context: 'chemistry',
      name: 'message_bot',
      tool_id: 'call_0'
    })
    useTranscripts.getState().mergeTurnCalls(
      'live-par-snap',
      'room:room-1',
      [
        {
          args: { to: 'biology', text: 'Q1', wait: true },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: { section_id: 'th-bio' },
          startedAt: 0,
          status: 'running',
          summary: 'biology',
          toolId: 'call_0'
        },
        {
          args: { to: 'chemistry', text: 'Q2', wait: true },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: { section_id: 'th-chem' },
          startedAt: 0,
          status: 'running',
          summary: 'chemistry',
          toolId: 'call_0'
        }
      ],
      'T-par-snap',
      undefined,
      'rt-par-snap'
    )
    expect(
      useTranscripts
        .getState()
        .bySession['live-par-snap']?.messages.flatMap(message => message.toolCalls)
        .map(call => (call.args as { to?: string } | null)?.to)
    ).toEqual(['biology', 'chemistry'])

    // 8. Same-fragment call_0 asks differing only by `wait` settle independently on errors.
    useTranscripts
      .getState()
      .eventIdentity('live-par-wait', { messageId: 'a1', turnId: 'T-par-wait' })
    useTranscripts.getState().messageStart('live-par-wait')
    useTranscripts.getState().toolStart('live-par-wait', {
      args: { to: 'writer', text: 'Q', wait: true },
      context: 'writer',
      name: 'message_bot',
      tool_id: 'call_0'
    })
    useTranscripts.getState().toolStart('live-par-wait', {
      args: { to: 'writer', text: 'Q', wait: false },
      context: 'writer',
      name: 'message_bot',
      tool_id: 'call_0'
    })
    useTranscripts.getState().toolComplete('live-par-wait', {
      args: { to: 'writer', text: 'Q', wait: false },
      context: 'writer',
      name: 'message_bot',
      result: { error: 'send failed' },
      tool_id: 'call_0'
    })
    useTranscripts.getState().toolComplete('live-par-wait', {
      args: { to: 'writer', text: 'Q', wait: true },
      context: 'writer',
      name: 'message_bot',
      result: { error: 'wait failed' },
      tool_id: 'call_0'
    })
    expect(
      useTranscripts
        .getState()
        .bySession['live-par-wait']?.messages.flatMap(message => message.toolCalls)
        .map(call => [(call.args as { wait?: boolean } | null)?.wait, call.status])
    ).toEqual([
      [true, 'error'],
      [false, 'error']
    ])

    // 9. Exact text comparison distinguishes empty string "" from whitespace " " on same call_0.
    useTranscripts
      .getState()
      .eventIdentity('live-par-ws', { messageId: 'a1', turnId: 'T-par-ws' })
    useTranscripts.getState().messageStart('live-par-ws')
    useTranscripts.getState().toolStart('live-par-ws', {
      args: { to: 'fox', text: ' ', wait: true },
      context: 'fox',
      name: 'message_bot',
      tool_id: 'call_0'
    })
    useTranscripts.getState().toolStart('live-par-ws', {
      args: { to: 'fox', text: '', wait: true },
      context: 'fox',
      name: 'message_bot',
      tool_id: 'call_0'
    })
    useTranscripts.getState().toolComplete('live-par-ws', {
      args: { to: 'fox', text: '', wait: true },
      context: 'fox',
      name: 'message_bot',
      result: { error: 'missing parameter: text' },
      tool_id: 'call_0'
    })
    expect(
      useTranscripts
        .getState()
        .bySession['live-par-ws']?.messages.flatMap(message => message.toolCalls)
        .map(call => [(call.args as { text?: string } | null)?.text, call.status])
    ).toEqual([
      [' ', 'running'],
      ['', 'error']
    ])

    // 10. Two hydrated identical call_0 asks + two replayed starts + two completions stay 2 calls
    //     and settle cleanly (never doubling to 4 or turning errors into ok on message.complete).
    useTranscripts.getState().mergeTurnCalls(
      'live-ident-replay',
      'room:room-1',
      [
        {
          args: { to: 'fox', text: 'Hi', wait: true },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: null,
          startedAt: 0,
          status: 'running',
          summary: 'fox',
          toolId: 'call_0'
        },
        {
          args: { to: 'fox', text: 'Hi', wait: true },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: null,
          startedAt: 0,
          status: 'running',
          summary: 'fox',
          toolId: 'call_0'
        }
      ],
      'T-ident'
    )
    useTranscripts
      .getState()
      .eventIdentity('live-ident-replay', { messageId: 'a1', turnId: 'T-ident' })
    useTranscripts.getState().toolStart('live-ident-replay', {
      args: { to: 'fox', text: 'Hi', wait: true },
      context: 'fox',
      name: 'message_bot',
      tool_id: 'call_0'
    })
    useTranscripts.getState().toolStart('live-ident-replay', {
      args: { to: 'fox', text: 'Hi', wait: true },
      context: 'fox',
      name: 'message_bot',
      tool_id: 'call_0'
    })
    useTranscripts.getState().toolComplete('live-ident-replay', {
      args: { to: 'fox', text: 'Hi', wait: true },
      context: 'fox',
      name: 'message_bot',
      result: { error: 'boom' },
      tool_id: 'call_0'
    })
    useTranscripts.getState().toolComplete('live-ident-replay', {
      args: { to: 'fox', text: 'Hi', wait: true },
      context: 'fox',
      name: 'message_bot',
      result: { error: 'boom' },
      tool_id: 'call_0'
    })
    expect(
      useTranscripts
        .getState()
        .bySession['live-ident-replay']?.messages.flatMap(message => message.toolCalls)
        .map(call => call.status)
    ).toEqual(['error', 'error'])

    // Hydrated [error, error] on identical untagged call_0 asks must not duplicate on replayed
    // starts or completions (stays 2 settled errors, never reverts to running or 4 errors).
    useTranscripts.getState().mergeTurnCalls(
      'live-two-errors',
      'sec-two-errors',
      [
        {
          args: { to: 'fox', text: 'Hi', wait: true },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: { error: 'boom' },
          startedAt: 0,
          status: 'error',
          summary: 'fox',
          toolId: 'call_0'
        },
        {
          args: { to: 'fox', text: 'Hi', wait: true },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: { error: 'boom' },
          startedAt: 0,
          status: 'error',
          summary: 'fox',
          toolId: 'call_0'
        }
      ],
      'T-two-err'
    )
    useTranscripts
      .getState()
      .eventIdentity('live-two-errors', { messageId: 'a1', turnId: 'T-two-err' })

    for (let i = 0; i < 2; i++) {
      useTranscripts.getState().toolStart('live-two-errors', {
        args: { to: 'fox', text: 'Hi', wait: true },
        context: 'fox',
        name: 'message_bot',
        tool_id: 'call_0'
      })
    }

    expect(
      useTranscripts
        .getState()
        .bySession['live-two-errors']?.messages.flatMap(message => message.toolCalls)
        .map(call => call.status)
    ).toEqual(['error', 'error'])

    for (let i = 0; i < 2; i++) {
      useTranscripts.getState().toolComplete('live-two-errors', {
        args: { to: 'fox', text: 'Hi', wait: true },
        context: 'fox',
        name: 'message_bot',
        result: { error: 'boom' },
        tool_id: 'call_0'
      })
    }

    expect(
      useTranscripts
        .getState()
        .bySession['live-two-errors']?.messages.flatMap(message => message.toolCalls)
        .map(call => call.status)
    ).toEqual(['error', 'error'])

    // Hydrated [error, running] on identical untagged call_0 asks: replaying both starts consumes
    // the settled ask once and upgrades the running sibling; 1st replayed error leaves [error, running],
    // and 2nd error settles [error, error] even after a normal messageComplete.
    useTranscripts.getState().mergeTurnCalls(
      'live-err-run',
      'sec-err-run',
      [
        {
          args: { to: 'fox', text: 'Hi', wait: true },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: { error: 'boom' },
          startedAt: 0,
          status: 'error',
          summary: 'fox',
          toolId: 'call_0'
        },
        {
          args: { to: 'fox', text: 'Hi', wait: true },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: null,
          startedAt: 0,
          status: 'running',
          summary: 'fox',
          toolId: 'call_0'
        }
      ],
      'T-err-run'
    )
    useTranscripts
      .getState()
      .eventIdentity('live-err-run', { messageId: 'a1', turnId: 'T-err-run' })

    for (let i = 0; i < 2; i++) {
      useTranscripts.getState().toolStart('live-err-run', {
        args: { to: 'fox', text: 'Hi', wait: true },
        context: 'fox',
        name: 'message_bot',
        tool_id: 'call_0'
      })
    }

    expect(
      useTranscripts
        .getState()
        .bySession['live-err-run']?.messages.flatMap(message => message.toolCalls)
        .map(call => call.status)
    ).toEqual(['error', 'running'])
    useTranscripts.getState().toolComplete('live-err-run', {
      args: { to: 'fox', text: 'Hi', wait: true },
      context: 'fox',
      name: 'message_bot',
      result: { error: 'boom' },
      tool_id: 'call_0'
    })
    expect(
      useTranscripts
        .getState()
        .bySession['live-err-run']?.messages.flatMap(message => message.toolCalls)
        .map(call => call.status)
    ).toEqual(['error', 'running'])
    useTranscripts.getState().toolComplete('live-err-run', {
      args: { to: 'fox', text: 'Hi', wait: true },
      context: 'fox',
      name: 'message_bot',
      result: { error: 'boom' },
      tool_id: 'call_0'
    })
    useTranscripts.getState().messageComplete('live-err-run', { text: 'Both failed.' })
    expect(
      useTranscripts
        .getState()
        .bySession['live-err-run']?.messages.flatMap(message => message.toolCalls)
        .map(call => call.status)
    ).toEqual(['error', 'error'])

    // Hydrated [error, running] where the 1st error predates the replay window: delivering only
    // the 2nd ask's fresh error followed by normal messageComplete must settle to [error, error],
    // never flipping the running sibling to ok.
    useTranscripts.getState().mergeTurnCalls(
      'live-fresh-err',
      'sec-fresh-err',
      [
        {
          args: { to: 'fox', text: 'Hi', wait: true },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: { error: 'boom' },
          startedAt: 0,
          status: 'error',
          summary: 'fox',
          toolId: 'call_0'
        },
        {
          args: { to: 'fox', text: 'Hi', wait: true },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: null,
          startedAt: 0,
          status: 'running',
          summary: 'fox',
          toolId: 'call_0'
        }
      ],
      'T-fresh-err'
    )
    useTranscripts
      .getState()
      .eventIdentity('live-fresh-err', { messageId: 'a1', turnId: 'T-fresh-err' })
    useTranscripts.getState().toolComplete('live-fresh-err', {
      args: { to: 'fox', text: 'Hi', wait: true },
      context: 'fox',
      name: 'message_bot',
      result: { error: 'boom' },
      tool_id: 'call_0'
    })
    useTranscripts.getState().messageComplete('live-fresh-err', { text: 'Done.' })
    expect(
      useTranscripts
        .getState()
        .bySession['live-fresh-err']?.messages.flatMap(message => message.toolCalls)
        .map(call => call.status)
    ).toEqual(['error', 'error'])

    // Hydrated settled nested ask (parent_tool_call_id, no message_id or occurrence_id)
    // stays settled when replaying its start and completion instead of resurrecting a running duplicate.
    useTranscripts.getState().mergeTurnCalls(
      'live-nested-replay',
      'sec-nested-replay',
      [
        {
          args: { to: 'fox', text: 'Nested', wait: true },
          durationS: null,
          name: 'message_bot',
          parentToolCallId: 'code',
          result: { error: 'boom' },
          startedAt: 0,
          status: 'error',
          summary: 'fox',
          toolId: '1'
        }
      ],
      'T-nested'
    )
    useTranscripts.getState().eventIdentity('live-nested-replay', { turnId: 'T-nested' })
    useTranscripts.getState().toolStart('live-nested-replay', {
      args: { to: 'fox', text: 'Nested', wait: true },
      context: 'fox',
      name: 'message_bot',
      parent_tool_call_id: 'code',
      tool_id: '1'
    })
    useTranscripts.getState().toolComplete('live-nested-replay', {
      args: { to: 'fox', text: 'Nested', wait: true },
      context: 'fox',
      name: 'message_bot',
      parent_tool_call_id: 'code',
      result: { error: 'boom' },
      tool_id: '1'
    })
    expect(
      useTranscripts
        .getState()
        .bySession['live-nested-replay']?.messages.flatMap(message => message.toolCalls)
        .map(call => call.status)
    ).toEqual(['error'])

    // A direct completion reusing a nested ask's tool_id must never settle the nested ask:
    // both with an explicit direct occurrence_id (missed direct start) and untagged alongside
    // a running direct call.
    useTranscripts.getState().eventIdentity('live-nested-vs-direct', { turnId: 'T-nvd' })
    useTranscripts.getState().messageStart('live-nested-vs-direct')
    useTranscripts.getState().toolStart('live-nested-vs-direct', {
      args: { to: 'fox', text: 'Hi', wait: true },
      context: 'fox',
      name: 'message_bot',
      parent_tool_call_id: 'code',
      tool_id: 'code/1'
    })
    useTranscripts.getState().toolComplete('live-nested-vs-direct', {
      args: { to: 'fox', text: 'Hi', wait: true },
      context: 'fox',
      name: 'message_bot',
      occurrence_id: 'direct',
      result: { details: { section_id: 'th-fox', status: 'replied' } },
      tool_id: 'code/1'
    })
    expect(
      useTranscripts
        .getState()
        .bySession['live-nested-vs-direct']?.messages.flatMap(message => message.toolCalls)
        .map(call => [call.parentToolCallId ?? null, call.occurrenceId ?? null, call.status])
    ).toEqual([
      ['code', null, 'running'],
      [null, 'direct', 'ok']
    ])

    useTranscripts.getState().eventIdentity('live-nested-vs-direct-untagged', { turnId: 'T-nvdu' })
    useTranscripts.getState().messageStart('live-nested-vs-direct-untagged')
    useTranscripts.getState().toolStart('live-nested-vs-direct-untagged', {
      args: { to: 'fox', text: 'Hi', wait: true },
      context: 'fox',
      name: 'message_bot',
      parent_tool_call_id: 'code',
      tool_id: 'code/1'
    })
    useTranscripts.getState().toolStart('live-nested-vs-direct-untagged', {
      args: { to: 'fox', text: 'Hi', wait: true },
      context: 'fox',
      name: 'message_bot',
      tool_id: 'code/1'
    })
    useTranscripts.getState().toolComplete('live-nested-vs-direct-untagged', {
      args: { to: 'fox', text: 'Hi', wait: true },
      context: 'fox',
      name: 'message_bot',
      result: { details: { section_id: 'th-fox', status: 'replied' } },
      tool_id: 'code/1'
    })
    expect(
      useTranscripts
        .getState()
        .bySession['live-nested-vs-direct-untagged']?.messages.flatMap(message => message.toolCalls)
        .map(call => [call.parentToolCallId ?? null, call.status])
    ).toEqual([
      ['code', 'running'],
      [null, 'ok']
    ])
  })

  it('records roomTurnId on live hexbot.rooms.turn so a stale snapshot never wipes a fallback continuation', () => {
    useRooms.getState().handleTurn({
      bot: 'owl',
      id: 'turn-row-1',
      live_session_id: 'live-fallback',
      room_id: 'room-fb',
      status: 'running'
    })

    expect(useTranscripts.getState().bySession['live-fallback']?.roomTurnId).toBe('turn-row-1')

    useTranscripts.getState().eventIdentity('live-fallback', { turnId: 't1' })
    useTranscripts.getState().messageStart('live-fallback')
    useTranscripts.getState().toolStart('live-fallback', {
      args: { text: 'Hi', to: 'fox', wait: true },
      context: 'fox',
      name: 'message_bot',
      occurrence_id: 'occ-1',
      tool_id: 'call_0'
    })
    useTranscripts.getState().toolComplete('live-fallback', {
      args: { text: 'Hi', to: 'fox', wait: true },
      context: 'fox',
      name: 'message_bot',
      occurrence_id: 'occ-1',
      result: { details: { section_id: 'th-fox', status: 'replied' } },
      tool_id: 'call_0'
    })
    // Fallback continuation advances activeTurnId to t2 and streams text.
    useTranscripts.getState().eventIdentity('live-fallback', { turnId: 't2' })
    useTranscripts.getState().messageStart('live-fallback')
    useTranscripts.getState().messageDelta('live-fallback', 'Streaming fallback answer')

    // A stale rooms.get snapshot sampled at t1 arrives for the same roomTurnId.
    useTranscripts.getState().mergeTurnCalls(
      'live-fallback',
      'room:room-fb',
      [
        {
          args: { text: 'Hi', to: 'fox', wait: true },
          durationS: null,
          name: 'message_bot',
          occurrenceId: 'occ-1',
          result: null,
          startedAt: 0,
          status: 'running',
          summary: 'fox',
          toolId: 'call_0'
        }
      ],
      't1',
      undefined,
      'turn-row-1'
    )

    const live = useTranscripts.getState().bySession['live-fallback']
    expect(live?.roomTurnId).toBe('turn-row-1')
    expect(live?.activeTurnId).toBe('t2')
    expect(live?.messages.map(m => m.text)).toContain('Streaming fallback answer')
    expect(live?.messages.flatMap(m => m.toolCalls).map(c => c.status)).toEqual(['ok'])
  })

  it('settles the second nested codemode ask on a shared peer thread using parent_occurrence_id', () => {
    useTranscripts.getState().mergeTurnCalls(
      'live-two-nested',
      'room:room-two',
      [
        {
          args: { text: 'Check', to: 'biology', wait: true },
          durationS: null,
          name: 'message_bot',
          parentOccurrenceId: 'occ-p1',
          parentToolCallId: 'code_0',
          result: { section_id: 'th-bio' },
          startedAt: 0,
          status: 'ok',
          summary: 'biology',
          toolId: 'code_0/1'
        },
        {
          args: { text: 'Check', to: 'biology', wait: true },
          durationS: null,
          name: 'message_bot',
          parentOccurrenceId: 'occ-p2',
          parentToolCallId: 'code_0',
          result: null,
          startedAt: 0,
          status: 'running',
          summary: 'biology',
          toolId: 'code_0/1'
        }
      ],
      'T-two',
      undefined,
      'rt-two'
    )

    useTranscripts.getState().eventIdentity('live-two-nested', { turnId: 'T-two' })
    useTranscripts.getState().toolComplete('live-two-nested', {
      context: 'biology',
      name: 'message_bot',
      parent_occurrence_id: 'occ-p2',
      parent_tool_call_id: 'code_0',
      result: { details: { reply: 'Second ok', section_id: 'th-bio' } },
      tool_id: 'code_0/1'
    })

    const calls =
      useTranscripts
        .getState()
        .bySession['live-two-nested']?.messages.flatMap(message => message.toolCalls) ?? []

    expect(calls.map(c => [c.parentOccurrenceId, c.status])).toEqual([
      ['occ-p1', 'ok'],
      ['occ-p2', 'ok']
    ])

    // Replayed nested tool.start for an earlier settled parent (`occ-p1` on fragment `m1`)
    // while a second `code_0` parent (`occ-p2` on fragment `m2`) is running must resolve
    // `occ-p1` on `m1` instead of misbinding onto `m2` and appending a duplicate running ask.
    useTranscripts.getState().open('live-replay-parent', 'sec-rp', [
      {
        attachments: [],
        createdAt: 0,
        fragmentIds: ['m1'],
        id: 'm1',
        role: 'assistant',
        streaming: false,
        text: '',
        toolCalls: [
          {
            args: { code: 'ask(1)' },
            durationS: 1,
            messageId: 'm1',
            name: 'codemode',
            occurrenceId: 'occ-p1',
            result: 'done',
            startedAt: 0,
            status: 'ok',
            toolId: 'code_0'
          },
          {
            args: { text: 'Check', to: 'biology', wait: true },
            durationS: 1,
            messageId: 'm1',
            name: 'message_bot',
            parentOccurrenceId: 'occ-p1',
            parentToolCallId: 'code_0',
            result: { section_id: 'th-bio' },
            startedAt: 0,
            status: 'ok',
            summary: 'biology',
            toolId: 'code_0/1'
          }
        ],
        turnId: 'T-rp'
      },
      {
        attachments: [],
        createdAt: 1,
        fragmentIds: ['m2'],
        id: 'm2',
        role: 'assistant',
        streaming: true,
        text: '',
        toolCalls: [
          {
            args: { code: 'ask(2)' },
            durationS: null,
            messageId: 'm2',
            name: 'codemode',
            occurrenceId: 'occ-p2',
            result: null,
            startedAt: 1,
            status: 'running',
            toolId: 'code_0'
          }
        ],
        turnId: 'T-rp'
      }
    ])

    useTranscripts.getState().eventIdentity('live-replay-parent', { turnId: 'T-rp' })
    useTranscripts.getState().toolStart('live-replay-parent', {
      args: { text: 'Check', to: 'biology', wait: true },
      context: 'biology',
      name: 'message_bot',
      parent_occurrence_id: 'occ-p1',
      parent_tool_call_id: 'code_0',
      tool_id: 'code_0/1'
    })

    const replayAsks =
      useTranscripts
        .getState()
        .bySession['live-replay-parent']?.messages.flatMap(m => m.toolCalls)
        .filter(c => c.name === 'message_bot') ?? []

    expect(replayAsks.map(c => [c.messageId, c.parentOccurrenceId, c.status])).toEqual([
      ['m1', 'occ-p1', 'ok']
    ])

    // Untagged settled nested ask (from an earlier ambiguous parallel parent) must not
    // intercept a live `tool.complete` or `tool.start` carrying explicit `parent_occurrence_id: 'occ-p2'`.
    useTranscripts.getState().mergeTurnCalls(
      'live-untagged-vs-p2',
      'room:room-uvp2',
      [
        {
          args: { text: 'Check', to: 'biology', wait: true },
          durationS: null,
          name: 'message_bot',
          parentToolCallId: 'code_0',
          result: { section_id: 'th-bio' },
          startedAt: 0,
          status: 'ok',
          summary: 'biology',
          toolId: 'code_0/1'
        },
        {
          args: { text: 'Check', to: 'biology', wait: true },
          durationS: null,
          name: 'message_bot',
          parentOccurrenceId: 'occ-p2',
          parentToolCallId: 'code_0',
          result: null,
          startedAt: 0,
          status: 'running',
          summary: 'biology',
          toolId: 'code_0/1'
        }
      ],
      'T-uvp2',
      undefined,
      'rt-uvp2'
    )
    useTranscripts.getState().eventIdentity('live-untagged-vs-p2', { turnId: 'T-uvp2' })
    useTranscripts.getState().toolComplete('live-untagged-vs-p2', {
      context: 'biology',
      name: 'message_bot',
      parent_occurrence_id: 'occ-p2',
      parent_tool_call_id: 'code_0',
      result: { details: { reply: 'Ok', section_id: 'th-bio' } },
      tool_id: 'code_0/1'
    })

    const uvp2Calls =
      useTranscripts
        .getState()
        .bySession['live-untagged-vs-p2']?.messages.flatMap(m => m.toolCalls) ?? []

    expect(uvp2Calls.map(c => [c.parentOccurrenceId ?? null, c.status])).toEqual([
      [null, 'ok'],
      ['occ-p2', 'ok']
    ])

    useTranscripts.getState().mergeTurnCalls(
      'live-start-untagged-vs-p2',
      'room:room-suvp2',
      [
        {
          args: { text: 'Check', to: 'biology', wait: true },
          durationS: null,
          name: 'message_bot',
          parentToolCallId: 'code_0',
          result: { section_id: 'th-bio' },
          startedAt: 0,
          status: 'ok',
          summary: 'biology',
          toolId: 'code_0/1'
        }
      ],
      'T-suvp2',
      undefined,
      'rt-suvp2'
    )
    useTranscripts.getState().eventIdentity('live-start-untagged-vs-p2', { turnId: 'T-suvp2' })
    useTranscripts.getState().toolStart('live-start-untagged-vs-p2', {
      args: { text: 'Check', to: 'biology', wait: true },
      context: 'biology',
      name: 'message_bot',
      parent_occurrence_id: 'occ-p2',
      parent_tool_call_id: 'code_0',
      tool_id: 'code_0/1'
    })

    const suvp2Calls =
      useTranscripts
        .getState()
        .bySession['live-start-untagged-vs-p2']?.messages.flatMap(m => m.toolCalls) ?? []

    expect(suvp2Calls.map(c => [c.parentOccurrenceId ?? null, c.status])).toEqual([
      [null, 'ok'],
      ['occ-p2', 'running']
    ])

    // Missed tool.start: explicit `parent_occurrence_id: 'occ-p2'` toolComplete appends
    // separately rather than overwriting 1 earlier untagged settled ask or dropping when 2 exist.
    for (const [sid, count] of [
      ['live-missed-start-1', 1],
      ['live-missed-start-2', 2]
    ] as const) {
      useTranscripts.getState().mergeTurnCalls(
        sid,
        `room:${sid}`,
        Array.from({ length: count }, () => ({
          args: { text: 'Check', to: 'biology', wait: true },
          durationS: null,
          name: 'message_bot',
          parentToolCallId: 'code_0',
          result: { section_id: 'th-bio' },
          startedAt: 0,
          status: 'ok' as const,
          summary: 'biology',
          toolId: 'code_0/1'
        })),
        'T-ms',
        undefined,
        `rt-${sid}`
      )
      useTranscripts.getState().eventIdentity(sid, { turnId: 'T-ms' })
      useTranscripts.getState().toolComplete(sid, {
        context: 'biology',
        name: 'message_bot',
        parent_occurrence_id: 'occ-p2',
        parent_tool_call_id: 'code_0',
        result: { details: { reply: 'New', section_id: 'th-bio' } },
        tool_id: 'code_0/1'
      })

      const msCalls =
        useTranscripts.getState().bySession[sid]?.messages.flatMap(m => m.toolCalls) ?? []

      expect(msCalls.map(c => [c.parentOccurrenceId ?? null, c.status])).toEqual([
        ...Array.from({ length: count }, () => [null, 'ok']),
        ['occ-p2', 'ok']
      ])
    }
  })
})
