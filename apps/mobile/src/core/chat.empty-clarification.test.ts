import { describe, expect, it } from 'vitest'
import type { GatewayEvent } from '@hermes/shared'
import {
  clarifyResponse,
  emptyChat,
  reduceChat,
  replayChat,
  restoreChat,
  rosterChat,
  settledBot
} from './chat'
import { reduceRoom, restoreRoom } from './room-chat'
import type { Bot, Room } from './types'
import { chatActivityLabel } from './tools'

const event = (
  type: string,
  payload: Record<string, unknown>,
  session_id = 's1',
  revision = 1
): GatewayEvent => ({ type, session_id, payload, mobileRevision: revision }) as GatewayEvent
const request = (
  ids = ['first', 'last'],
  answers?: Record<string, string>,
  request_id = 'batch',
  sid = 's1'
) =>
  event(
    'clarify.request',
    {
      request_id,
      questions: ids.map(qid => ({ qid, question: `${qid}?` })),
      ...(answers ? { answers } : {})
    },
    sid
  )
const resolve = (
  status: 'waiting' | 'answered',
  answers: Record<string, string>,
  remaining?: string[],
  request_id = 'batch',
  sid = 's1',
  revision = 2
) =>
  event(
    'clarify.resolved',
    { request_id, status, answers, ...(remaining ? { remaining } : {}) },
    sid,
    revision
  )
const full = { first: 'Here', last: 'Now' }
const idle = { name: 'alpha', status: 'idle', status_detail: null } as Bot
const key = JSON.stringify(['clarify', 's1', 'batch'])

describe('empty clarification card projection', () => {
  it.each([['first', 'last'], ['first', 'first', 'last'], ['first']].map(ids => [ids] as const))(
    'removes the covered visible batch %j without declaring the request answered',
    ids => {
      const before = reduceChat(emptyChat(), request([...ids]))
      const state = reduceChat(before, resolve('waiting', full))
      expect(state.questions).toEqual([])
      expect(state).toMatchObject({
        busy: true,
        waiting: false,
        resumedWaiting: true,
        waitingRevision: 2
      })
      expect(state.settlements[key].answered).not.toBe(true)
      expect(state.settlements[key].closed).not.toBe(true)
      expect(chatActivityLabel(state)).toBe('Working')
      expect(settledBot(idle, state, 's1', 'section').status).toBe('working')
    }
  )

  it.each(['live', 'replay', 'snapshot'] as const)(
    'does not insert an empty %s card for questions already covered by a partial settlement',
    flow => {
      const before = reduceChat(reduceChat(emptyChat(), request()), resolve('waiting', full))
      const state =
        flow === 'live'
          ? reduceChat(before, request())
          : flow === 'replay'
            ? replayChat(before, [request()]).state
            : restoreChat(before, 's1', request().payload as Record<string, unknown>, []).state
      expect(state.questions).toEqual([])
      expect(state.waiting).toBe(false)
      expect(state.resumedWaiting).toBe(true)
      expect(state.waitingRevision).toBe(2)
    }
  )

  it('keeps a cold fully covered snapshot quiet rather than creating a human wait', () => {
    const state = reduceChat(emptyChat(), request(['first', 'last'], full))
    expect(state.questions).toEqual([])
    expect(state).toMatchObject({ busy: false, waiting: false, resumedWaiting: false })
    expect(state.settlements[key].answered).not.toBe(true)
  })

  it('does not disturb automatic waiting when an empty request has no seen card', () => {
    const before = reduceChat(
      emptyChat(),
      event('status.update', { kind: 'waiting', text: 'Retrying the model request' })
    )
    const state = reduceChat(before, request(['first'], { first: '' }))
    expect(state.questions).toEqual([])
    expect(state.waiting).toBe(before.waiting)
    expect(state.activity).toBe('Retrying the model request')
    expect(state.resumedWaiting).toBe(false)
  })

  it('keeps unknown remaining IDs unproven and later resumes on a canonical completion', () => {
    let state = reduceChat(emptyChat(), request())
    state = reduceChat(state, resolve('waiting', full, ['new']))
    expect(state.questions).toEqual([])
    expect(state.waiting).toBe(true)
    expect(state.resumedWaiting).toBe(false)
    expect(state.settlements[key].answered).not.toBe(true)
    state = reduceChat(
      state,
      resolve('answered', { ...full, new: 'Yes' }, undefined, 'batch', 's1', 4)
    )
    expect(state).toMatchObject({ waiting: false, resumedWaiting: true, waitingRevision: 4 })
    expect(state.settlements[key].answered).toBe(true)
  })

  it('passes a canonical unknown remainder through the local response projection', () => {
    let state = reduceChat(emptyChat(), request())
    const reply = clarifyResponse(state.questions[0], 'last', 'Now', {
      status: 'waiting',
      answers: full,
      remaining: ['new']
    })
    expect(reply.payload).toMatchObject({ status: 'waiting', remaining: ['new'] })
    state = reduceChat(state, reply)
    expect(state.questions).toEqual([])
    expect(state.resumedWaiting).toBe(false)
    expect(state.waiting).toBe(true)
  })

  it('keeps a partial batch and preserves an unanswered new ID omitted by an empty replay', () => {
    let state = reduceChat(emptyChat(), request(['first', 'new']))
    state = reduceChat(state, resolve('waiting', { first: 'Here' }, ['new']))
    expect(state.questions[0].questions.map(q => q.id)).toEqual(['new'])
    state = reduceChat(state, request(['first'], { first: 'Here' }))
    expect(state.questions[0].questions.map(q => q.id)).toEqual(['new'])
    expect(state.waiting).toBe(true)
    expect(state.resumedWaiting).toBe(false)
  })

  it('accepts a real new ID after removing an exhausted visible card', () => {
    let state = reduceChat(reduceChat(emptyChat(), request()), resolve('waiting', full))
    state = reduceChat(state, request(['first', 'last', 'new']))
    expect(state.questions[0].questions.map(q => q.id)).toEqual(['new'])
    expect(state).toMatchObject({ waiting: true, resumedWaiting: false })
    state = reduceChat(state, resolve('answered', { ...full, new: 'Yes' }))
    expect(state.questions).toEqual([])
    expect(state.waiting).toBe(false)
  })

  it.each(['approval', 'question'] as const)(
    'keeps a sibling %s waiting after removing the exhausted batch',
    sibling => {
      let state = reduceChat(emptyChat(), request())
      state = reduceChat(
        state,
        sibling === 'approval'
          ? event('approval.request', { request_id: 'sibling' })
          : request(['only'], undefined, 'sibling')
      )
      state = reduceChat(state, resolve('waiting', full))
      expect(state.questions.map(q => q.requestId)).toEqual(
        sibling === 'approval' ? [] : ['sibling']
      )
      expect(state.approvals.map(q => q.requestId)).toEqual(
        sibling === 'approval' ? ['sibling'] : []
      )
      expect(state).toMatchObject({ waiting: true, resumedWaiting: false })
    }
  )

  it('does not renew completion proof through a replay after canonical settlement', () => {
    let state = reduceChat(reduceChat(emptyChat(), request()), resolve('answered', full))
    state = reduceChat(
      state,
      event('status.update', { kind: 'waiting', text: 'Retrying the model request' }, 's1', 3)
    )
    const before = state
    state = reduceChat(state, request())
    state = reduceChat(state, resolve('answered', full, undefined, 'batch', 's1', 6))
    expect(state.questions).toEqual([])
    expect(state.activity).toBe(before.activity)
    expect(state.waitingRevision).toBe(before.waitingRevision)
  })

  it('keeps expiry closed even when a later request uses new question IDs', () => {
    let state = reduceChat(emptyChat(), request())
    state = reduceChat(state, event('clarify.expire', { request_id: 'batch' }))
    state = reduceChat(state, request(['new']))
    expect(state.questions).toEqual([])
    expect(state.settlements[key].closed).toBe(true)
  })

  it('does not create answer proof for a never-seen request or the wrong session', () => {
    let state = reduceChat(
      emptyChat(),
      event('status.update', { kind: 'waiting', text: 'Retrying the model request' })
    )
    state = reduceChat(state, resolve('waiting', full))
    state = reduceChat(state, resolve('answered', full))
    expect(state.resumedWaiting).toBe(false)
    state = reduceChat(state, request(['first', 'last'], undefined, 'fresh'))
    state = reduceChat(state, resolve('waiting', full, undefined, 'fresh', 'other'))
    expect(state.questions[0].questions.map(q => q.id)).toEqual(['first', 'last'])
  })

  it('keeps the status receipt cutoff after the last visible question is accepted', () => {
    const state = reduceChat(reduceChat(emptyChat(), request()), resolve('waiting', full))
    expect(settledBot(idle, state, 's1', 'section').status).toBe('working')
    expect(settledBot(idle, rosterChat(state, 2), 's1', 'section').status).toBe('idle')
  })

  it('settles one room turn without removing another bot’s question', () => {
    const room = {
      id: 'room',
      turns: [
        { bot: 'alpha', live_session_id: 's1' },
        { bot: 'beta', live_session_id: 's2' }
      ]
    } as unknown as Room
    let state = restoreRoom(room, [])
    state = reduceRoom(state, request(), room, name => name)
    state = reduceRoom(state, request(['only'], undefined, 'other', 's2'), room, name => name)
    state = reduceRoom(state, resolve('waiting', full), room, name => name)
    expect(state.turns.s1.questions).toEqual([])
    expect(state.turns.s1).toMatchObject({ waiting: false, resumedWaiting: true })
    expect(state.turns.s2.questions[0].requestId).toBe('other')
    expect(state.waiting).toBe(true)
  })
  it.each(['message.complete', 'status.update', 'error'] as const)(
    'retires only this session’s exhausted request on %s before a late replay',
    type => {
      let state = reduceChat(reduceChat(emptyChat(), request()), resolve('waiting', full, ['new']))
      state = reduceChat(state, request(['only'], undefined, 'sibling', 'other'))
      state = reduceChat(
        state,
        resolve('waiting', { only: 'Yes' }, ['unknown'], 'sibling', 'other')
      )
      state = reduceChat(
        state,
        event(type, type === 'status.update' ? { kind: 'interrupted' } : {}, 's1', 3)
      )
      expect(state.settlements[key].closed).toBe(true)
      expect(state.settlements[JSON.stringify(['clarify', 'other', 'sibling'])].closed).not.toBe(
        true
      )
      state = reduceChat(state, event('message.start', {}))
      state = reduceChat(state, event('status.update', { kind: 'waiting', text: 'Retrying' }))
      state = reduceChat(state, request(['new']))
      state = reduceChat(state, resolve('answered', { ...full, new: 'Yes' }))
      expect(state.questions).toEqual([])
      expect(state.resumedWaiting).toBe(false)
      expect(state.activity).toBe('Retrying')
    }
  )

  it('still accepts a genuinely new question ID after a canonical answered batch', () => {
    let state = reduceChat(reduceChat(emptyChat(), request()), resolve('answered', full))
    state = reduceChat(state, event('message.complete', {}))
    state = reduceChat(state, request(['first', 'last', 'new']))
    expect(state.questions[0].questions.map(q => q.id)).toEqual(['new'])
    expect(state.waiting).toBe(true)
  })
  it('does not close a later consumed batch while replaying an older completion', () => {
    const current = reduceChat(
      reduceChat(emptyChat(), request()),
      resolve('waiting', full, ['new'], 'batch', 's1', 5)
    )
    const replay = restoreChat(
      { ...emptyChat(), settlements: current.settlements },
      's1',
      undefined,
      [
        event('message.complete', {}, 's1', 3),
        event('message.start', {}, 's1', 4),
        request(['first', 'last', 'new'])
      ]
    ).state
    expect(replay.questions[0].questions.map(q => q.id)).toEqual(['new'])
    expect(replay.settlements[key].closed).not.toBe(true)
  })

  it('does not lend an exhausted request’s eventual completion to an unseen request', () => {
    let state = reduceChat(reduceChat(emptyChat(), request()), resolve('waiting', full, ['new']))
    state = reduceChat(state, resolve('answered', { ...full, new: 'Yes' }, undefined, 'unseen'))
    expect(state.waiting).toBe(true)
    expect(state.resumedWaiting).toBe(false)
    state = reduceChat(state, resolve('answered', { ...full, new: 'Yes' }, undefined, 'batch'))
    expect(state.waiting).toBe(false)
    expect(state.resumedWaiting).toBe(true)
  })
})
