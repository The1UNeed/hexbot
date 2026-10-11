import { describe, expect, it } from 'vitest'
import type { GatewayEvent } from '@hermes/shared'
import type { Room, RoomEvent } from './types'
import { reduceRoom, restoreRoom } from './room-chat'
import { approvalResponse, clarifyResponse, rosterChat, settledBot } from './chat'
import type { Bot } from './types'

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
      member_id: 'alpha',
      member_kind: 'bot',
      display_name: 'Alpha',
      left_at: null,
      room_id: 'room',
      added_at: 0,
      added_by: 'owner',
      last_read_seq: 0
    },
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
  it('settles exact session cards from local RPC results without removing same-ID siblings', () => {
    let state = restoreRoom(room, [])
    for (const id of ['a', 'b']) {
      state = reduce(state, wire('approval.request', id, { request_id: 'same' }))
      state = reduce(state, wire('clarify.request', id, { request_id: 'same', question: 'When?' }))
    }
    const approval = state.turns.a.approvals[0]
    const question = state.turns.a.questions[0]
    state = reduce(state, approvalResponse(approval, 'once', { resolved: true, choice: 'once' })!)
    state = reduce(
      state,
      clarifyResponse(question, 'same', 'Now', {
        status: 'answered',
        answers: { same: 'Canonical' }
      })
    )
    expect(state.turns.a).toMatchObject({
      approvals: [],
      questions: [],
      busy: true,
      waiting: false
    })
    expect(state.approvals.map(a => a.sessionId)).toEqual(['b'])
    expect(state.questions.map(q => q.sessionId)).toEqual(['b'])
    expect(state.turns.b.waiting).toBe(true)
    state = reduce(
      state,
      wire('hexbot.rooms.turn', '', {
        room_id: room.id,
        bot: 'alpha',
        live_session_id: 'a',
        status: 'complete'
      })
    )
    const before = state
    state = reduce(state, approvalResponse(approval, 'once', { resolved: true })!)
    state = reduce(state, clarifyResponse(question, 'same', 'Now', { status: 'answered' }))
    expect(state).toBe(before)
    expect(state.approvals.map(a => a.sessionId)).toEqual(['b'])
    expect(state.questions.map(q => q.sessionId)).toEqual(['b'])
  })

  it('remembers answer-before-card per live room session and preserves sibling Waiting on Working', () => {
    let state = restoreRoom(room, [])
    state = reduce(
      state,
      wire('clarify.resolved', 'a', {
        request_id: 'same',
        answers: { same: 'Now' },
        status: 'answered'
      })
    )
    state = reduce(state, wire('clarify.request', 'a', { request_id: 'same', question: 'When?' }))
    state = reduce(state, wire('clarify.request', 'b', { request_id: 'same', question: 'When?' }))
    state = reduce(
      state,
      wire('hexbot.rooms.turn', '', {
        room_id: room.id,
        bot: 'beta',
        live_session_id: 'b',
        status: 'working'
      })
    )
    expect(state.turns.a.questions).toEqual([])
    expect(state.questions.map(q => q.sessionId)).toEqual(['b'])
    expect(state.turns.b.waiting).toBe(true)
    expect(state.activity).toBe('Beta display is waiting')
  })

  it('retires roster proof per room session while preserving an answer accepted during its read', () => {
    let state = restoreRoom(room, [])
    for (const id of ['a', 'b']) {
      state = reduce(state, wire('approval.request', id, { request_id: 'same' }))
      state = reduce(state, {
        ...wire('approval.resolved', id, { request_id: 'same', choice: 'once' }),
        mobileRevision: id === 'a' ? 1 : 2
      } as GatewayEvent)
    }
    state = rosterChat(state, 1)
    expect(state.turns.a.resumedWaiting).toBe(false)
    expect(state.turns.b.resumedWaiting).toBe(true)
    const bot = { name: 'beta', status: 'needs_you', status_detail: { session_id: 'a' } } as Bot
    expect(settledBot(bot, state.turns.b, 'b')).toBe(bot)
  })

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
      { ...log(1, 'turn.failed', { error: 'Provider unavailable' }, 'alpha'), actor_kind: 'bot' },
      log(2, 'limit.tripped', { limit: 'room_bot_turns_per_human_turn', used: 8, cap: 8 }),
      log(3, 'limit.tripped', { limit: 'room_budget_tokens_per_human_turn', used: 9, cap: 9 }),
      log(4, 'limit.tripped', { limit: 'daily_tokens', used: 9, cap: 9 }),
      log(5, 'turn.failed', { error: 'database is locked' })
    ] as RoomEvent[]
    let state = restoreRoom(room, [])
    for (const event of [...events, events[1]])
      state = reduce(state, wire('hexbot.rooms.event', '', { room_id: room.id, event }))
    expect(state.messages).toEqual(restoreRoom(room, events).messages)
    expect(state.messages.map(m => [m.role, m.text])).toEqual([
      ['system', 'Alpha stopped · Provider unavailable'],
      ['system', 'Bot reply limit reached.'],
      ['system', 'Room token budget reached.'],
      ['system', 'Daily token limit reached.'],
      ['system', 'The room stopped · database is locked']
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
