import type { GatewayEvent } from '@hermes/shared'

import { routeEvent } from '../lib/events'
import type { RoomEvent } from '../lib/types'

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
})
