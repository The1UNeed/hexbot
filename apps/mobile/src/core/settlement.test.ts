import { describe, expect, it } from 'vitest'
import type { GatewayEvent } from '@hermes/shared'
import type { Bot } from './types'
import {
  approvalResponse,
  clarifyResponse,
  emptyChat,
  reduceChat,
  replayChat,
  restoreChat,
  rosterChat,
  settledBot
} from './chat'

const event = (
  type: string,
  payload: Record<string, unknown>,
  session_id = 's1'
): GatewayEvent => ({
  type,
  session_id,
  payload
})
const approval = (request_id = 'approve') =>
  event('approval.request', {
    request_id,
    command: 'touch report',
    choices: ['once', 'session', 'deny']
  })
const question = (request_id = 'batch') =>
  event('clarify.request', {
    request_id,
    questions: [
      { qid: 'first', question: 'When?' },
      { qid: 'second', question: 'Where?' }
    ]
  })
const resolved = (answers: Record<string, string>, status = 'answered', request_id = 'batch') =>
  event('clarify.resolved', { request_id, answers, status })
const waitingBot = (session_id: string | null = 's1') =>
  ({
    name: 'alpha',
    status: 'needs_you',
    status_detail: {
      session_id,
      section_id: 'section',
      room_id: null,
      since: 1,
      text: 'Waiting',
      action: null
    }
  }) as Bot

describe('accepted request settlement', () => {
  it('projects only confirmed cards for the supplied live session, even without old roster detail', () => {
    const state = reduceChat(emptyChat(), question())
    const idle = { ...waitingBot(), status: 'idle', status_detail: null } as Bot
    expect(settledBot(idle, state, 's1', 'section')).toMatchObject({
      status: 'needs_you',
      status_detail: { session_id: 's1', section_id: 'section', room_id: null, action: null }
    })
    expect(settledBot(idle, state, 'other')).toBe(idle)
    expect(settledBot(idle, state, null)).toBe(idle)
    const stopped = { ...waitingBot(), status: 'stopped' } as Bot
    expect(settledBot(stopped, state, 's1')).toBe(stopped)
  })

  it('keeps sibling cards and their wait through a generic Working update', () => {
    let state = reduceChat(reduceChat(emptyChat(), approval()), question())
    state = reduceChat(
      state,
      event('status.update', { kind: 'waiting', text: 'Waiting for your answer' })
    )
    state = reduceChat(
      state,
      event('approval.resolved', { request_id: 'approve', choice: 'session' })
    )
    state = reduceChat(state, event('status.update', { kind: 'working', text: 'Working' }))
    expect(state.approvals).toEqual([])
    expect(state.questions).toHaveLength(1)
    expect(state).toMatchObject({
      busy: true,
      waiting: true,
      activity: 'Waiting for your answer',
      resumedWaiting: false
    })
    state = reduceChat(state, resolved({ first: '', second: 'Here' }))
    expect(state).toMatchObject({
      busy: true,
      waiting: false,
      activity: '',
      questions: [],
      resumedWaiting: true
    })
    expect(settledBot(waitingBot(), state, 's1').status).toBe('working')
  })

  it('uses exact canonical qids, including duplicate qids and empty answers', () => {
    let state = reduceChat(
      emptyChat(),
      event('clarify.request', {
        request_id: 'batch',
        questions: [
          { qid: 'first', question: 'When?' },
          { qid: 'first', question: 'When again?' },
          { qid: 'second', question: 'Where?' }
        ]
      })
    )
    state = reduceChat(state, resolved({ first: '', unrelated: 'ignored' }, 'waiting'))
    expect(state.questions[0].questions.map(q => q.id)).toEqual(['second'])
    expect(state.waiting).toBe(true)
    state = reduceChat(state, resolved({ unrelated: 'ignored' }))
    expect(state.questions[0].questions.map(q => q.id)).toEqual(['second'])
    state = reduceChat(state, resolved({ first: '', second: 'Here' }))
    expect(state.questions).toEqual([])
    expect(state.waiting).toBe(false)
  })

  it('remembers answers arriving before cards and does not let stale snapshots overwrite them', () => {
    let state = reduceChat(emptyChat(), resolved({ first: 'Canonical' }, 'waiting'))
    state = reduceChat(state, {
      ...question(),
      payload: { ...(question().payload as Record<string, unknown>), answers: { first: 'Old' } }
    })
    expect(state.questions[0].questions.map(q => q.id)).toEqual(['second'])
    expect(Object.values(state.settlements)[0].answers).toEqual({ first: 'Canonical' })
    state = reduceChat(state, resolved({ first: 'Canonical', second: 'Here' }))
    expect(reduceChat(state, question())).toBe(state)
  })

  it('does not revive Idle from a full settlement received before a stale card', () => {
    let state = reduceChat(emptyChat(), resolved({ first: 'Now', second: 'Here' }))
    state = reduceChat(state, event('status.update', { kind: 'idle', text: 'Idle' }))
    expect(reduceChat(state, question())).toBe(state)
    expect(state).toMatchObject({ busy: false, waiting: false, questions: [], activity: 'Idle' })
    const unrelated = reduceChat(emptyChat(), resolved({ unrelated: 'x' }))
    expect(reduceChat(unrelated, question()).questions[0].questions).toHaveLength(2)
  })

  it('preserves newer completion and a new turn when old canonical responses arrive', () => {
    let state = reduceChat(reduceChat(emptyChat(), question()), approval())
    const localApproval = approvalResponse(state.approvals[0], 'always', {
      resolved: true,
      choice: 'session'
    })!
    const localQuestion = clarifyResponse(state.questions[0], 'first', 'Guess', {
      status: 'answered',
      answers: { first: 'Canonical', second: 'Here' }
    })
    state = reduceChat(state, event('message.complete', { text: 'Done' }))
    state = reduceChat(reduceChat(state, localApproval), localQuestion)
    expect(state).toMatchObject({
      busy: false,
      waiting: false,
      activity: '',
      questions: [],
      approvals: []
    })
    expect(reduceChat(state, question())).toBe(state)
    state = reduceChat(state, event('message.start', {}))
    state = reduceChat(state, event('status.update', { kind: 'working', text: 'New turn' }))
    state = reduceChat(reduceChat(state, localApproval), localQuestion)
    expect(state).toMatchObject({
      busy: true,
      waiting: false,
      activity: 'New turn',
      resumedWaiting: false
    })
  })

  it('restores a cold pending snapshot before buffered settlement and final Idle, only for its session', () => {
    const restored = restoreChat(emptyChat(), 's1', question().payload as Record<string, unknown>, [
      resolved({ first: 'Now', second: 'Here' }),
      event('status.update', { kind: 'idle', text: 'Idle' }),
      event('approval.request', { request_id: 'other' }, 's2')
    ])
    expect(restored.state).toMatchObject({
      busy: false,
      waiting: false,
      questions: [],
      approvals: [],
      activity: 'Idle'
    })
    expect(restored.reread).toBe(false)
  })

  it('keeps settlement evidence after completion in a loading buffer without duplicating history', () => {
    const result = replayChat(reduceChat(emptyChat(), question()), [
      event('message.complete', { text: 'Done' }),
      resolved({ first: 'Now', second: 'Here' }),
      event('status.update', { kind: 'idle', text: 'Idle' }),
      question()
    ])
    expect(result.reread).toBe(true)
    expect(result.state).toMatchObject({
      busy: false,
      waiting: false,
      activity: 'Idle',
      questions: [],
      messages: []
    })
  })

  it('normalizes successful local approval results and leaves rejected results actionable', () => {
    const state = reduceChat(emptyChat(), approval())
    const pending = state.approvals[0]
    expect(approvalResponse(pending, 'always', { resolved: false })).toBeUndefined()
    expect(approvalResponse(pending, 'always', { resolved: true })?.payload).toEqual({
      request_id: 'approve',
      choice: 'session'
    })
    expect(
      approvalResponse({ ...pending, choices: ['once', 'deny'] }, 'always', { resolved: true })
        ?.payload
    ).toEqual({ request_id: 'approve', choice: 'once' })
    expect(approvalResponse(pending, 'once', { resolved: true, choice: 'deny' })?.payload).toEqual({
      request_id: 'approve',
      choice: 'deny'
    })
    expect(state.approvals).toHaveLength(1)
  })

  it('uses canonical local question maps and supports legacy partial and single-input replies', () => {
    let state = reduceChat(emptyChat(), question())
    const pending = state.questions[0]
    state = reduceChat(state, clarifyResponse(pending, 'first', 'Typed', { status: 'waiting' }))
    expect(state.questions[0].questions.map(q => q.id)).toEqual(['second'])
    state = reduceChat(
      state,
      clarifyResponse(state.questions[0], 'second', 'Guess', {
        status: 'answered',
        answers: { first: 'Typed', second: 'Canonical' }
      })
    )
    expect(state.questions).toEqual([])
    expect(Object.values(state.settlements)[0].answers).toEqual({
      first: 'Typed',
      second: 'Canonical'
    })
    let single = reduceChat(
      emptyChat(),
      event('clarify.request', { request_id: 'legacy', question: 'When?' })
    )
    single = reduceChat(
      single,
      clarifyResponse(single.questions[0], 'legacy', 'Now', { status: 'answered' })
    )
    expect(single.questions).toEqual([])
    expect(single.waiting).toBe(false)
  })
})

describe('owned waiting status', () => {
  const resumed = () =>
    reduceChat(reduceChat(emptyChat(), approval()), {
      ...event('approval.resolved', { request_id: 'approve', choice: 'once' }),
      mobileRevision: 2
    } as GatewayEvent)

  it('keeps human answer evidence through an automatic wait while newer cards and roster reads remain authoritative', () => {
    let state = resumed()
    state = reduceChat(
      state,
      event('status.update', { kind: 'waiting', text: 'Retrying the model request' })
    )
    expect(state).toMatchObject({ waiting: true, resumedWaiting: true, waitingRevision: 2 })
    expect(settledBot(waitingBot(), state, 's1').status).toBe('working')
    for (const bot of [waitingBot('s2'), waitingBot(null)])
      expect(settledBot(bot, state, 's1')).toBe(bot)
    const duplicate = reduceChat(state, {
      ...event('approval.resolved', { request_id: 'approve', choice: 'once' }),
      mobileRevision: 4
    } as GatewayEvent)
    expect(duplicate.waitingRevision).toBe(2)
    expect(settledBot(waitingBot(), rosterChat(duplicate, 3), 's1').status).toBe('needs_you')
    const withQuestion = reduceChat(state, question('new'))
    expect(withQuestion.resumedWaiting).toBe(false)
    expect(settledBot(waitingBot(), withQuestion, 's1').status).toBe('needs_you')
    const withApproval = reduceChat(state, approval('new'))
    expect(withApproval.resumedWaiting).toBe(false)
    expect(settledBot(waitingBot(), withApproval, 's1').status).toBe('needs_you')
    const nextTurn = reduceChat(state, event('message.start', {}))
    expect(settledBot(waitingBot(), nextTurn, 's1').status).toBe('needs_you')
  })

  it('supersedes only a named session whose last card was accepted, preserving later completion and new waits', () => {
    let state = resumed()
    for (const bot of [
      waitingBot('s2'),
      waitingBot(null),
      { ...waitingBot(), status: 'stopped' as const }
    ])
      expect(settledBot(bot, state, 's1')).toBe(bot)
    expect(settledBot(waitingBot(), state, 's1').status).toBe('working')
    state = reduceChat(state, event('message.complete', { text: 'Done' }))
    expect(settledBot(waitingBot(), state, 's1').status).toBe('idle')
    state = reduceChat(state, approval('new'))
    expect(settledBot(waitingBot(), state, 's1').status).toBe('needs_you')
  })

  it('retires old proof on a successful roster read but keeps answers accepted while it was loading', () => {
    const state = resumed()
    const fresh = rosterChat(state, 2)
    expect(settledBot(waitingBot(), fresh, 's1').status).toBe('needs_you')
    const answeredDuringRead = rosterChat(state, 1)
    expect(settledBot(waitingBot(), answeredDuringRead, 's1').status).toBe('working')
    const duplicate = reduceChat(state, {
      ...event('approval.resolved', { request_id: 'approve', choice: 'once' }),
      mobileRevision: 3
    } as GatewayEvent)
    expect(duplicate.waitingRevision).toBe(2)
    expect(settledBot(waitingBot(), rosterChat(duplicate, 2), 's1').status).toBe('needs_you')
  })
})
