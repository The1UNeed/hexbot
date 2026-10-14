import { describe, expect, it } from 'vitest'
import type { GatewayEvent } from '@hermes/shared'
import {
  clearStatusProof,
  emptyChat,
  reduceChat,
  restoreChat,
  rosterChat,
  settledBot
} from './chat'
import { reduceRoom, restoreRoom } from './room-chat'
import type { Bot, ChatState, Room } from './types'

const event = (
  type: string,
  payload: Record<string, unknown> = {},
  revision = 2,
  seq = revision,
  session_id = 'live'
): GatewayEvent => ({ type, payload, session_id, mobileRevision: revision, seq }) as GatewayEvent
const retry = (detail: Partial<NonNullable<Bot['status_detail']>> = {}): Bot =>
  ({
    name: 'owl',
    status: 'stopped',
    status_detail: {
      text: 'The previous turn failed',
      action: { kind: 'retry' },
      section_id: 'section',
      session_id: 'live',
      room_id: null,
      since: 1,
      ...detail
    }
  }) as Bot
const started = () => reduceChat(emptyChat(), event('message.start', { retry_resolved: true }))
const project = (state: ChatState, bot = retry(), sectionId: string | null = 'section') =>
  settledBot(bot, state, 'live', sectionId)

describe('exact private retry proof', () => {
  it('replaces the matching failed section while a roster refresh is unavailable', () => {
    const state = started()
    expect(project(state).status).toBe('working')
    expect(project(state).status_detail?.action).toBeNull()
    expect(project(state, retry({ session_id: null })).status).toBe('working')
    expect(state.resumedWaiting).toBe(false)
  })

  it.each([
    { section_id: 'sibling' },
    { section_id: null },
    { session_id: 'other-live' },
    { room_id: 'room' },
    { action: { kind: 'fix_connector', connector: 'mail' } },
    { action: null }
  ] as Partial<NonNullable<Bot['status_detail']>>[])(
    'keeps unrelated failure detail %j stopped',
    detail => {
      const bot = retry(detail)
      expect(project(started(), bot)).toBe(bot)
    }
  )

  it('requires both a private section identity and the same live session', () => {
    const state = started()
    const bot = retry()
    expect(project(state, bot, null)).toBe(bot)
    expect(settledBot(bot, state, 'other-live', 'section')).toBe(bot)
    const wrong = reduceChat(
      emptyChat(),
      event('message.start', { retry_resolved: true }, 2, 2, 'other-live')
    )
    expect(project(wrong, bot)).toBe(bot)
  })

  it.each([
    event('message.start'),
    event('message.start', { retry_resolved: 'true' }),
    event('status.update', { kind: 'working', text: 'Working' }),
    event('message.delta', { text: 'A new reply' })
  ])('does not infer resolution from an unmarked event %j', input => {
    const bot = retry()
    expect(project(reduceChat(emptyChat(), input), bot)).toBe(bot)
  })

  it('shows retry questions and approvals without accepting an unrelated human answer', () => {
    const question = event('clarify.request', { request_id: 'question', question: 'Why?' }, 3)
    const approval = event(
      'approval.request',
      { request_id: 'approval', choices: ['once', 'deny'] },
      4
    )
    let state = reduceChat(reduceChat(started(), question), approval)
    expect(project(state).status).toBe('needs_you')
    state = reduceChat(
      state,
      event('approval.resolved', { request_id: 'approval', choice: 'once' }, 5)
    )
    expect(project(state).status).toBe('needs_you')
    state = reduceChat(
      state,
      event(
        'clarify.resolved',
        { request_id: 'question', answers: { question: 'Because' }, status: 'answered' },
        6
      )
    )
    expect(project(state).status).toBe('working')
    state = reduceChat(state, event('message.complete', { text: 'Done' }, 7))
    expect(project(state).status).toBe('idle')
  })

  it.each([
    event('error', { message: 'Failed again' }, 3),
    event('message.complete', { error: 'Failed again', status: 'error' }, 3),
    event('message.complete', { status: 'error' }, 3),
    event('status.update', { kind: 'error' }, 3),
    event('status.update', { kind: 'interrupted' }, 3)
  ])('revokes resolution when the new turn fails or stops: %j', failure => {
    const failed = reduceChat(started(), failure)
    const bot = retry({ text: 'Failed again', since: 3 })
    expect(project(failed, bot)).toBe(bot)
    expect(project(reduceChat(failed, event('message.start', {}, 4)), bot)).toBe(bot)
    expect(
      project(reduceChat(failed, event('message.start', { retry_resolved: true }, 5)), bot).status
    ).toBe('working')
  })

  it('keeps proof through success and compaction but resets it with a new snapshot', () => {
    const completed = reduceChat(started(), event('message.complete', { text: 'Done' }, 3))
    expect(project(completed).status).toBe('idle')
    expect(project(reduceChat(completed, event('message.start', {}, 4))).status).toBe('working')
    const restored = restoreChat({ ...emptyChat(), busy: true }, 'live', undefined, []).state
    expect(project(restored, retry()).status).toBe('stopped')
    const replayed = restoreChat(emptyChat(), 'live', undefined, [
      event('message.start', { retry_resolved: true })
    ]).state
    expect(project(replayed).status).toBe('working')
  })

  it('keeps evidence accepted during a roster read and retires evidence from before it', () => {
    const state = started()
    expect(project(rosterChat(state, 1)).status).toBe('working')
    expect(project(rosterChat(state, 2)).status).toBe('stopped')
    expect(project(rosterChat(state, 3)).status).toBe('stopped')
    const idle = { ...retry(), status: 'idle' as const, status_detail: null }
    expect(project(state, idle)).toBe(idle)
  })

  it('does not renew retired or failed proof with a duplicate wire marker', () => {
    const old = event('message.start', { retry_resolved: true }, 2, 10)
    const state = reduceChat(emptyChat(), old)
    const retired = rosterChat(state, 2)
    const duplicate = reduceChat(retired, { ...old, mobileRevision: 4 } as GatewayEvent)
    expect(duplicate).toBe(retired)
    expect(project(duplicate).status).toBe('stopped')
    const failed = reduceChat(state, event('error', { message: 'Failed again' }, 3, 11))
    expect(reduceChat(failed, old)).toBe(failed)
    expect(
      project(reduceChat(failed, event('message.start', { retry_resolved: true }, 4, 12))).status
    ).toBe('working')
  })

  it('cannot resolve a private incident using a room turn with the same session ID', () => {
    const room = {
      id: 'room',
      members: [],
      turns: [{ bot: 'owl', live_session_id: 'live' }]
    } as unknown as Room
    const state = reduceRoom(
      restoreRoom(room, []),
      event('message.start', { retry_resolved: true }),
      room,
      id => id
    )
    const bot = retry({ room_id: 'room' })
    expect(settledBot(bot, state.turns.live, 'live')).toBe(bot)
    expect(settledBot(retry(), state.turns.live, 'live').status).toBe('stopped')
  })

  it('clears old status proof at an epoch boundary while retaining accepted cards and pending siblings', () => {
    let state = reduceChat(emptyChat(), event('message.start', { retry_resolved: true }, 2, 100))
    state = reduceChat(
      state,
      event('approval.request', { request_id: 'approval', choices: ['once'] }, 3, 101)
    )
    state = reduceChat(
      state,
      event('approval.resolved', { request_id: 'approval', choice: 'once' }, 4, 102)
    )
    const pending = reduceChat(
      emptyChat(),
      event('approval.request', { request_id: 'pending', choices: ['once'] }, 5, 103)
    )
    const cleared = clearStatusProof({
      ...state,
      turns: {
        live: { ...state, bot: 'owl', sessionId: 'live' },
        sibling: { ...pending, bot: 'fox', sessionId: 'sibling' }
      }
    })
    expect(cleared.retryResolution).toBeUndefined()
    expect(cleared.turns.live.retryResolution).toBeUndefined()
    expect(cleared.resumedWaiting).toBe(false)
    expect(cleared.waitingRevision).toBe(0)
    expect(cleared.turns.live.resumedWaiting).toBe(false)
    expect(cleared.turns.live.waitingRevision).toBe(0)
    expect(cleared.turns.sibling.approvals).toBe(pending.approvals)
    expect(cleared.turns.sibling.waiting).toBe(true)
    expect(cleared.settlements).toBe(state.settlements)
    expect(project(cleared).status).toBe('stopped')
    expect(
      project(reduceChat(cleared, event('message.start', { retry_resolved: true }, 5, 1))).status
    ).toBe('working')
  })
})
