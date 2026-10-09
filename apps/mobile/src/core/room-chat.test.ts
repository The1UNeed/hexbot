import { describe, expect, it } from 'vitest'
import type { GatewayEvent } from '@hermes/shared'
import type { Room, RoomEvent } from './types'
import { reduceRoom, restoreRoom } from './room-chat'

const room: Room = {
  id: 'room',
  name: 'Planning',
  owner_id: 'owner',
  main_bot: 'alpha',
  approval_mode: null,
  limits: {},
  archived_at: null,
  created_at: 0,
  updated_at: 0,
  last_activity_at: 0,
  members: [
    {
      member_id: 'former',
      member_kind: 'human',
      display_name: 'Ada',
      left_at: 1,
      room_id: 'room',
      added_at: 0,
      added_by: 'owner',
      last_read_seq: 0
    }
  ],
  turns: [
    { bot: 'alpha', live_session_id: 'a' },
    { bot: 'beta', live_session_id: 'b' }
  ]
}
const wire = (
  type: string,
  session_id: string,
  payload: Record<string, unknown> = {}
): GatewayEvent => ({ type, session_id, payload })
const log = (
  seq: number,
  kind: RoomEvent['kind'],
  payload: Record<string, unknown> = {},
  actor_id: string | null = null
): RoomEvent => ({
  seq,
  kind,
  payload,
  actor_id,
  actor_kind: 'system',
  room_id: room.id,
  created_at: 1
})
const reduce = (state: ReturnType<typeof restoreRoom>, event: GatewayEvent) =>
  reduceRoom(state, event, room, id => (id === 'beta' ? 'Beta display' : 'Alpha display'))

describe('room sessions', () => {
  it('keeps simultaneous text, interim replies, tools and cards separate until all turns finish', () => {
    let state = restoreRoom(room, [])
    state = reduce(state, wire('message.delta', 'a', { text: 'Alpha ' }))
    state = reduce(state, wire('message.delta', 'b', { text: 'Beta ' }))
    state = reduce(state, wire('message.interim', 'a', { text: 'Alpha ', already_streamed: true }))
    state = reduce(state, wire('tool.start', 'a', { tool_id: 'same', name: 'read' }))
    state = reduce(state, wire('tool.start', 'b', { tool_id: 'same', name: 'write' }))
    state = reduce(state, wire('tool.complete', 'a', { tool_id: 'same', result: 'Alpha result' }))
    state = reduce(state, wire('approval.request', 'b', { request_id: 'approval' }))
    state = reduce(
      state,
      wire('clarify.request', 'b', { request_id: 'question', question: 'When?' })
    )
    state = reduce(state, wire('message.delta', 'a', { text: 'end' }))
    expect(state.turns.a.streaming).toBe('end')
    expect(state.turns.a.interim).toEqual(['Alpha '])
    expect(state.turns.b.streaming).toBe('Beta ')
    expect(state.turns.b.tools[0]).toMatchObject({ name: 'write', status: 'running', detail: '' })
    state = reduce(state, wire('message.complete', 'a', { text: 'Alpha end' }))
    state = reduce(
      state,
      wire('hexbot.rooms.turn', '', {
        room_id: room.id,
        bot: 'alpha',
        live_session_id: 'a',
        status: 'complete'
      })
    )
    state = reduce(
      state,
      wire('hexbot.rooms.event', '', {
        room_id: room.id,
        event: log(1, 'message.bot', { text: 'Alpha end' }, 'alpha')
      })
    )
    state = reduce(
      state,
      wire('hexbot.rooms.event', '', { room_id: room.id, event: log(2, 'waiting.human') })
    )
    expect(state.busy).toBe(true)
    expect(state.turns.b.streaming).toBe('Beta ')
    expect(state.approvals[0].sessionId).toBe('b')
    expect(state.questions[0].sessionId).toBe('b')
    expect(state.messages.map(m => m.text)).toEqual(['Alpha end'])
    state = reduce(state, wire('message.complete', 'b', { text: 'Beta end' }))
    expect(state.approvals).toEqual([])
    expect(state.questions).toEqual([])
    state = reduce(
      state,
      wire('hexbot.rooms.turn', '', {
        room_id: room.id,
        bot: 'beta',
        live_session_id: 'b',
        status: 'complete'
      })
    )
    expect(state.busy).toBe(false)
  })

  it('resync drops stale output and cards, restores active cards, and ignores completed sessions', () => {
    let state = restoreRoom({ ...room, turns: [{ bot: 'beta', live_session_id: 'b' }] }, [])
    state = reduce(state, wire('approval.request', 'a', { request_id: 'obsolete' }))
    state = reduce(state, wire('approval.request', 'b', { request_id: 'current' }))
    state = reduce(state, wire('approval.request', 'b', { request_id: 'current' }))
    expect(state.turns.a).toBeUndefined()
    expect(state.approvals.map(a => a.requestId)).toEqual(['current'])
    state = reduce(
      state,
      wire('hexbot.rooms.turn', '', {
        room_id: room.id,
        bot: 'beta',
        live_session_id: null,
        status: 'failed'
      })
    )
    expect(state.approvals).toEqual([])
    state = reduce(state, wire('message.delta', 'b', { text: 'late' }))
    expect(state.turns).toEqual({})
    expect(restoreRoom({ ...room, turns: [] }, []).approvals).toEqual([])
  })

  it('uses display names for live activity', () => {
    const state = reduce(
      restoreRoom(room, []),
      wire('hexbot.rooms.turn', '', {
        room_id: room.id,
        bot: 'beta',
        live_session_id: 'b',
        status: 'running'
      })
    )
    expect(state.activity).toBe('Beta display is working')
  })
})

describe('room history', () => {
  it('shows failures and budget limits identically live and after reconnect, without duplicates', () => {
    const events = [
      log(1, 'turn.failed', { error: 'Provider unavailable' }),
      log(2, 'limit.tripped', { limit: 'bot_turns_per_human_turn', used: 8, cap: 8 })
    ]
    let state = restoreRoom(room, [])
    for (const event of [...events, events[1]])
      state = reduce(state, wire('hexbot.rooms.event', '', { room_id: room.id, event }))
    expect(state.messages).toEqual(restoreRoom(room, events).messages)
    expect(state.messages.map(m => [m.role, m.text])).toEqual([
      ['system', 'Provider unavailable'],
      ['system', 'Bot reply limit reached.']
    ])
    expect(state.busy).toBe(true)
  })

  it('preserves former human authors, even after they have left the room', () => {
    const state = restoreRoom(room, [
      log(1, 'message.user', { text: 'Old message' }, 'former'),
      log(2, 'message.user', { text: 'Mine' }, 'owner')
    ])
    expect(state.messages[0]).toMatchObject({ sender: 'former', senderName: 'Ada', role: 'user' })
    expect(state.messages[1].sender).toBe('owner')
  })
})
