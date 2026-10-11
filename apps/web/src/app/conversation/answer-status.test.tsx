import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { setActiveRpc } from '../../lib/rpc'
import type { Bot, Section } from '../../lib/types'
import { useBots } from '../../stores/bots'
import {
  botStatusWithLive,
  liveSectionsOf,
  sectionStatusOf,
  useSections
} from '../../stores/sections'
import {
  resetTranscriptEffects,
  setTranscriptEffects,
  useTranscripts
} from '../../stores/transcripts'

import { ClarifyCard } from './clarify-card'

import { ApprovalCard } from './index'

type Kind = 'approval' | 'clarify'

const deferred = () => {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void

  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

const bot = (name = 'owl', status: Bot['status'] = 'needs_you') =>
  ({ name, status, status_detail: { section_id: name === 'owl' ? 's1' : 's2' } }) as Bot

const section = { id: 's1', bot: 'owl', archived_at: null } as Section
const actions = () => useTranscripts.getState()
const transcript = () => actions().bySession.live!

function ask(kind: Kind, requestId = 'answer') {
  if (kind === 'approval') {
    actions().approvalRequest('live', { request_id: requestId, choices: ['once'] })
  } else {
    actions().clarifyRequest('live', {
      request_id: requestId,
      question: 'Continue?',
      choices: ['Yes']
    })
  }
}

function send(kind: Kind) {
  return kind === 'approval'
    ? actions().respondApproval('live', 'answer', 'once')
    : actions().respondClarify('live', 'answer', 'Yes')
}

function result(kind: Kind) {
  return kind === 'approval' ? { resolved: true } : { status: 'answered' }
}

function expectSettled(kind: Kind) {
  if (kind === 'approval') {
    expect(transcript().approvals[0]?.decision).toBe('once')
  } else {
    expect(transcript().clarifies[0]?.answers).toEqual({ answer: 'Yes' })
  }
}

function clickAnswer(kind: Kind) {
  if (kind === 'approval') {
    render(<ApprovalCard approval={transcript().approvals[0]!} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  } else {
    render(<ClarifyCard clarify={transcript().clarifies[0]!} />)
    fireEvent.click(screen.getByRole('option', { name: /Yes/ }))
  }
}

function expectStatus(status: Bot['status']) {
  const live = liveSectionsOf(actions().bySession)
  expect(sectionStatusOf(useBots.getState().byName.owl, 's1', live)).toBe(status)
  expect(botStatusWithLive(useBots.getState().byName.owl!, [section], live)).toBe(status)
}

beforeEach(() => {
  actions().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  actions().open('live', 's1', [])
  useSections.setState({ byId: { s1: section }, idsByBot: { owl: ['s1'], cat: ['s2'] } })
  useBots.setState({ byName: { owl: bot(), cat: bot('cat') }, order: ['owl', 'cat'] })
})

afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

describe.each<Kind>(['approval', 'clarify'])('%s answer lifecycle', kind => {
  it.each(['complete', 'status', 'roster', 'reconnect', 'new turn', 'new card', 'snapshot'])(
    'does not revive Working when %s arrives before the actual card RPC reply',
    async boundary => {
      const response = deferred()

      const call = vi.fn((method: string) =>
        method === 'hexbot.bots.list'
          ? Promise.resolve({ bots: [bot('owl', 'idle')] })
          : response.promise
      )

      setActiveRpc({ call } as never)
      ask(kind)

      clickAnswer(kind)

      expect(call).toHaveBeenCalledWith(
        `${kind}.respond`,
        expect.objectContaining({ request_id: 'answer', session_id: 'live' })
      )

      await act(async () => {
        if (boundary === 'complete') {
          actions().messageComplete('live', { text: 'Done.' })
        } else if (boundary === 'status') {
          actions().statusUpdate('live', { kind: 'idle', text: 'Done.' })
        } else if (boundary === 'roster') {
          await useBots.getState().refresh()
        } else if (boundary === 'reconnect') {
          actions().clearAnsweredWaiting()
        } else if (boundary === 'new turn') {
          actions().messageStart('live')
        } else if (boundary === 'new card') {
          ask(kind, 'next')
        } else {
          actions().open('live', 's1', [])
        }

        response.resolve(result(kind))
      })
      await waitFor(() => expectSettled(kind))
      expect(transcript().answeredWaiting).toBeUndefined()
      expectStatus(['complete', 'status', 'roster'].includes(boundary) ? 'idle' : 'needs_you')
    }
  )

  it('keeps optimistic Working after a successful current answer', async () => {
    setActiveRpc({ call: vi.fn(async () => result(kind)) } as never)
    ask(kind)
    await send(kind)
    expectSettled(kind)
    expectStatus('working')
  })

  it.each([true, false])(
    'keeps fresh Working through a failed roster and no-stream gap (status first=%s)',
    async statusFirst => {
      const response = deferred()
      setActiveRpc({
        call: vi.fn((method: string) =>
          method === 'hexbot.bots.list' ? Promise.reject(new Error('offline')) : response.promise
        )
      } as never)
      ask(kind)
      clickAnswer(kind)

      const resumed = async () => {
        await act(async () => actions().statusUpdate('live', { kind: 'working', text: 'Working' }))
      }

      const answered = async () => {
        await act(async () => response.resolve(result(kind)))
        await waitFor(() => expectSettled(kind))
      }

      if (statusFirst) {
        await resumed()
        await answered()
      } else {
        await answered()
        await resumed()
      }

      await act(async () => {
        await useBots.getState().refresh()
        actions().statusUpdate('live', { kind: 'status', text: 'Still processing the answer' })
        actions().statusUpdate('live', { kind: 'waiting', text: 'Retrying the model request' })
      })
      expect(useBots.getState().byName.owl?.status).toBe('needs_you')
      expect(transcript().answeredWaiting).toBeUndefined()
      expect(transcript().liveStatus).toBe('working')
      expect(transcript().streamingMessageId).toBeNull()
      vi.useFakeTimers()

      try {
        await act(async () => vi.advanceTimersByTimeAsync(120_000))
        expectStatus('working')
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each(['needs_you', 'working'] as const)(
    'fresh completion and idle supersede a stale %s roster',
    async stale => {
      setActiveRpc({
        call: vi.fn(async (method: string) => {
          if (method === 'hexbot.bots.list') {
            throw new Error('offline')
          }

          return result(kind)
        })
      } as never)
      ask(kind)
      clickAnswer(kind)
      await waitFor(() => expectSettled(kind))
      useBots.setState({ byName: { owl: bot('owl', stale) } })
      await act(async () => {
        actions().statusUpdate('live', { kind: 'working', text: 'Working' })
        actions().messageComplete('live', { text: 'Done.', status: 'complete' })
        await useBots.getState().refresh()
      })
      expectStatus('idle')
      await act(async () => actions().statusUpdate('live', { kind: 'idle', text: '' }))
      expectStatus('idle')
      expect(transcript().answeredWaiting).toBeUndefined()
      expect(transcript().liveStatus).toBe('idle')
    }
  )

  it.each(['new card', 'new turn', 'reconnect', 'snapshot', 'roster', 'other status'])(
    'retires fresh Working on %s before a late answer reply',
    async boundary => {
      const response = deferred()
      setActiveRpc({
        call: vi.fn((method: string) =>
          method === 'hexbot.bots.list' ? Promise.resolve({ bots: [bot()] }) : response.promise
        )
      } as never)
      ask(kind)
      const answering = send(kind)
      actions().statusUpdate('live', { kind: 'working', text: 'Working' })

      if (boundary === 'new card') {
        ask(kind, 'next')
      } else if (boundary === 'new turn') {
        actions().messageStart('live')
      } else if (boundary === 'reconnect') {
        actions().clearAnsweredWaiting()
      } else if (boundary === 'snapshot') {
        actions().open('live', 's1', [])
      } else if (boundary === 'roster') {
        await useBots.getState().refresh()
      } else {
        actions().statusUpdate('live', { kind: 'error', text: 'Stopped' })
      }

      response.resolve(result(kind))
      await answering
      expectSettled(kind)
      expect(transcript().answeredWaiting).toBeUndefined()
      expect(transcript().liveStatus).toBe(boundary === 'new card' ? 'needs_you' : undefined)
      expectStatus('needs_you')
    }
  )

  it.each(['owl', 'cat'])('a scoped %s roster retires only its own fresh Working', async name => {
    setActiveRpc({
      call: vi.fn(async (method: string) =>
        method === 'hexbot.bots.get' ? { bot: bot(name) } : result(kind)
      )
    } as never)
    ask(kind)
    await send(kind)
    actions().statusUpdate('live', { kind: 'working', text: 'Working' })
    await useBots.getState().refreshOne(name)
    expectStatus(name === 'owl' ? 'needs_you' : 'working')
    expect(transcript().liveStatus).toBe(name === 'owl' ? undefined : 'working')
  })

  it('cannot settle a replacement card after dropping and reopening the same live id', async () => {
    const response = deferred()
    setActiveRpc({ call: vi.fn(() => response.promise) } as never)
    ask(kind)
    const epoch = transcript().epoch
    const answering = send(kind)
    actions().drop('live')
    actions().open('live', 's1', [])
    ask(kind)
    expect(transcript().epoch).not.toBe(epoch)
    response.resolve(result(kind))
    await answering
    expect(transcript().answeredWaiting).toBeUndefined()

    if (kind === 'approval') {
      expect(transcript().approvals[0]?.decision).toBeUndefined()
    } else {
      expect(transcript().clarifies[0]?.answers).toEqual({})
    }

    expectStatus('needs_you')
  })

  it('leaves a failed answer pending and allows a fresh successful retry', async () => {
    const first = deferred()
    const second = deferred()
    setActiveRpc({
      call: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    } as never)
    ask(kind)
    const failing = send(kind)
    const rejected = expect(failing).rejects.toThrow('offline')
    first.reject(new Error('offline'))
    await rejected
    expect(transcript().answeredWaiting).toBeUndefined()
    expectStatus('needs_you')
    actions().statusUpdate('live', { kind: 'waiting', text: 'Try again.' })
    const retrying = send(kind)
    second.resolve(result(kind))
    await retrying
    expectSettled(kind)
    expectStatus('working')
  })

  it.each(['owl', 'cat'])(
    'a scoped %s roster invalidates only its own in-flight answers',
    async name => {
      const response = deferred()
      setActiveRpc({
        call: vi.fn((method: string) =>
          method === 'hexbot.bots.get' ? Promise.resolve({ bot: bot(name) }) : response.promise
        )
      } as never)
      ask(kind)
      const answering = send(kind)
      await useBots.getState().refreshOne(name)
      response.resolve(result(kind))
      await answering
      expectSettled(kind)
      expectStatus(name === 'owl' ? 'needs_you' : 'working')
    }
  )

  it.each(['room:r', 'thread'])(
    'preserves authoritative waiting outside the private roster (%s)',
    async sectionId => {
      const response = deferred()
      setActiveRpc({ call: vi.fn(() => response.promise) } as never)
      actions().open('live', sectionId, [])
      ask(kind)
      const answering = send(kind)
      actions().clearAnsweredWaiting()

      const owner = {
        ...bot(),
        status_detail: {
          action: null,
          room_id: sectionId === 'thread' ? null : 'r',
          section_id: sectionId === 'thread' ? sectionId : null,
          session_id: 'live',
          since: 0,
          text: 'Waiting'
        }
      } as Bot

      response.resolve(result(kind))
      await answering
      expectSettled(kind)
      expect(transcript().answeredWaiting).toBeUndefined()
      expect(botStatusWithLive(owner, [section], liveSectionsOf(actions().bySession))).toBe(
        'needs_you'
      )
    }
  )
})

it('records a partial clarification answer without claiming the bot resumed', async () => {
  setActiveRpc({ call: vi.fn(async () => ({ status: 'waiting', remaining: ['q2'] })) } as never)
  actions().clarifyRequest('live', {
    request_id: 'answer',
    questions: [
      { qid: 'q1', question: 'First?', choices: ['Yes'] },
      { qid: 'q2', question: 'Second?', choices: ['Yes'] }
    ]
  })
  await actions().respondClarify('live', 'answer', 'Yes', 'q1')
  expect(transcript().clarifies[0]?.answers).toEqual({ q1: 'Yes' })
  expect(transcript().answeredWaiting).toBeUndefined()
  expectStatus('needs_you')
})
