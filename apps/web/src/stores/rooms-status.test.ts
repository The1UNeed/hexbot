import { routeEvent } from '../lib/events'
import { setActiveRpc } from '../lib/rpc'
import type { Room, RoomEvent } from '../lib/types'

import { roomFailure, roomStatus, useRooms } from './rooms'

const event = (seq: number, kind: RoomEvent['kind'], payload: RoomEvent['payload'] = {}) =>
  ({ actor_id: 'writer', actor_kind: 'bot', created_at: seq, kind, payload, room_id: 'r', seq }) as RoomEvent

describe('room status', () => {
  it('is working with a live turn, needs you after a tag, stopped after a failed turn', () => {
    const turn = { bot: 'writer', live_session_id: 'l', room_id: 'r', status: 'running' }
    expect(roomStatus([event(1, 'waiting.human')], { writer: turn })).toBe('working')
    expect(roomStatus([event(1, 'waiting.human')], {})).toBe('needs_you')
    expect(roomStatus([event(1, 'turn.failed', { error: 'Network down' })], undefined)).toBe('stopped')
    expect(roomStatus([event(1, 'message.bot', { text: 'hi' })], {})).toBe('idle')
    expect(roomFailure([event(1, 'turn.failed', { error: 'Network down' })])).toBe('Network down')
    expect(roomFailure([event(1, 'turn.failed')])).toBe('The turn did not finish.')
    expect(roomFailure([event(1, 'message.bot')])).toBeNull()
  })
})

describe('removing the last member', () => {
  it('drops the room the daemon deleted and reports it', async () => {
    const room = { id: 'r', members: [], name: 'Lab' } as unknown as Room
    useRooms.setState({
      byId: { r: room },
      eventsByRoom: { r: [event(1, 'message.user')] },
      liveTurnsByRoom: {},
      order: ['r']
    })
    setActiveRpc({
      call: vi.fn((method: string) =>
        method === 'hexbot.rooms.remove_member'
          ? Promise.resolve({ room: { ...room, deleted: true } })
          : Promise.reject(new Error(`unexpected ${method}`))
      )
    } as never)

    await expect(useRooms.getState().removeMember('r', 'scout')).resolves.toBe(true)
    expect(useRooms.getState().byId.r).toBeUndefined()
    expect(useRooms.getState().order).toEqual([])
    expect(useRooms.getState().eventsByRoom.r).toBeUndefined()
  })
})

describe('a rooms.changed event for a deleted room', () => {
  it('drops the room instead of refetching it', () => {
    const room = { id: 'r', members: [], name: 'Lab' } as unknown as Room
    useRooms.setState({ byId: { r: room }, eventsByRoom: {}, liveTurnsByRoom: {}, order: ['r'] })
    const call = vi.fn(() => Promise.reject(new Error('should not be called')))
    setActiveRpc({ call } as never)
    routeEvent({ payload: { deleted: true, id: 'r' }, type: 'hexbot.rooms.changed' } as never)
    expect(useRooms.getState().byId.r).toBeUndefined()
    expect(call).not.toHaveBeenCalled()
  })
})
