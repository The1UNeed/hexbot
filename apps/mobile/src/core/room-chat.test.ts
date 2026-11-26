import { describe, expect, it } from 'vitest'
import type { GatewayEvent } from '@hermes/shared'
import { asksOf, askWords } from '../../../web/src/lib/asks'
import type { Room, RoomEvent } from './types'
import { mergeAsked, reduceRoom, restoreRoom } from './room-chat'

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

  it('drops a card answered on another app from its own turn only', () => {
    let state = restoreRoom(
      {
        ...room,
        turns: [
          { bot: 'alpha', live_session_id: 'a' },
          { bot: 'beta', live_session_id: 'b' }
        ]
      },
      []
    )
    state = reduce(state, wire('approval.request', 'a', { request_id: 'alpha-card' }))
    state = reduce(state, wire('approval.request', 'b', { request_id: 'beta-card' }))
    state = reduce(
      state,
      wire('approval.resolved', 'b', { request_id: 'beta-card', choice: 'deny' })
    )
    expect(state.approvals.map(a => a.requestId)).toEqual(['alpha-card'])
    expect(state.busy).toBe(true)
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

  it('preserves wait:false live asks through completion gap and restores failed room asks as Asked', () => {
    let state = restoreRoom(room, [])
    // 1. Live tool.start -> Messaging
    state = reduce(
      state,
      wire('tool.start', 'a', {
        tool_id: 'ask-1',
        name: 'message_bot',
        args: { to: 'beta', text: 'FYI', wait: false }
      })
    )
    const wordsOf = (tools: typeof state.tools) =>
      asksOf(
        tools.map(t => ({
          args: t.args,
          name: t.name,
          result: t.detail,
          status: t.status,
          summary: t.action
        }))
      ).map(ask => askWords(ask).before)

    expect(wordsOf(state.turns.a.asked ?? state.turns.a.tools)).toEqual(['Messaging'])

    // 2. Live tool.complete with Pi's {content, details} envelope -> Messaged (not Message from!)
    state = reduce(
      state,
      wire('tool.complete', 'a', {
        tool_id: 'ask-1',
        name: 'message_bot',
        result: {
          content: [{ type: 'text', text: 'Sent' }],
          details: { message_id: 'm1', section_id: 'th-beta', status: 'sent' }
        }
      })
    )
    expect(wordsOf(state.turns.a.asked ?? state.turns.a.tools)).toEqual(['Messaged'])

    // 3. Daemon emits message.complete BEFORE hexbot.rooms.turn(complete): turn.asked preserves Messaged!
    state = reduce(
      state,
      wire('message.complete', 'a', {
        text: 'Notified Beta; Gamma timed out.'
      })
    )
    expect(wordsOf(state.turns.a.asked ?? [])).toEqual(['Messaged'])

    // 4. hexbot.rooms.turn(complete) before message.bot -> completingAsks keeps Messaged mounted
    state = reduce(
      state,
      wire('hexbot.rooms.turn', '', {
        room_id: room.id,
        bot: 'alpha',
        live_session_id: 'a',
        status: 'complete'
      })
    )
    expect(state.turns.a).toBeUndefined()
    expect(wordsOf(state.completingAsks?.alpha ?? [])).toEqual(['Messaged'])

    // 5. Durable message.bot lands -> clears completingAsks and preserves Messaged + failed Asked
    state = reduce(
      state,
      wire('hexbot.rooms.event', '', {
        room_id: room.id,
        event: log(
          1,
          'message.bot',
          {
            text: 'Notified Beta; Gamma timed out.',
            asks: [
              { to: 'beta', section_id: 'th-beta', waited: 0, failed: 0 },
              { to: 'gamma', section_id: 'th-gamma', waited: 1, failed: 1 },
              { to: 'delta', section_id: 'th-delta', waited: 1, failed: 0 }
            ]
          },
          'alpha'
        )
      })
    )
    expect(state.completingAsks?.alpha).toBeUndefined()
    const settledAsks = asksOf(
      (state.messages[0]?.tools ?? []).map(t => ({
        args: t.args,
        name: t.name,
        result: t.detail,
        status: t.status,
        summary: t.action
      }))
    )
    expect(settledAsks).toEqual([
      { sectionId: 'th-beta', sent: true, status: 'ok', target: 'beta' },
      { sectionId: 'th-gamma', sent: false, status: 'error', target: 'gamma' },
      { sectionId: 'th-delta', sent: false, status: 'ok', target: 'delta' }
    ])
    expect(settledAsks.map(ask => askWords(ask).before)).toEqual([
      'Messaged',
      'Asked',
      'Message from'
    ])

    // A silent (pass) or empty final turn after an interim does not leave a lingering completingAsks row.
    for (const [turnSession, finalText] of [
      ['b', '(pass)'],
      ['b2', '']
    ] as const) {
      state = reduce(
        state,
        wire('hexbot.rooms.turn', '', {
          room_id: room.id,
          bot: 'beta',
          live_session_id: turnSession,
          status: 'running'
        })
      )
      state = reduce(state, wire('message.interim', turnSession, { text: 'I will check first.' }))
      state = reduce(
        state,
        wire('tool.start', turnSession, {
          tool_id: `ask-${turnSession}`,
          name: 'message_bot',
          args: { to: 'alpha', text: 'Check', wait: false }
        })
      )
      state = reduce(
        state,
        wire('tool.complete', turnSession, {
          tool_id: `ask-${turnSession}`,
          name: 'message_bot',
          result: { details: { section_id: 'th-a', status: 'sent' } }
        })
      )
      state = reduce(state, wire('message.complete', turnSession, { text: finalText }))
      state = reduce(
        state,
        wire('hexbot.rooms.turn', '', {
          room_id: room.id,
          bot: 'beta',
          live_session_id: turnSession,
          status: 'complete'
        })
      )
      expect(state.completingAsks?.beta).toBeUndefined()
    }
  })

  it('keeps distinct live asks when two fragments reuse a tool id in one room turn', () => {
    const startTurn = (session: string) =>
      wire('hexbot.rooms.turn', '', {
        room_id: room.id,
        bot: 'alpha',
        live_session_id: session,
        status: 'running'
      })
    const asksFrom = (
      tools: readonly {
        action?: string
        args?: unknown
        detail: string
        name: string
        status: 'error' | 'ok' | 'running' | 'unresolved'
      }[]
    ) =>
      asksOf(
        tools.map(t => ({
          args: t.args,
          name: t.name,
          result: t.detail,
          status: t.status,
          summary: t.action
        }))
      ).map(ask => ({ sectionId: ask.sectionId, status: ask.status, target: ask.target }))

    let state = reduce(restoreRoom(room, []), startTurn('s1'))
    state = reduce(
      state,
      wire('tool.start', 's1', {
        tool_id: 'call_0',
        message_id: 'frag-a',
        name: 'message_bot',
        args: { to: 'biology', text: 'Check cells' }
      })
    )
    state = reduce(
      state,
      wire('tool.complete', 's1', {
        tool_id: 'call_0',
        message_id: 'frag-a',
        name: 'message_bot',
        result: { details: { section_id: 'th-bio', status: 'replied' } }
      })
    )
    state = reduce(
      state,
      wire('tool.start', 's1', {
        tool_id: 'call_0',
        message_id: 'frag-b',
        name: 'message_bot',
        args: { to: 'chemistry', text: 'Check bonds' }
      })
    )
    state = reduce(
      state,
      wire('tool.complete', 's1', {
        tool_id: 'call_0',
        message_id: 'frag-b',
        name: 'message_bot',
        result: { details: { section_id: 'th-chem', status: 'replied' } }
      })
    )
    state = reduce(state, wire('message.complete', 's1', { text: 'Checked both.' }))
    state = reduce(
      state,
      wire('hexbot.rooms.turn', '', {
        room_id: room.id,
        bot: 'alpha',
        live_session_id: 's1',
        status: 'complete'
      })
    )
    expect(asksFrom(state.completingAsks?.alpha ?? [])).toEqual([
      { sectionId: 'th-bio', status: 'ok', target: 'biology' },
      { sectionId: 'th-chem', status: 'ok', target: 'chemistry' }
    ])

    // Older daemon omitting message_id while reusing call_0 across targets in one turn.
    let legacy = reduce(restoreRoom(room, []), startTurn('s2'))
    legacy = reduce(
      legacy,
      wire('tool.start', 's2', {
        tool_id: 'call_0',
        name: 'message_bot',
        args: { to: 'biology', text: 'Check cells' }
      })
    )
    legacy = reduce(
      legacy,
      wire('tool.complete', 's2', {
        tool_id: 'call_0',
        name: 'message_bot',
        result: { details: { section_id: 'th-bio', status: 'replied' } }
      })
    )
    legacy = reduce(
      legacy,
      wire('tool.start', 's2', {
        tool_id: 'call_0',
        name: 'message_bot',
        args: { to: 'chemistry', text: 'Check bonds' }
      })
    )
    legacy = reduce(
      legacy,
      wire('tool.complete', 's2', {
        tool_id: 'call_0',
        name: 'message_bot',
        result: { details: { section_id: 'th-chem', status: 'replied' } }
      })
    )
    legacy = reduce(legacy, wire('message.complete', 's2', { text: 'Checked both.' }))
    legacy = reduce(
      legacy,
      wire('hexbot.rooms.turn', '', {
        room_id: room.id,
        bot: 'alpha',
        live_session_id: 's2',
        status: 'complete'
      })
    )
    expect(asksFrom(legacy.completingAsks?.alpha ?? [])).toEqual([
      { sectionId: 'th-bio', status: 'ok', target: 'biology' },
      { sectionId: 'th-chem', status: 'ok', target: 'chemistry' }
    ])
  })

  it('keeps an earlier successful room reply when a same-turn follow-up to the same peer fails or sends async using call_0', () => {
    const startTurn = (session: string) =>
      wire('hexbot.rooms.turn', '', {
        room_id: room.id,
        bot: 'alpha',
        live_session_id: session,
        status: 'running'
      })
    const summarize = (
      tools: readonly {
        action?: string
        args?: unknown
        detail: string
        name: string
        status: 'error' | 'ok' | 'running' | 'unresolved'
      }[]
    ) =>
      asksOf(
        tools.map(t => ({
          args: t.args,
          name: t.name,
          result: t.detail,
          status: t.status,
          summary: t.action
        }))
      ).map(ask => ({
        before: askWords(ask).before,
        sectionId: ask.sectionId,
        sent: ask.sent,
        status: ask.status,
        target: ask.target
      }))

    // 1. Biology replies ok, then a retry to Biology using call_0 fails -> keeps Message from Biology + th-bio.
    let retryFail = reduce(restoreRoom(room, []), startTurn('r1'))
    retryFail = reduce(
      retryFail,
      wire('tool.start', 'r1', { tool_id: 'call_0', name: 'message_bot', args: { to: 'biology' } })
    )
    retryFail = reduce(
      retryFail,
      wire('tool.complete', 'r1', {
        tool_id: 'call_0',
        name: 'message_bot',
        result: { details: { section_id: 'th-bio', status: 'replied' } }
      })
    )
    retryFail = reduce(
      retryFail,
      wire('tool.start', 'r1', { tool_id: 'call_0', name: 'message_bot', args: { to: 'biology' } })
    )
    retryFail = reduce(
      retryFail,
      wire('tool.complete', 'r1', {
        tool_id: 'call_0',
        name: 'message_bot',
        is_error: true,
        result: { error: 'timed out' }
      })
    )
    retryFail = reduce(retryFail, wire('message.complete', 'r1', { text: 'Used first answer.' }))
    retryFail = reduce(
      retryFail,
      wire('hexbot.rooms.turn', '', {
        room_id: room.id,
        bot: 'alpha',
        live_session_id: 'r1',
        status: 'complete'
      })
    )
    expect(summarize(retryFail.completingAsks?.alpha ?? [])).toEqual([
      { before: 'Message from', sectionId: 'th-bio', sent: false, status: 'ok', target: 'biology' }
    ])

    // 2. Biology replies ok (wait: true), then async follow-up (wait: false) using call_0 -> keeps Message from Biology.
    let followUp = reduce(restoreRoom(room, []), startTurn('r2'))
    followUp = reduce(
      followUp,
      wire('tool.start', 'r2', { tool_id: 'call_0', name: 'message_bot', args: { to: 'biology' } })
    )
    followUp = reduce(
      followUp,
      wire('tool.complete', 'r2', {
        tool_id: 'call_0',
        name: 'message_bot',
        result: { details: { section_id: 'th-bio', status: 'replied' } }
      })
    )
    followUp = reduce(
      followUp,
      wire('tool.start', 'r2', {
        tool_id: 'call_0',
        name: 'message_bot',
        args: { to: 'biology', wait: false }
      })
    )
    followUp = reduce(
      followUp,
      wire('tool.complete', 'r2', {
        tool_id: 'call_0',
        name: 'message_bot',
        result: { details: { section_id: 'th-bio', status: 'sent' } }
      })
    )
    followUp = reduce(followUp, wire('message.complete', 'r2', { text: 'Done.' }))
    followUp = reduce(
      followUp,
      wire('hexbot.rooms.turn', '', {
        room_id: room.id,
        bot: 'alpha',
        live_session_id: 'r2',
        status: 'complete'
      })
    )
    expect(summarize(followUp.completingAsks?.alpha ?? [])).toEqual([
      { before: 'Message from', sectionId: 'th-bio', sent: false, status: 'ok', target: 'biology' }
    ])

    // 3. A new message.start on the same live session resets turn.asked so a subsequent turn
    //    with zero tool calls never inherits asks from an earlier turn whose boundary was missed.
    let reusedSession = reduce(restoreRoom(room, []), startTurn('r3'))
    reusedSession = reduce(
      reusedSession,
      wire('tool.start', 'r3', { tool_id: 'call_0', name: 'message_bot', args: { to: 'biology' } })
    )
    reusedSession = reduce(
      reusedSession,
      wire('tool.complete', 'r3', {
        tool_id: 'call_0',
        name: 'message_bot',
        result: { details: { section_id: 'th-bio', status: 'replied' } }
      })
    )
    reusedSession = reduce(reusedSession, wire('message.complete', 'r3', { text: 'First reply.' }))
    expect(summarize(reusedSession.turns.r3?.asked ?? [])).toHaveLength(1)
    reusedSession = reduce(reusedSession, wire('message.start', 'r3', {}))
    expect(reusedSession.turns.r3?.asked).toEqual([])
  })

  it('restores active message_bot asks and links when a cold client opens a running room turn', () => {
    const cold = restoreRoom(
      {
        ...room,
        turns: [
          {
            bot: 'alpha',
            live_session_id: 'r-cold',
            asks: [
              {
                tool_id: 'call_0',
                message_id: 'a1',
                turn_id: 'T1',
                args: { to: 'biology', text: 'Check data', wait: true },
                context: 'biology',
                section_id: 'th-bio',
                status: 'running'
              }
            ]
          }
        ]
      },
      []
    )
    expect(cold.busy).toBe(true)
    expect(cold.turns['r-cold']?.tools).toMatchObject([
      { id: 'call_0', name: 'message_bot', status: 'running', row: 'a1', hydrated: true }
    ])
    expect(
      asksOf(
        (cold.turns['r-cold']?.asked ?? []).map(t => ({
          args: t.args,
          name: t.name,
          result: t.detail,
          status: t.status,
          summary: t.action
        }))
      )
    ).toEqual([{ sectionId: 'th-bio', sent: false, status: 'running', target: 'biology' }])

    // Settling via an untagged tool.complete updates the hydrated ask in place.
    const settled = reduce(
      cold,
      wire('tool.complete', 'r-cold', {
        turn_id: 'T1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        result: { details: { section_id: 'th-bio', status: 'replied' } }
      })
    )
    expect(settled.turns['r-cold']?.asked).toHaveLength(1)
    expect(
      asksOf(
        (settled.turns['r-cold']?.asked ?? []).map(t => ({
          args: t.args,
          name: t.name,
          result: t.detail,
          status: t.status,
          summary: t.action
        }))
      )
    ).toEqual([{ sectionId: 'th-bio', sent: false, status: 'ok', target: 'biology' }])

    // 2. Snapshot already holds a completed tagged ask; replaying buffered tool.start +
    //    tool.complete with the same message_id keeps one settled entry instead of a running dupe.
    const completedSnapshot = restoreRoom(
      {
        ...room,
        turns: [
          {
            bot: 'alpha',
            live_session_id: 'r-done',
            asks: [
              {
                tool_id: 'call_0',
                message_id: 'a1',
                turn_id: 'T2',
                args: { to: 'biology', wait: true },
                context: 'biology',
                result: { details: { reply: 'Bio ok', section_id: 'th-bio' } },
                section_id: 'th-bio',
                status: 'ok'
              }
            ]
          }
        ]
      },
      []
    )
    let replayedDone = reduce(
      completedSnapshot,
      wire('tool.start', 'r-done', {
        turn_id: 'T2',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology', wait: true }
      })
    )
    replayedDone = reduce(
      replayedDone,
      wire('tool.complete', 'r-done', {
        turn_id: 'T2',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        result: { details: { reply: 'Bio ok', section_id: 'th-bio' } }
      })
    )
    expect(replayedDone.turns['r-done']?.tools).toHaveLength(1)
    expect(replayedDone.turns['r-done']?.asked).toHaveLength(1)
    expect(
      asksOf(
        (replayedDone.turns['r-done']?.asked ?? []).map(t => ({
          args: t.args,
          name: t.name,
          result: t.detail,
          status: t.status,
          summary: t.action
        }))
      )
    ).toEqual([{ sectionId: 'th-bio', sent: false, status: 'ok', target: 'biology' }])

    // 3. Replaying a buffered message.start + tool.start from the same snapshotted turn keeps
    //    "Messaging Biology" and its thread section_id intact instead of clearing it.
    let replayedStart = reduce(cold, wire('message.start', 'r-cold', { turn_id: 'T1' }))
    expect(
      asksOf(
        (replayedStart.turns['r-cold']?.asked ?? []).map(t => ({
          args: t.args,
          name: t.name,
          result: t.detail,
          status: t.status,
          summary: t.action
        }))
      )
    ).toEqual([{ sectionId: 'th-bio', sent: false, status: 'running', target: 'biology' }])
    replayedStart = reduce(
      replayedStart,
      wire('tool.start', 'r-cold', {
        turn_id: 'T1',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology', text: 'Check data', wait: true }
      })
    )
    expect(replayedStart.turns['r-cold']?.asked).toHaveLength(1)
    expect(
      asksOf(
        (replayedStart.turns['r-cold']?.asked ?? []).map(t => ({
          args: t.args,
          name: t.name,
          result: t.detail,
          status: t.status,
          summary: t.action
        }))
      )
    ).toEqual([{ sectionId: 'th-bio', sent: false, status: 'running', target: 'biology' }])

    // 4. Three identical asks reusing call_0 with distinct occurrence_ids: replaying buffered
    //    untagged start+complete for #2 keeps #3 running ("Messaging Biology").
    const threeIdentical = restoreRoom(
      {
        ...room,
        turns: [
          {
            bot: 'alpha',
            live_session_id: 'r-three',
            turn_id: 'T3',
            asks: [
              {
                occurrence_id: 'occ-1',
                tool_id: 'call_0',
                args: { to: 'biology', text: 'Ping', wait: true },
                context: 'biology',
                result: { details: { reply: 'OK', section_id: 'th-bio' } },
                section_id: 'th-bio',
                status: 'ok',
                turn_id: 'T3'
              },
              {
                occurrence_id: 'occ-2',
                tool_id: 'call_0',
                args: { to: 'biology', text: 'Ping', wait: true },
                context: 'biology',
                result: { details: { reply: 'OK', section_id: 'th-bio' } },
                section_id: 'th-bio',
                status: 'ok',
                turn_id: 'T3'
              },
              {
                occurrence_id: 'occ-3',
                tool_id: 'call_0',
                args: { to: 'biology', text: 'Ping', wait: true },
                context: 'biology',
                section_id: 'th-bio',
                status: 'running',
                turn_id: 'T3'
              }
            ]
          }
        ]
      },
      []
    )
    let replayedMiddle = reduce(
      threeIdentical,
      wire('tool.start', 'r-three', {
        turn_id: 'T3',
        occurrence_id: 'occ-2',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology', text: 'Ping', wait: true }
      })
    )
    replayedMiddle = reduce(
      replayedMiddle,
      wire('tool.complete', 'r-three', {
        turn_id: 'T3',
        occurrence_id: 'occ-2',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        result: { details: { reply: 'OK', section_id: 'th-bio' } }
      })
    )
    expect(replayedMiddle.turns['r-three']?.asked?.map(t => [t.occurrenceId, t.status])).toEqual([
      ['occ-1', 'ok'],
      ['occ-2', 'ok'],
      ['occ-3', 'running']
    ])
    expect(
      asksOf(
        (replayedMiddle.turns['r-three']?.asked ?? []).map(t => ({
          args: t.args,
          name: t.name,
          occurrenceId: t.occurrenceId,
          result: t.detail,
          status: t.status,
          summary: t.action
        }))
      )
    ).toEqual([{ sectionId: 'th-bio', sent: false, status: 'running', target: 'biology' }])

    // 5. mergeAsked preserves snapshot first-call order and never duplicates ordinary tools.
    const bashTool = { id: 'b1', name: 'bash', args: { command: 'ls' }, detail: '', status: 'ok' as const }
    const bioAsk = {
      id: 'call_0',
      occurrenceId: 'occ-b',
      name: 'message_bot',
      args: { to: 'biology' },
      detail: '',
      status: 'running' as const
    }
    const chemAsk = {
      id: 'call_1',
      occurrenceId: 'occ-c',
      name: 'message_bot',
      args: { to: 'chemistry' },
      detail: '',
      status: 'running' as const
    }
    const mergedOrder = mergeAsked([bashTool, chemAsk], [bioAsk, chemAsk])
    expect(mergedOrder.map(t => t.id)).toEqual(['b1', 'call_0', 'call_1'])
    expect(mergeAsked(mergedOrder, [bioAsk, chemAsk]).filter(t => t.name === 'bash')).toHaveLength(1)

    // 6. Snapshot merge inserts missed asks after the last matched call and ahead of a newer
    //    live ask that arrived after the snapshot was sampled.
    const histAsk = {
      id: 'call_3',
      occurrenceId: 'occ-h',
      name: 'message_bot',
      args: { to: 'history' },
      detail: '',
      status: 'running' as const
    }
    const physAsk = {
      id: 'call_2',
      occurrenceId: 'occ-p',
      name: 'message_bot',
      args: { to: 'physics' },
      detail: '',
      status: 'ok' as const
    }
    expect(
      mergeAsked([bioAsk, histAsk], [bioAsk, chemAsk, physAsk], 'prepend').map(
        t => (t.args as { to?: string })?.to
      )
    ).toEqual(['biology', 'chemistry', 'physics', 'history'])

    // 7. Nested codemode ask hydrated from a room snapshot retains parentToolCallId so
    //    its live tool.complete settles in place.
    const nestedCold = restoreRoom(
      {
        ...room,
        turns: [
          {
            id: 'rt-nested',
            bot: 'alpha',
            live_session_id: 'r-nested',
            turn_id: 'T-nested',
            asks: [
              {
                tool_id: 'code/1',
                parent_tool_call_id: 'code',
                turn_id: 'T-nested',
                args: { to: 'biology', wait: true },
                context: 'biology',
                section_id: 'th-bio',
                status: 'running'
              }
            ]
          }
        ]
      },
      []
    )
    const nestedSettled = reduce(
      nestedCold,
      wire('tool.complete', 'r-nested', {
        turn_id: 'T-nested',
        tool_id: 'code/1',
        parent_tool_call_id: 'code',
        name: 'message_bot',
        context: 'biology',
        result: { details: { reply: 'Bio ok', section_id: 'th-bio' } }
      })
    )
    expect(nestedSettled.turns['r-nested']?.asked).toMatchObject([
      { id: 'code/1', parentToolCallId: 'code', status: 'ok' }
    ])

    // 8. A fallback continuation (`message.start` with a new turn_id before `message.complete`)
    //    preserves earlier asks from the same running room turn.
    let fallbackTurn = reduce(
      restoreRoom(room, []),
      wire('hexbot.rooms.turn', '', {
        id: 'rt-fb',
        room_id: room.id,
        bot: 'alpha',
        live_session_id: 'r-fb',
        status: 'running'
      })
    )
    fallbackTurn = reduce(fallbackTurn, wire('message.start', 'r-fb', { turn_id: 'T1' }))
    fallbackTurn = reduce(
      fallbackTurn,
      wire('tool.start', 'r-fb', {
        turn_id: 'T1',
        occurrence_id: 'occ-b',
        tool_id: 'call_0',
        name: 'message_bot',
        args: { to: 'biology', wait: true }
      })
    )
    fallbackTurn = reduce(
      fallbackTurn,
      wire('tool.complete', 'r-fb', {
        turn_id: 'T1',
        occurrence_id: 'occ-b',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        result: { details: { reply: 'Bio ok', section_id: 'th-bio' } }
      })
    )
    fallbackTurn = reduce(fallbackTurn, wire('message.start', 'r-fb', { turn_id: 'T2' }))
    expect(fallbackTurn.turns['r-fb']?.asked).toMatchObject([
      { id: 'call_0', occurrenceId: 'occ-b', status: 'ok' }
    ])

    // 9. mergeAsked keeps sequential codemode nested asks with distinct parentOccurrenceId separate.
    const mergedParents = mergeAsked(
      [
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          parentOccurrenceId: 'occ-p2',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '',
          status: 'running'
        }
      ],
      [
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          parentOccurrenceId: 'occ-p1',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '{"section_id":"th-bio"}',
          status: 'ok'
        }
      ],
      'prepend'
    )
    expect(mergedParents.map(t => [t.parentOccurrenceId, t.status])).toEqual([
      ['occ-p1', 'ok'],
      ['occ-p2', 'running']
    ])

    // 10. mergeAsked matches same-parent nested codemode asks across all three reconnect cases:
    //     (a) stale running snapshot vs settled live ask (never regresses to running)
    const staleNestedSnap = mergeAsked(
      [
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          parentOccurrenceId: 'occ-p1',
          row: 'a1',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '{"section_id":"th-bio"}',
          status: 'ok'
        }
      ],
      [
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          parentOccurrenceId: 'occ-p1',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '',
          status: 'running',
          hydrated: true
        }
      ],
      'prepend'
    )
    expect(staleNestedSnap).toHaveLength(1)
    expect(staleNestedSnap[0]).toMatchObject({
      id: 'code_0/1',
      parentOccurrenceId: 'occ-p1',
      row: 'a1',
      status: 'ok'
    })

    //     (b) missed tool.complete: settled snapshot without row settles running live ask with inherited row
    const missedCompleteNested = mergeAsked(
      [
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          parentOccurrenceId: 'occ-p1',
          row: 'a1',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '',
          status: 'running'
        }
      ],
      [
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          parentOccurrenceId: 'occ-p1',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '{"section_id":"th-bio"}',
          status: 'ok'
        }
      ],
      'prepend'
    )
    expect(missedCompleteNested).toHaveLength(1)
    expect(missedCompleteNested[0]).toMatchObject({
      id: 'code_0/1',
      parentOccurrenceId: 'occ-p1',
      row: 'a1',
      status: 'ok',
      detail: '{"section_id":"th-bio"}'
    })

    //     (c) mid-ask reconnect: running snapshot without row deduplicates with running live ask
    //         and later tool.complete settles the single entry cleanly.
    const liveMidAsk = {
      id: 'code_0/1',
      name: 'message_bot',
      parentToolCallId: 'code_0',
      parentOccurrenceId: 'occ-p1',
      row: 'a1',
      args: { to: 'biology', text: 'Check', wait: true },
      action: 'biology',
      detail: '',
      status: 'running' as const
    }
    const snapMidAsk = {
      id: 'code_0/1',
      name: 'message_bot',
      parentToolCallId: 'code_0',
      parentOccurrenceId: 'occ-p1',
      args: { to: 'biology', text: 'Check', wait: true },
      action: 'biology',
      detail: '',
      status: 'running' as const,
      hydrated: true
    }
    const dedupedMidAsk = mergeAsked([liveMidAsk], [snapMidAsk], 'prepend')
    expect(dedupedMidAsk).toHaveLength(1)
    expect(dedupedMidAsk[0]).toMatchObject({
      id: 'code_0/1',
      parentOccurrenceId: 'occ-p1',
      row: 'a1',
      status: 'running'
    })
    const midRoomBase = restoreRoom(
      {
        ...room,
        turns: [
          {
            id: 'rt-mid',
            bot: 'alpha',
            live_session_id: 'r-mid',
            turn_id: 'T-mid'
          }
        ]
      },
      []
    )
    const midRoom = {
      ...midRoomBase,
      turns: {
        'r-mid': {
          ...midRoomBase.turns['r-mid']!,
          tools: dedupedMidAsk,
          asked: dedupedMidAsk
        }
      }
    }
    const afterMidComplete = reduce(
      midRoom,
      wire('tool.complete', 'r-mid', {
        turn_id: 'T-mid',
        tool_id: 'code_0/1',
        parent_tool_call_id: 'code_0',
        name: 'message_bot',
        context: 'biology',
        result: { details: { reply: 'Bio ok', section_id: 'th-bio' } }
      })
    )
    expect(afterMidComplete.turns['r-mid']?.asked).toHaveLength(1)
    expect(afterMidComplete.turns['r-mid']?.asked?.[0]).toMatchObject({
      id: 'code_0/1',
      parentOccurrenceId: 'occ-p1',
      status: 'ok'
    })

    //     (d) stale running snapshot (`hydrated: true`) vs settled live nested ask after a
    //         mid-codemode cold join where the live ask lacked `parentOccurrenceId` (and legacy
    //         daemons where neither side carries `parentOccurrenceId`).
    const coldJoinStale = mergeAsked(
      [
        {
          id: 'code_0/2',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          args: { to: 'biology', text: 'Second', wait: true },
          action: 'biology',
          detail: '{"section_id":"th-bio"}',
          status: 'ok'
        }
      ],
      [
        {
          id: 'code_0/2',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          parentOccurrenceId: 'occ-p1',
          args: { to: 'biology', text: 'Second', wait: true },
          action: 'biology',
          detail: '',
          status: 'running',
          hydrated: true
        }
      ],
      'prepend'
    )
    expect(coldJoinStale).toHaveLength(1)
    expect(coldJoinStale[0]).toMatchObject({
      id: 'code_0/2',
      parentOccurrenceId: 'occ-p1',
      status: 'ok'
    })

    const legacyStale = mergeAsked(
      [
        {
          id: 'code_0/2',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          args: { to: 'biology', text: 'Second', wait: true },
          action: 'biology',
          detail: '{"section_id":"th-bio"}',
          status: 'ok'
        }
      ],
      [
        {
          id: 'code_0/2',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          args: { to: 'biology', text: 'Second', wait: true },
          action: 'biology',
          detail: '',
          status: 'running',
          hydrated: true
        }
      ],
      'prepend'
    )
    expect(legacyStale).toHaveLength(1)
    expect(legacyStale[0]).toMatchObject({ id: 'code_0/2', status: 'ok' })

    //     (e) whole-reconnect sequence: two codemode parents reusing `code_0/1` on the same
    //         shared peer thread (`th-bio`, `occ-p1` ok, `occ-p2` running) restored from snapshot,
    //         then live `tool.complete` carrying `parent_occurrence_id: 'occ-p2'` settles only
    //         `occ-p2` without re-binding `occ-p1`.
    const twoParentRestored = restoreRoom(
      {
        ...room,
        turns: [
          {
            id: 'rt-two',
            bot: 'alpha',
            live_session_id: 'r-two',
            turn_id: 'T-two',
            asks: [
              {
                tool_id: 'code_0/1',
                parent_tool_call_id: 'code_0',
                parent_occurrence_id: 'occ-p1',
                args: { to: 'biology', text: 'Check', wait: true },
                context: 'biology',
                section_id: 'th-bio',
                status: 'ok'
              },
              {
                tool_id: 'code_0/1',
                parent_tool_call_id: 'code_0',
                parent_occurrence_id: 'occ-p2',
                args: { to: 'biology', text: 'Check', wait: true },
                context: 'biology',
                status: 'running'
              }
            ]
          }
        ]
      },
      []
    )
    const afterTwoComplete = reduce(
      twoParentRestored,
      wire('tool.complete', 'r-two', {
        turn_id: 'T-two',
        tool_id: 'code_0/1',
        parent_tool_call_id: 'code_0',
        parent_occurrence_id: 'occ-p2',
        name: 'message_bot',
        context: 'biology',
        result: { details: { reply: 'Second ok', section_id: 'th-bio' } }
      })
    )
    expect(
      afterTwoComplete.turns['r-two']?.asked?.map(t => [t.parentOccurrenceId, t.status])
    ).toEqual([
      ['occ-p1', 'ok'],
      ['occ-p2', 'ok']
    ])
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

  it('names people in a Discord channel as Discord showed them', () => {
    const state = restoreRoom(room, [
      {
        ...log(
          1,
          'message.user',
          { author: { id: '300', name: 'Sam' }, text: 'What is new?' },
          '300'
        ),
        actor_kind: 'discord'
      },
      { ...log(2, 'message.user', { text: 'No name' }, '301'), actor_kind: 'discord' }
    ])
    expect(state.messages[0]).toMatchObject({ sender: '300', senderName: 'Sam', role: 'user' })
    expect(state.messages[1].senderName).toBe('Someone')
  })
})
