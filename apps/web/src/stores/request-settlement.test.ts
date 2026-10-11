import type { GatewayEvent } from '@hermes/shared'

import { routeEvent } from '../lib/events'
import { setActiveRpc } from '../lib/rpc'
import type { Bot, Section } from '../lib/types'

import { useBots } from './bots'
import { botStatusWithLive, liveSectionsOf, useSections } from './sections'
import {
  clarifyWaiting,
  resetTranscriptEffects,
  setTranscriptEffects,
  useTranscripts
} from './transcripts'

const actions = () => useTranscripts.getState()
const current = () => actions().bySession.live!

const event = (type: string, payload: Record<string, unknown>, session = 'live') =>
  routeEvent({ type, payload, session_id: session } as GatewayEvent)

const approval = (requestId = 'approval') =>
  event('approval.request', {
    bot: 'owl',
    section_id: 'section',
    request_id: requestId,
    choices: ['once', 'session', 'deny']
  })

const question = (requestId = 'question') =>
  event('clarify.request', {
    bot: 'owl',
    section_id: 'section',
    request_id: requestId,
    question: 'Continue?'
  })

const resolved = (kind: 'approval' | 'clarify', requestId: string = kind) =>
  event(
    `${kind}.resolved`,
    kind === 'approval'
      ? { request_id: requestId, choice: 'session' }
      : { request_id: requestId, answers: { [requestId]: 'Yes' }, status: 'answered' }
  )

const deferred = () => {
  let resolve!: (value: unknown) => void

  const promise = new Promise(done => {
    resolve = done
  })

  return { promise, resolve }
}

let unseenId = 0

const status = () =>
  botStatusWithLive(
    useBots.getState().byName.owl!,
    Object.values(useSections.getState().byId),
    liveSectionsOf(actions().bySession),
    actions().bySession
  )

beforeEach(() => {
  actions().dropAll()
  actions().open('live', 'section', [], undefined, 'owl')
  useSections.setState({
    byId: { section: { id: 'section', bot: 'owl', archived_at: null } as Section },
    idsByBot: { owl: ['section'] },
    liveSessionId: { section: 'live' }
  })
  useBots.setState({
    byName: {
      owl: {
        name: 'owl',
        status: 'needs_you',
        status_detail: { section_id: 'section', session_id: 'live' }
      } as Bot
    },
    order: ['owl']
  })
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  setActiveRpc({ call: vi.fn().mockRejectedValue(new Error('offline')) } as never)
})

afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

it.each(['approval', 'clarify'] as const)(
  'shows Working when another client answers the only %s and the roster refresh fails',
  async kind => {
    if (kind === 'approval') {
      approval()
      event('approval.resolved', { request_id: 'approval', choice: 'session' })
    } else {
      question()
      event('clarify.resolved', {
        request_id: 'question',
        answers: { question: 'Yes' },
        status: 'answered'
      })
    }

    event('status.update', { kind: 'working', text: 'Working' })
    await useBots.getState().refresh()
    expect(current().waitingRequests).toEqual([])
    expect(status()).toBe('working')

    if (kind === 'approval') {
      expect(current().approvals[0]?.decision).toBe('session')
    } else {
      expect(current().clarifies[0]?.answers).toEqual({ question: 'Yes' })
    }
  }
)

it.each(['approval', 'clarify'] as const)(
  'settles only the answered %s while another request stays Waiting',
  kind => {
    approval('approval')
    question('clarify')
    resolved(kind)
    event('status.update', { kind: 'working', text: 'Working' })
    expect(current().waitingRequests?.map(item => item.kind)).toEqual([
      kind === 'approval' ? 'clarify' : 'approval'
    ])
    expect(status()).toBe('needs_you')
    resolved(kind === 'approval' ? 'clarify' : 'approval')
    expect(current().waitingRequests).toEqual([])
    expect(status()).toBe('working')
  }
)

it('broadcast partial batch answers keep the remaining question actionable', () => {
  event('clarify.request', {
    request_id: 'batch',
    questions: [
      { qid: 'a', question: 'First?' },
      { qid: 'b', question: 'Second?' }
    ]
  })
  event('clarify.resolved', {
    request_id: 'batch',
    answers: { a: 'First' },
    status: 'waiting',
    remaining: ['b']
  })
  expect(current().clarifies[0]?.answers).toEqual({ a: 'First' })
  expect(clarifyWaiting(current().clarifies[0]!)).toBe(true)
  expect(status()).toBe('needs_you')
  event('clarify.resolved', {
    request_id: 'batch',
    answers: { a: 'First', b: 'Second' },
    status: 'answered'
  })
  expect(current().clarifies[0]?.answers).toEqual({ a: 'First', b: 'Second' })
  expect(current().settledClarifyIds).toContain('batch')
  expect(status()).toBe('working')
})

it('duplicate question IDs share one answer; unrelated keys cannot complete a card', () => {
  event('clarify.request', {
    request_id: 'batch',
    questions: [
      { qid: 'a', question: 'First?' },
      { qid: 'a', question: 'Also first?' }
    ]
  })
  event('clarify.resolved', {
    request_id: 'batch',
    answers: { unrelated: 'No' },
    status: 'answered'
  })
  expect(current().settledClarifyIds ?? []).not.toContain('batch')
  expect(status()).toBe('needs_you')
  event('clarify.resolved', {
    request_id: 'batch',
    answers: { a: 'Yes' },
    status: 'answered'
  })
  expect(current().waitingRequests).toEqual([])
  expect(status()).toBe('working')
})

it.each(['approval', 'clarify'] as const)(
  'duplicate %s settlement and request replay preserve later authority',
  kind => {
    if (kind === 'approval') {
      approval()
    } else {
      question('clarify')
    }

    resolved(kind)
    event('status.update', { kind: 'idle', text: '' })
    const revision = current().authorityRevision
    resolved(kind)

    if (kind === 'approval') {
      approval()
    } else {
      question('clarify')
    }

    expect(current().authorityRevision).toBe(revision)
    expect(current().waitingRequests).toEqual([])
    expect(current().liveStatus).toBe('idle')
    expect(status()).toBe('idle')
  }
)

it.each(['approval', 'clarify'] as const)(
  'an unknown %s request cannot settle another card or alter its authority',
  kind => {
    approval('sibling')
    const revision = current().authorityRevision
    resolved(kind, 'unknown')
    expect(current().authorityRevision).toBe(revision)
    expect(current().waitingRequests?.map(item => item.requestId)).toEqual(['sibling'])
    expect(status()).toBe('needs_you')
  }
)

describe.each(['approval', 'clarify'] as const)(
  '%s settlement with a later lifecycle boundary',
  kind => {
    it.each(['idle', 'complete', 'error'] as const)(
      'does not revive answer activity after %s',
      boundary => {
        if (kind === 'approval') {
          approval()
        } else {
          question('clarify')
        }

        if (boundary === 'complete') {
          event('message.complete', { text: 'Done' })
        } else if (boundary === 'error') {
          event('error', { message: 'Failed' })
        } else {
          event('status.update', { kind: 'idle', text: '' })
        }

        const revision = current().authorityRevision
        const liveStatus = current().liveStatus
        resolved(kind)
        expect(current().authorityRevision).toBe(revision)
        expect(current().liveStatus).toBe(liveStatus)
        expect(current().answeredWaiting).toBeUndefined()
        expect(current().waitingRequests).toEqual([])
      }
    )

    it('preserves a newer sibling question', () => {
      if (kind === 'approval') {
        approval()
      } else {
        question('clarify')
      }

      question('new-sibling')
      resolved(kind)
      expect(current().waitingRequests?.map(item => item.requestId)).toEqual(['new-sibling'])
      expect(status()).toBe('needs_you')
    })

    it.each(['drop', 'dropAll'] as const)('cannot recreate a transcript after %s', method => {
      if (kind === 'approval') {
        approval()
      } else {
        question('clarify')
      }

      if (method === 'drop') {
        actions().drop('live')
      } else {
        actions().dropAll()
      }

      resolved(kind)
      expect(actions().bySession.live).toBeUndefined()
    })

    it('cannot make an old request active in a same-ID reopened epoch', () => {
      if (kind === 'approval') {
        approval()
      } else {
        question('clarify')
      }

      const epoch = current().epoch
      actions().drop('live')
      actions().open('live', 'section', [], undefined, 'owl')
      event('status.update', { kind: 'idle', text: '' })
      approval('replacement')
      const revision = current().authorityRevision
      resolved(kind)
      expect(current().epoch).not.toBe(epoch)
      expect(current().authorityRevision).toBe(revision)
      expect(current().liveStatus).toBe('idle')
      expect(current().answeredWaiting).toBeUndefined()
      expect(current().waitingRequests?.map(item => item.requestId)).toEqual(['replacement'])
    })

    it('a new request can establish a fresh epoch after a drop', () => {
      const epoch = current().epoch
      actions().drop('live')

      if (kind === 'approval') {
        approval('replacement')
      } else {
        question('replacement')
      }

      expect(current().epoch).not.toBe(epoch)
      resolved(kind, 'old-request')
      expect(current().waitingRequests?.map(item => item.requestId)).toEqual(['replacement'])
      resolved(kind, 'replacement')
      expect(current().waitingRequests).toEqual([])
      expect(status()).toBe('working')
    })
  }
)

it.each(['open', 'openThread'] as const)(
  'a cold answer event prevents an old %s snapshot from restoring its question',
  async method => {
    const live = `cold-${++unseenId}`
    const opening = deferred()
    setActiveRpc({ call: vi.fn().mockReturnValue(opening.promise) } as never)

    const loading =
      method === 'open'
        ? useSections.getState().open('section')
        : useSections.getState().openThread('section', 'fox')

    event(
      'clarify.resolved',
      {
        request_id: 'cold-q',
        answers: { 'cold-q': 'Yes' },
        status: 'answered'
      },
      live
    )
    opening.resolve({
      section: { id: 'section', bot: 'owl', live_session_id: live },
      messages: [],
      pending_clarify: { request_id: 'cold-q', question: 'Continue?' }
    })
    await loading
    expect(actions().bySession[live]?.settledClarifyIds).toContain('cold-q')
    expect(actions().bySession[live]?.waitingRequests).toEqual([])
    expect(actions().bySession[live]?.clarifies).toEqual([])
  }
)

it('partial settlement before card delivery preserves canonical answers through a snapshot', () => {
  const live = `cold-${++unseenId}`
  event(
    'clarify.resolved',
    {
      request_id: 'batch',
      answers: { a: 'Canonical' },
      status: 'waiting'
    },
    live
  )
  actions().open(live, 'section', [], undefined, 'owl')
  event(
    'clarify.request',
    {
      request_id: 'batch',
      questions: [
        { qid: 'a', question: 'First?' },
        { qid: 'b', question: 'Second?' }
      ]
    },
    live
  )
  const card = actions().bySession[live]!.clarifies[0]!
  expect(card.answers).toEqual({ a: 'Canonical' })
  expect(clarifyWaiting(card)).toBe(true)
  expect(actions().bySession[live]!.waitingRequests?.map(item => item.requestId)).toEqual(['batch'])
})

it('approval settlement before replay creates a decided card without fresh Waiting or notification', () => {
  const live = `cold-${++unseenId}`
  event('approval.resolved', { request_id: 'cold-a', choice: 'deny' }, live)
  actions().open(live, 'section', [], undefined, 'owl')
  const notify = vi.fn()
  setTranscriptEffects({ ackApproval: vi.fn(), notify, touchSection: vi.fn() })
  event('approval.request', { request_id: 'cold-a' }, live)
  expect(actions().bySession[live]!.approvals[0]?.decision).toBe('deny')
  expect(actions().bySession[live]!.waitingRequests).toEqual([])
  expect(notify).not.toHaveBeenCalled()
})

describe.each(['approval', 'clarify'] as const)('local %s RPC settlement', kind => {
  it.each([false, true])('uses canonical values (event first=%s)', async eventFirst => {
    const response = deferred()
    setActiveRpc({ call: vi.fn().mockReturnValue(response.promise) } as never)

    if (kind === 'approval') {
      approval()
    } else {
      question('clarify')
    }

    const answering =
      kind === 'approval'
        ? actions().respondApproval('live', 'approval', 'always')
        : actions().respondClarify('live', 'clarify', 'Local')

    const settle = () =>
      event(
        `${kind}.resolved`,
        kind === 'approval'
          ? { request_id: 'approval', choice: 'session' }
          : { request_id: 'clarify', answers: { clarify: 'Canonical' }, status: 'answered' }
      )

    if (eventFirst) {
      settle()
    }

    response.resolve(
      kind === 'approval'
        ? { resolved: true, choice: 'session' }
        : { status: 'answered', answers: { clarify: 'Canonical' } }
    )
    await answering

    if (!eventFirst) {
      settle()
    }

    expect(current().approvals[0]?.decision ?? current().clarifies[0]?.answers.clarify).toBe(
      kind === 'approval' ? 'session' : 'Canonical'
    )
    expect(current().waitingRequests).toEqual([])
    expect(status()).toBe('working')
  })

  it.each(['idle', 'drop', 'reopen'] as const)(
    'a late successful RPC respects the %s boundary',
    async boundary => {
      const response = deferred()
      setActiveRpc({ call: vi.fn().mockReturnValue(response.promise) } as never)

      if (kind === 'approval') {
        approval()
      } else {
        question('clarify')
      }

      const answering =
        kind === 'approval'
          ? actions().respondApproval('live', 'approval', 'once')
          : actions().respondClarify('live', 'clarify', 'Local')

      if (boundary === 'idle') {
        event('status.update', { kind: 'idle', text: '' })
      } else {
        actions().drop('live')

        if (boundary === 'reopen') {
          actions().open('live', 'section', [], undefined, 'owl')

          if (kind === 'approval') {
            approval()
          } else {
            question('clarify')
          }
        }
      }

      const before = actions().bySession.live
      response.resolve(
        kind === 'approval'
          ? { resolved: true, choice: 'once' }
          : { status: 'answered', answers: { clarify: 'Canonical' } }
      )
      await answering
      expect(actions().bySession.live?.epoch).toBe(before?.epoch)
      expect(actions().bySession.live?.answeredWaiting).toBeUndefined()

      if (boundary === 'drop') {
        expect(actions().bySession.live).toBeUndefined()
      }

      if (boundary === 'reopen') {
        expect(current().approvals[0]?.decision).toBeUndefined()
        expect(current().clarifies[0]?.answers ?? {}).toEqual({})
      }
    }
  )
})

it('a full canonical RPC includes another client’s earlier batch answer', async () => {
  event('clarify.request', {
    request_id: 'batch',
    questions: [
      { qid: 'a', question: 'First?' },
      { qid: 'b', question: 'Second?' }
    ]
  })
  setActiveRpc({
    call: vi.fn().mockResolvedValue({ status: 'answered', answers: { a: 'Peer', b: 'Local' } })
  } as never)
  await actions().respondClarify('live', 'batch', 'Local', 'b')
  expect(current().clarifies[0]?.answers).toEqual({ a: 'Peer', b: 'Local' })
  expect(current().waitingRequests).toEqual([])
  expect(status()).toBe('working')
})

it('a legacy local reply cannot overwrite previously broadcast canonical answers', async () => {
  question('clarify')
  const response = deferred()
  setActiveRpc({ call: vi.fn().mockReturnValue(response.promise) } as never)
  const answering = actions().respondClarify('live', 'clarify', 'Stale')
  resolved('clarify')
  response.resolve({ status: 'answered' })
  await answering
  expect(current().clarifies[0]?.answers).toEqual({ clarify: 'Yes' })
})

it('a legacy reply answers a question ID that is also an Object property', async () => {
  event('clarify.request', {
    request_id: 'batch',
    questions: [
      { qid: 'a', question: 'First?' },
      { qid: 'toString', question: 'Second?' }
    ]
  })
  event('clarify.resolved', { request_id: 'batch', answers: { a: 'Peer' }, status: 'waiting' })
  setActiveRpc({ call: vi.fn().mockResolvedValue({ status: 'answered' }) } as never)
  await actions().respondClarify('live', 'batch', 'Local', 'toString')
  expect(current().clarifies[0]?.answers).toEqual({ a: 'Peer', toString: 'Local' })
})

it('room ownership survives stored section IDs on request payloads', () => {
  actions().open('room-live', 'room:r', [], undefined, 'owl')
  event(
    'approval.request',
    {
      bot: 'owl',
      section_id: 'stored-room',
      request_id: 'room-a'
    },
    'room-live'
  )
  expect(actions().bySession['room-live']?.sectionId).toBe('room:r')
  expect(actions().bySession['room-live']?.bot).toBe('owl')
  approval('private-a')
  event('approval.resolved', { request_id: 'room-a', choice: 'once' }, 'room-live')
  expect(current().waitingRequests?.map(item => item.requestId)).toEqual(['private-a'])
})

it.each([
  ['approval.resolved', { request_id: '', choice: 'once' }],
  ['approval.resolved', { request_id: 'approval', choice: 'always' }],
  ['clarify.resolved', { request_id: 'question', answers: null, status: 'answered' }],
  ['clarify.resolved', { request_id: 'question', answers: [], status: 'answered' }],
  ['clarify.resolved', { request_id: 'question', answers: { question: true }, status: 'answered' }],
  ['clarify.resolved', { request_id: 'question', answers: {}, status: 'unknown' }]
])('ignores malformed %s settlement payloads', (type, payload) => {
  approval()
  question()
  const revision = current().authorityRevision
  event(type as string, payload as Record<string, unknown>)
  expect(current().authorityRevision).toBe(revision)
  expect(current().waitingRequests).toHaveLength(2)
})
