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
})
